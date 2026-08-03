-- ════════════════════════════════════════════════════════════════════════
-- Mig 211 — el guardado de Ingresar CI duplicaba en Aeropuerto porque el
-- DELETE buscaba la zona CRUDA (NULL) y el trigger guardaba 'Airport_A'.
--
-- Reproduce el caso REAL de producción (raisalopez / Arequipa_Airport_A,
-- 108 celdas duplicadas por guardar dos veces) y las garantías que NO se
-- pueden romper al arreglarlo.
--
-- Corre con `docker exec ... psql -U postgres` y revierte todo al final.
-- ════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
\pset pager off

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.ok(p_cond boolean, p_msg text, p_got text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_cond THEN
    RAISE NOTICE '  ok  % %', p_msg, COALESCE('→ ' || p_got, '');
  ELSE
    RAISE EXCEPTION 'FALLÓ: % %', p_msg, COALESCE('→ ' || p_got, '');
  END IF;
END $$;

-- ── Escenario: un hub real de Perú con la sección Ingresar CI ──────────
INSERT INTO roles (name, label, permissions)
VALUES ('qa211_hub', 'QA 211 hub', '{"sections":["dataentry"],"countries":["Peru"]}'::jsonb)
ON CONFLICT (name) DO UPDATE SET permissions = EXCLUDED.permissions;

INSERT INTO user_profiles (email, role_id, is_active)
SELECT 'qa211.hub@local.test', id, true FROM roles WHERE name='qa211_hub'
ON CONFLICT (email) DO UPDATE SET role_id = EXCLUDED.role_id, is_active = true;

INSERT INTO user_profiles (email, role_id, is_active)
SELECT 'qa211.otro@local.test', id, true FROM roles WHERE name='qa211_hub'
ON CONFLICT (email) DO UPDATE SET role_id = EXCLUDED.role_id, is_active = true;

-- Marcador de aeropuerto: es de donde el trigger saca la zona.
INSERT INTO airport_markers (country, base_city, city_from, city_to,
                             zone_from_value, zone_to_value, active)
VALUES ('Peru', 'QAcity', 'QAcity_Airport_A', 'QAcity_Airport_B',
        'Airport_A', 'Airport_B', true)
ON CONFLICT (country, base_city) DO UPDATE
  SET city_from = EXCLUDED.city_from, city_to = EXCLUDED.city_to,
      zone_from_value = EXCLUDED.zone_from_value,
      zone_to_value = EXCLUDED.zone_to_value, active = true;

-- Payloads reutilizables (una ruta, un competidor).
CREATE TEMP TABLE qa211 AS
SELECT
  '[{"category":"Economy/Comfort","timeslot":"Morning","bracket":"median",
     "point_a":"QA_A","point_b":"QA_B","competitors":["Uber"]}]'::jsonb AS rutas,
  '[{"category":"Economy/Comfort","competition_name":"Uber","timeslot":"Morning",
     "distance_bracket":"median","point_a":"QA_A","point_b":"QA_B",
     "observed_time":"10:00","price_without_discount":12.5,
     "year":2026,"week":32}]'::jsonb AS filas;

