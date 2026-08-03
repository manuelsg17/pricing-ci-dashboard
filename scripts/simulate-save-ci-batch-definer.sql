-- ════════════════════════════════════════════════════════════════════════
-- simulate-save-ci-batch-definer.sql — mig 208. Supabase LOCAL, nunca producción.
--
--   docker exec -i supabase_db_pricing-ci-dashboard psql -U postgres -X \
--     < scripts/simulate-save-ci-batch-definer.sql
--
-- DOS PREGUNTAS, y las dos importan igual:
--   1. ¿Volvió a funcionar el reclamo de filas legacy que la mig 203 rompió?
--   2. Pasar la RPC a SECURITY DEFINER apaga RLS para ella. ¿Están cubiertos a
--      mano los tres controles que las políticas dejaron de aplicar —identidad,
--      dueño de lo insertado, y país/alcance de las filas— o el fix es peor que
--      el bug?
--
-- TODO CORRE COMO `authenticated` CON JWT SIMULADO. Como postgres esto no
-- probaría nada: DEFINER + superusuario pasa por arriba de todo.
--
-- Transacción revertida. No toca auth.users (CLAUDE.md §2).
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

-- Guarda una ruta como el usuario dado. Devuelve 'deleted=N inserted=M',
-- 'denegado', o el SQLSTATE si falló por otra cosa (distinguirlos evita que el
-- test pase por el motivo equivocado).
CREATE OR REPLACE FUNCTION pg_temp.guardar(
  p_email text, p_como text, p_country text, p_city text, p_date date, p_zone text,
  p_row_country text DEFAULT NULL, p_row_city text DEFAULT NULL, p_precio numeric DEFAULT 36
)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_res jsonb;
BEGIN
  EXECUTE format('SET LOCAL request.jwt.claims TO %L',
                 json_build_object('email', p_email, 'role', 'authenticated')::text);
  SET LOCAL ROLE authenticated;
  BEGIN
    v_res := save_ci_batch(
      p_country, p_city, p_date, p_zone, p_como,
      jsonb_build_array(jsonb_build_object(
        'category','Economy/Comfort','timeslot','Mañana','bracket','short',
        'point_a','A','point_b','B','competitors', jsonb_build_array('Didi'))),
      jsonb_build_array(jsonb_build_object(
        -- A propósito: la fila puede traer un país/ciudad DISTINTO al de los
        -- parámetros. Con DEFINER, si el INSERT los tomara de acá, sería la vía
        -- para escribir en un país ajeno.
        'country', coalesce(p_row_country, p_country),
        'city',    coalesce(p_row_city, p_city),
        'zone', p_zone, 'observed_date', p_date, 'observed_time','10:30',
        'category','Economy/Comfort','timeslot','Mañana','competition_name','Didi',
        'distance_bracket','short','point_a','A','point_b','B',
        'price_without_discount', p_precio, 'data_source','manual',
        'uploaded_by', p_como)));
    RESET ROLE;
    RETURN format('deleted=%s inserted=%s', v_res->>'deleted', v_res->>'inserted');
  EXCEPTION
    WHEN insufficient_privilege THEN RESET ROLE; RETURN 'denegado';
    WHEN OTHERS THEN RESET ROLE; RETURN SQLSTATE;
  END;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.filas(p_country text, p_city text, p_date date)
RETURNS int LANGUAGE sql AS $$
  SELECT count(*)::int FROM pricing_observations
  WHERE country=p_country AND city=p_city AND observed_date=p_date
    AND category='Economy/Comfort' AND timeslot='Mañana' AND competition_name='Didi'
    AND distance_bracket='short' AND point_a='A' AND point_b='B';
$$;

-- ── Elenco ────────────────────────────────────────────────────────────
INSERT INTO roles (name, label, permissions) VALUES
  ('qa208_hub',      'QA hub',      '{"sections": ["dataentry"], "countries": ["Peru"]}'),
  ('qa208_otro_hub', 'QA otro hub', '{"sections": ["dataentry"], "countries": ["Peru"]}'),
  ('qa208_sin_ci',   'QA sin CI',   '{"sections": ["dashboard"], "countries": ["Peru"]}');

