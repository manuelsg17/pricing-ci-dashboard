-- ════════════════════════════════════════════════════════════════════════
-- simulate-upload-aeropuerto.sql — mig 209. Supabase LOCAL, nunca producción.
--
--   docker exec -i supabase_db_pricing-ci-dashboard psql -U postgres -X \
--     < scripts/simulate-upload-aeropuerto.sql
--
-- LA PREGUNTA: re-subir el mismo Excel de aeropuerto, ¿reemplaza o acumula?
-- El trigger de ruteo reescribe city='Lima' → 'Lima_Airport_A' según la zona, y
-- el borrado miraba la ciudad de ANTES del trigger.
--
-- Corre como `authenticated` con JWT simulado. Transacción revertida.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

\set ON_ERROR_STOP on
\pset pager off

CREATE OR REPLACE FUNCTION pg_temp.esperar(p_caso text, p_obtenido text, p_esperado text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_obtenido IS DISTINCT FROM p_esperado THEN
    RAISE EXCEPTION E'\n  ✗ FALLA: %\n    esperado=% obtenido=%', p_caso, p_esperado, p_obtenido;
  END IF;
  RAISE NOTICE '  ok  % → %', p_caso, p_obtenido;
END $$;

-- Sube un "Excel": filas con city='Lima' y la zona que el trigger usa para
-- rutear. `p_zona` NULL = hoja de Lima base.
CREATE OR REPLACE FUNCTION pg_temp.subir(p_email text, p_zona text, p_n int DEFAULT 3)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_res jsonb; v_batch uuid := gen_random_uuid(); v_rows jsonb;
BEGIN
  SELECT jsonb_agg(jsonb_build_object(
    'city','Lima', 'zone', p_zona, 'observed_date','2026-08-20',
    'observed_time', lpad(g::text,2,'0')||':00', 'category','Economy/Comfort',
    'timeslot','Mañana', 'competition_name','Uber', 'distance_bracket','short',
    'price_without_discount', 10 + g, 'upload_batch_id', v_batch))
  INTO v_rows FROM generate_series(1, p_n) g;

  EXECUTE format('SET LOCAL request.jwt.claims TO %L',
                 json_build_object('email', p_email, 'role', 'authenticated')::text);
  SET LOCAL ROLE authenticated;
  BEGIN
    v_res := upload_pricing_batch('Peru','Lima','2026-08-20','2026-08-20', v_rows);
    RESET ROLE;
    RETURN v_res;
  EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    RETURN jsonb_build_object('error', SQLSTATE);
  END;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.filas(p_city text)
RETURNS int LANGUAGE sql AS $$
  SELECT count(*)::int FROM pricing_observations
  WHERE country='Peru' AND city=p_city AND observed_date='2026-08-20'
    AND data_source='manual';
$$;

INSERT INTO roles (name, label, permissions) VALUES
  ('qa209_upload', 'QA upload', '{"sections": ["upload"], "countries": ["Peru"]}'),
  ('qa209_sin',    'QA sin',    '{"sections": ["dashboard"], "countries": ["Peru"]}');
INSERT INTO user_profiles (email, role_id, is_active) VALUES
  ('qa209.up@local.test',  (SELECT id FROM roles WHERE name='qa209_upload'), true),
  ('qa209.sin@local.test', (SELECT id FROM roles WHERE name='qa209_sin'), true);

-- ── 1 · El trigger rutea, y el borrado tiene que seguirlo ────────────
DO $$
DECLARE v1 jsonb; v2 jsonb;
BEGIN
  RAISE NOTICE E'\n── 1 · Hoja de aeropuerto, subida dos veces ────────────';
  v1 := pg_temp.subir('qa209.up@local.test', 'Airport_A', 3);
  PERFORM pg_temp.esperar('primera subida inserta 3', v1->>'inserted', '3');
  PERFORM pg_temp.esperar('el trigger las mandó a Lima_Airport_A',
                          pg_temp.filas('Lima_Airport_A')::text, '3');
  PERFORM pg_temp.esperar('y ninguna quedó en Lima base',
                          pg_temp.filas('Lima')::text, '0');

  -- Acá estaba el bug: el DELETE miraba city='Lima', que a esta altura no tiene
  -- ninguna fila, así que borraba 0 y las 3 nuevas se sumaban a las 3 viejas.
  v2 := pg_temp.subir('qa209.up@local.test', 'Airport_A', 3);
  PERFORM pg_temp.esperar('la segunda subida BORRA las 3 anteriores', v2->>'deleted', '3');
  PERFORM pg_temp.esperar('siguen siendo 3, no 6',
                          pg_temp.filas('Lima_Airport_A')::text, '3');
END $$;

-- ── 2 · Hoja de Lima base: el camino de siempre no se rompe ─────────
DO $$
DECLARE v1 jsonb; v2 jsonb;
BEGIN
  RAISE NOTICE E'\n── 2 · Hoja de Lima base ───────────────────────────────';
  v1 := pg_temp.subir('qa209.up@local.test', NULL, 4);
  PERFORM pg_temp.esperar('inserta 4 en Lima', pg_temp.filas('Lima')::text, '4');
  v2 := pg_temp.subir('qa209.up@local.test', NULL, 4);
  PERFORM pg_temp.esperar('re-subir reemplaza', v2->>'deleted', '4');
  PERFORM pg_temp.esperar('siguen 4', pg_temp.filas('Lima')::text, '4');
  -- Y el alcance nuevo: subir Lima base NO se lleva puesto el aeropuerto.
  PERFORM pg_temp.esperar('el aeropuerto sobrevive a un upload de Lima base',
                          pg_temp.filas('Lima_Airport_A')::text, '3');
END $$;

-- ── 3 · El trabajo del hub no se toca (mig 139) ─────────────────────
DO $$
DECLARE v jsonb;
BEGIN
  RAISE NOTICE E'\n── 3 · Lo que cargó un hub ─────────────────────────────';
  INSERT INTO pricing_observations
   (country,city,observed_date,observed_time,category,timeslot,competition_name,
    distance_bracket,price_without_discount,data_source,uploaded_by,zone)
  VALUES ('Peru','Lima','2026-08-20','23:00','Economy/Comfort','Noche','Uber',
          'short',77,'manual','hub209@local.test','');
  v := pg_temp.subir('qa209.up@local.test', NULL, 4);
  PERFORM pg_temp.esperar('la fila del hub sigue ahí',
    (SELECT count(*)::text FROM pricing_observations
      WHERE observed_date='2026-08-20' AND uploaded_by='hub209@local.test'), '1');
END $$;

-- ── 4 · Guards ──────────────────────────────────────────────────────
DO $$
DECLARE v jsonb;
BEGIN
  RAISE NOTICE E'\n── 4 · Guards ──────────────────────────────────────────';
  PERFORM pg_temp.esperar('rol sin la sección upload',
                          pg_temp.subir('qa209.sin@local.test', NULL, 2)->>'error', '42501');

  SET LOCAL request.jwt.claims TO '{"email":"qa209.up@local.test","role":"authenticated"}';
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM upload_pricing_batch('Peru','Lima','2026-08-20','2026-08-20','[]'::jsonb);
    v := jsonb_build_object('error','ninguno');
  EXCEPTION WHEN OTHERS THEN v := jsonb_build_object('error', SQLSTATE);
  END;
  RESET ROLE;
  -- 22023 = invalid_parameter_value. Un lote vacío no puede borrar nada.
  PERFORM pg_temp.esperar('lote vacío', v->>'error', '22023');

  -- Dos batches mezclados en la misma llamada.
  SET LOCAL request.jwt.claims TO '{"email":"qa209.up@local.test","role":"authenticated"}';
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM upload_pricing_batch('Peru','Lima','2026-08-20','2026-08-20',
      jsonb_build_array(
        jsonb_build_object('city','Lima','observed_date','2026-08-20','category','Economy/Comfort',
          'competition_name','Uber','distance_bracket','short','upload_batch_id', gen_random_uuid()),
        jsonb_build_object('city','Lima','observed_date','2026-08-20','category','Economy/Comfort',
          'competition_name','Didi','distance_bracket','short','upload_batch_id', gen_random_uuid())));
    v := jsonb_build_object('error','ninguno');
  EXCEPTION WHEN OTHERS THEN v := jsonb_build_object('error', SQLSTATE);
  END;
  RESET ROLE;
  PERFORM pg_temp.esperar('dos upload_batch_id en el mismo lote', v->>'error', '22023');
END $$;

ROLLBACK;