CREATE OR REPLACE FUNCTION pg_temp.como(p_email text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', p_email, 'role','authenticated')::text, true);
END $$;

-- ══════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  q record; r1 jsonb; r2 jsonb; v_n int; v_zona text;
BEGIN
  SELECT * INTO q FROM qa211;
  RAISE NOTICE '';
  RAISE NOTICE '── 1 · EL BUG: aeropuerto guardado dos veces ────────────────';
  PERFORM pg_temp.como('qa211.hub@local.test');

  -- El cliente manda p_zone = NULL: la vista de aeropuerto no tiene zona.
  r1 := save_ci_batch('Peru','QAcity_Airport_A', DATE '2026-08-03', NULL,
                      'qa211.hub@local.test', q.rutas, q.filas, 'qa211-t1', NULL, true);

  SELECT count(*), min(zone) INTO v_n, v_zona FROM pricing_observations
   WHERE city='QAcity_Airport_A' AND observed_date='2026-08-03' AND point_a='QA_A';
  PERFORM pg_temp.ok(v_n = 1, '1er guardado deja 1 fila', v_n::text);
  PERFORM pg_temp.ok(v_zona = 'Airport_A',
    'y la zona la completó el trigger (el cliente mandó NULL)', v_zona);

  -- El MISMO guardado otra vez. Antes de la 211: deleted=0 y quedaban 2.
  r2 := save_ci_batch('Peru','QAcity_Airport_A', DATE '2026-08-03', NULL,
                      'qa211.hub@local.test', q.rutas, q.filas, 'qa211-t1', NULL, true);

  SELECT count(*) INTO v_n FROM pricing_observations
   WHERE city='QAcity_Airport_A' AND observed_date='2026-08-03' AND point_a='QA_A';
  PERFORM pg_temp.ok((r2->>'deleted')::int = 1,
    'el 2do guardado SÍ borra la fila anterior', 'deleted=' || (r2->>'deleted'));
  PERFORM pg_temp.ok(v_n = 1, 'sigue habiendo UNA fila, no dos', v_n::text);
END $$;

DO $$
DECLARE q record; v_n int; v_zona text;
BEGIN
  SELECT * INTO q FROM qa211;
  RAISE NOTICE '';
  RAISE NOTICE '── 2 · TukTuk: la zona la manda el cliente ──────────────────';
  PERFORM pg_temp.como('qa211.hub@local.test');

  PERFORM save_ci_batch('Peru','Lima', DATE '2026-08-03', 'Comas',
                        'qa211.hub@local.test', q.rutas, q.filas, 'qa211-t2', NULL, true);
  PERFORM save_ci_batch('Peru','Lima', DATE '2026-08-03', 'Comas',
                        'qa211.hub@local.test', q.rutas, q.filas, 'qa211-t2', NULL, true);

  SELECT count(*), min(zone) INTO v_n, v_zona FROM pricing_observations
   WHERE city='Lima' AND zone='Comas' AND observed_date='2026-08-03' AND point_a='QA_A';
  PERFORM pg_temp.ok(v_n = 1, 'TukTuk sigue idempotente', v_n::text);
  PERFORM pg_temp.ok(v_zona = 'Comas', 'y conserva el distrito del cliente', v_zona);
END $$;

DO $$
DECLARE q record; v_n int; v_zona text;
BEGIN
  SELECT * INTO q FROM qa211;
  RAISE NOTICE '';
  RAISE NOTICE '── 3 · Normal/Corp: zona NULL de punta a punta ──────────────';
  PERFORM pg_temp.como('qa211.hub@local.test');

  PERFORM save_ci_batch('Peru','Trujillo', DATE '2026-08-03', NULL,
                        'qa211.hub@local.test', q.rutas, q.filas, 'qa211-t3', NULL, true);
  PERFORM save_ci_batch('Peru','Trujillo', DATE '2026-08-03', NULL,
                        'qa211.hub@local.test', q.rutas, q.filas, 'qa211-t3', NULL, true);

  SELECT count(*), count(*) FILTER (WHERE zone IS NULL) INTO v_n, v_zona
    FROM pricing_observations
   WHERE city='Trujillo' AND observed_date='2026-08-03' AND point_a='QA_A';
  PERFORM pg_temp.ok(v_n = 1, 'Normal sigue idempotente', v_n::text);
  PERFORM pg_temp.ok(v_zona::int = 1, 'y la zona queda NULL', v_zona);
END $$;

DO $$
DECLARE q record; v_n int;
BEGIN
  SELECT * INTO q FROM qa211;
  RAISE NOTICE '';
  RAISE NOTICE '── 4 · El trabajo del compañero sigue siendo suyo (mig 139) ─';
  -- Fila del OTRO hub en la MISMA ruta de aeropuerto.
  INSERT INTO pricing_observations
    (country, city, zone, observed_date, observed_time, category, competition_name,
     distance_bracket, timeslot, point_a, point_b, price_without_discount,
     data_source, year, week, uploaded_by)
  VALUES ('Peru','QAcity_Airport_A', NULL,'2026-08-03','11:00','Economy/Comfort','Uber',
          'median','Morning','QA_A','QA_B', 99.9, 'manual', 2026, 32,
          'qa211.otro@local.test');

  PERFORM pg_temp.como('qa211.hub@local.test');
  PERFORM save_ci_batch('Peru','QAcity_Airport_A', DATE '2026-08-03', NULL,
                        'qa211.hub@local.test', q.rutas, q.filas, 'qa211-t1', NULL, true);

  SELECT count(*) INTO v_n FROM pricing_observations
   WHERE city='QAcity_Airport_A' AND observed_date='2026-08-03' AND point_a='QA_A'
     AND uploaded_by='qa211.otro@local.test';
  PERFORM pg_temp.ok(v_n = 1, 'la fila del otro hub NO se borró', v_n::text);
END $$;

DO $$
DECLARE q record; v_n int;
BEGIN
  SELECT * INTO q FROM qa211;
  RAISE NOTICE '';
  RAISE NOTICE '── 5 · Reclamo de legacy: sin dueño SÍ se reclama (mig 208) ─';
  INSERT INTO pricing_observations
    (country, city, zone, observed_date, observed_time, category, competition_name,
     distance_bracket, timeslot, point_a, point_b, price_without_discount,
     data_source, year, week, uploaded_by)
  VALUES ('Peru','QAcity_Airport_B', NULL,'2026-08-03','09:00','Economy/Comfort','Uber',
          'median','Morning','QA_A','QA_B', 55.5, 'manual', 2026, 32, NULL);

  PERFORM pg_temp.como('qa211.hub@local.test');
  PERFORM save_ci_batch('Peru','QAcity_Airport_B', DATE '2026-08-03', NULL,
                        'qa211.hub@local.test', q.rutas, q.filas, 'qa211-t4', NULL, true);

  SELECT count(*) INTO v_n FROM pricing_observations
   WHERE city='QAcity_Airport_B' AND observed_date='2026-08-03' AND point_a='QA_A';
  PERFORM pg_temp.ok(v_n = 1,
    'la fila legacy fue reclamada, no duplicada (era el fix de la 208)', v_n::text);
END $$;

DO $$
DECLARE q record; v_n int;
BEGIN
  SELECT * INTO q FROM qa211;
  RAISE NOTICE '';
  RAISE NOTICE '── 6 · No barrer la zona ajena (las ~76k filas de Excel) ────';
  -- Misma ruta y ciudad, pero con una zona DISTINTA de la del marcador.
  INSERT INTO pricing_observations
    (country, city, zone, observed_date, observed_time, category, competition_name,
     distance_bracket, timeslot, point_a, point_b, price_without_discount,
     data_source, year, week, uploaded_by)
  VALUES ('Peru','QAcity_Airport_A','ZONA_AJENA','2026-08-03','08:00','Economy/Comfort',
          'Uber','median','Morning','QA_A','QA_B', 77.7, 'manual', 2026, 32, NULL);

  PERFORM pg_temp.como('qa211.hub@local.test');
  PERFORM save_ci_batch('Peru','QAcity_Airport_A', DATE '2026-08-03', NULL,
                        'qa211.hub@local.test', q.rutas, q.filas, 'qa211-t1', NULL, true);

  SELECT count(*) INTO v_n FROM pricing_observations
   WHERE city='QAcity_Airport_A' AND zone='ZONA_AJENA' AND observed_date='2026-08-03';
  PERFORM pg_temp.ok(v_n = 1,
    'la fila con otra zona sobrevive (el acote sigue siendo estrecho)', v_n::text);
END $$;

DO $$
DECLARE
  c record;
  v_real     text;
  v_esperado text;
  v_casos    int := 0;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '── 7 · ci_zona_efectiva == lo que escribe el trigger ────────';
  -- La razón de ser de la función: que la regla no pueda divergir. Se compara
  -- contra lo que el trigger REALMENTE escribe, no contra una expectativa
  -- escrita a mano — si mañana alguien toca uno de los dos, esto se pone rojo.
  FOR c IN
    SELECT * FROM (VALUES
      ('QAcity_Airport_A', NULL::text),   -- aeropuerto sin zona → la del marcador
      ('QAcity_Airport_B', NULL),         -- el otro lado
      ('QAcity_Airport_A', 'Comas'),      -- zona explícita: NO se pisa
      ('Lima',             'Comas'),      -- TukTuk
      ('Trujillo',         NULL)          -- normal: queda NULL
    ) AS t(city, zone_in)
  LOOP
    v_esperado := ci_zona_efectiva('Peru', c.city, c.zone_in);

    INSERT INTO pricing_observations
      (country, city, zone, observed_date, observed_time, category,
       competition_name, distance_bracket, timeslot, point_a, point_b,
       price_without_discount, data_source, year, week, uploaded_by)
    VALUES ('Peru', c.city, c.zone_in, '2026-08-04','07:00','Economy/Comfort',
            'Uber','median','Morning','QA_Z_'||c.city||coalesce(c.zone_in,''),'QA_Z',
            1, 'manual', 2026, 32, 'qa211.hub@local.test')
    RETURNING zone INTO v_real;

    PERFORM pg_temp.ok(v_esperado IS NOT DISTINCT FROM v_real,
      format('%s / zona pedida %s', c.city, coalesce(c.zone_in,'NULL')),
      format('función=%s · trigger=%s', coalesce(v_esperado,'NULL'), coalesce(v_real,'NULL')));
    v_casos := v_casos + 1;
  END LOOP;

  PERFORM pg_temp.ok(v_casos = 5, 'se compararon los 5 casos', v_casos::text);
END $$;

DO $$ BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '✓ TODAS LAS SIMULACIONES DE LA 211 PASARON';
END $$;

ROLLBACK;