INSERT INTO user_profiles (email, role_id, is_active) VALUES
  ('qa208.hub@local.test',   (SELECT id FROM roles WHERE name='qa208_hub'), true),
  ('qa208.otro@local.test',  (SELECT id FROM roles WHERE name='qa208_otro_hub'), true),
  ('qa208.sinci@local.test', (SELECT id FROM roles WHERE name='qa208_sin_ci'), true);

-- ── 1 · El bug de la 203: reclamar la fila legacy ─────────────────────
INSERT INTO pricing_observations
 (country,city,zone,observed_date,observed_time,category,timeslot,competition_name,
  distance_bracket,point_a,point_b,price_without_discount,data_source,uploaded_by)
VALUES ('Peru','Lima','', '2026-08-11','09:00','Economy/Comfort','Mañana','Didi',
        'short','A','B',20,'manual',NULL);

DO $$
BEGIN
  RAISE NOTICE E'\n── 1 · El reclamo de legacy que rompió la 203 ───────────';
  PERFORM pg_temp.esperar('el hub reclama la fila legacy de su ruta',
    pg_temp.guardar('qa208.hub@local.test','qa208.hub@local.test','Peru','Lima','2026-08-11','' ),
    'deleted=1 inserted=1');
  -- Sin la 208 acá quedaban 2: la legacy sobrevivía al DELETE y la nueva se
  -- sumaba al lado, sin error y con la UI diciendo "guardado".
  PERFORM pg_temp.esperar('queda UNA fila, no dos',
    pg_temp.filas('Peru','Lima','2026-08-11')::text, '1');

  RAISE NOTICE E'\n── 2 · Idempotencia ────────────────────────────────────';
  PERFORM pg_temp.esperar('guardar de nuevo borra lo propio y reinserta',
    pg_temp.guardar('qa208.hub@local.test','qa208.hub@local.test','Peru','Lima','2026-08-11',''),
    'deleted=1 inserted=1');
  PERFORM pg_temp.esperar('sigue habiendo UNA fila',
    pg_temp.filas('Peru','Lima','2026-08-11')::text, '1');
END $$;

-- ── 3 · Lo de OTRO hub no se toca (mig 139) ──────────────────────────
INSERT INTO pricing_observations
 (country,city,zone,observed_date,observed_time,category,timeslot,competition_name,
  distance_bracket,point_a,point_b,price_without_discount,data_source,uploaded_by)
VALUES ('Peru','Lima','', '2026-08-12','09:00','Economy/Comfort','Mañana','Didi',
        'short','A','B',99,'manual','qa208.otro@local.test');

DO $$
DECLARE v_ajena int;
BEGIN
  RAISE NOTICE E'\n── 3 · El trabajo del compañero sigue siendo suyo ───────';
  PERFORM pg_temp.esperar('el hub guarda sobre la misma ruta',
    pg_temp.guardar('qa208.hub@local.test','qa208.hub@local.test','Peru','Lima','2026-08-12',''),
    'deleted=0 inserted=1');
  SELECT count(*) INTO v_ajena FROM pricing_observations
   WHERE observed_date='2026-08-12' AND uploaded_by='qa208.otro@local.test';
  -- Si esto diera 0, el fix habría convertido un duplicado en pérdida de datos
  -- del compañero, que es peor.
  PERFORM pg_temp.esperar('la fila del otro hub sigue ahí', v_ajena::text, '1');
END $$;

-- ── 4..6 · Los guards que reemplazan a RLS ───────────────────────────
DO $$
BEGIN
  RAISE NOTICE E'\n── 4 · Sección ─────────────────────────────────────────';
  PERFORM pg_temp.esperar('rol sin la sección Ingresar CI',
    pg_temp.guardar('qa208.sinci@local.test','qa208.sinci@local.test','Peru','Lima','2026-08-13',''),
    'denegado');

  RAISE NOTICE E'\n── 5 · País ────────────────────────────────────────────';
  PERFORM pg_temp.esperar('hub de Perú guardando en Colombia',
    pg_temp.guardar('qa208.hub@local.test','qa208.hub@local.test','Colombia','Bogota','2026-08-13',''),
    'denegado');

  RAISE NOTICE E'\n── 6 · Identidad ───────────────────────────────────────';
  -- Con DEFINER, p_user_email manda el DELETE: si se aceptara del payload, un
  -- hub podría borrar las filas de un compañero en esa ruta exacta.
  PERFORM pg_temp.esperar('hub guardando a nombre de otro',
    pg_temp.guardar('qa208.hub@local.test','qa208.otro@local.test','Peru','Lima','2026-08-13',''),
    'denegado');
END $$;

-- ── 7 · El payload no decide el alcance ──────────────────────────────
DO $$
DECLARE v_pe int; v_co int; v_duenio text;
BEGIN
  RAISE NOTICE E'\n── 7 · country/city de la FILA vs de los parámetros ─────';
  -- La llamada es Perú/Lima, pero cada fila dice Colombia/Bogota. Sin el
  -- forzado del INSERT, con DEFINER esto escribiría en Colombia.
  PERFORM pg_temp.esperar('guarda con la fila diciendo otro país',
    pg_temp.guardar('qa208.hub@local.test','qa208.hub@local.test','Peru','Lima','2026-08-14','',
                    'Colombia','Bogota'),
    'deleted=0 inserted=1');
  SELECT pg_temp.filas('Peru','Lima','2026-08-14') INTO v_pe;
  SELECT pg_temp.filas('Colombia','Bogota','2026-08-14') INTO v_co;
  PERFORM pg_temp.esperar('la fila quedó en Perú/Lima (los parámetros)', v_pe::text, '1');
  PERFORM pg_temp.esperar('y NADA en Colombia', v_co::text, '0');

  SELECT DISTINCT uploaded_by INTO v_duenio FROM pricing_observations
   WHERE observed_date='2026-08-14' AND country='Peru';
  PERFORM pg_temp.esperar('el dueño lo puso la base', v_duenio, 'qa208.hub@local.test');
END $$;

-- ── 8 · anon ─────────────────────────────────────────────────────────
DO $$
DECLARE v text;
BEGIN
  RAISE NOTICE E'\n── 8 · anon ────────────────────────────────────────────';
  SET LOCAL ROLE anon;
  BEGIN
    PERFORM save_ci_batch('Peru','Lima',current_date,'','x@y.z','[]'::jsonb,'[]'::jsonb);
    v := 'ok';
  EXCEPTION WHEN OTHERS THEN v := SQLSTATE;
  END;
  RESET ROLE;
  PERFORM pg_temp.esperar('anon · save_ci_batch', v, '42501');
END $$;

-- ── 9 · Y la 203 sigue cerrada por el otro lado ──────────────────────
DO $$
DECLARE v_borradas int;
BEGIN
  RAISE NOTICE E'\n── 9 · El agujero que la 203 cerró sigue cerrado ────────';
  SET LOCAL request.jwt.claims TO '{"email":"qa208.hub@local.test","role":"authenticated"}';
  SET LOCAL ROLE authenticated;
  -- Por PostgREST directo, sin pasar por la RPC: la política de la 203 tiene
  -- que seguir impidiendo el barrido de las filas del bot.
  DELETE FROM pricing_observations WHERE country='Peru' AND uploaded_by IS NULL;
  GET DIAGNOSTICS v_borradas = ROW_COUNT;
  RESET ROLE;
  PERFORM pg_temp.esperar('borrado masivo de filas sin dueño por tabla', v_borradas::text, '0');
END $$;

ROLLBACK;
