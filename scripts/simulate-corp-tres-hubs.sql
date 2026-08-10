-- ════════════════════════════════════════════════════════════════════════
-- simulate-corp-tres-hubs.sql — TRES hubs midiendo Corporativo el MISMO día.
-- Supabase LOCAL, nunca producción.
--
--   docker exec -i supabase_db_pricing-ci-dashboard psql -U postgres -X \
--     < scripts/simulate-corp-tres-hubs.sql
--
-- ── POR QUÉ EXISTE ──────────────────────────────────────────────────────
-- Hasta hoy Corp SIEMPRE lo trabajó UN hub por día (medido en producción:
-- 162 filas, 1 dueño, todos los días de las últimas 6 semanas). Poner tres a
-- la vez es un escenario NUEVO que nunca corrió, y la pregunta del user es la
-- correcta: ¿se pisan el trabajo, o se suman las tres mediciones?
--
-- Las dos mitades importan igual y por motivos opuestos:
--   · Si se pisan → se pierde trabajo de un hub sin ningún error visible.
--   · Si NO se suman → los tres midieron para nada; el objetivo declarado es
--     TRIPLICAR la muestra, no confirmarla.
--
-- ── LO QUE SE PRUEBA ────────────────────────────────────────────────────
--   [1] Las tres mediciones conviven: nadie borra al otro.
--   [2] Cada hub sigue siendo idempotente CONSIGO mismo (re-guardar no duplica).
--   [3] El agregado del dashboard cuenta 3 muestras, no 1.
--   [4] El promedio es el de las 3, no el del último que guardó.
--   [5] El candado de bucket (mig 191) NO bloquea entre hubs distintos.
--   [6] La carga de la grilla de un hub no arrastra filas de otro (mig 139).
--   [7] Las filas legacy sin dueño no se las lleva puestas cualquiera dos veces.
--
-- Corre como `authenticated` con JWT simulado. Transacción revertida al final.
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

CREATE OR REPLACE FUNCTION pg_temp.como(p_email text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('SET LOCAL request.jwt.claims TO %L',
                 json_build_object('email', p_email, 'role', 'authenticated')::text);
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

CREATE OR REPLACE FUNCTION pg_temp.como_postgres()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'RESET ROLE';
  EXECUTE 'SET LOCAL request.jwt.claims TO DEFAULT';
END $$;

/**
 * Un guardado de Ingresar CI tal cual lo manda el cliente para Corp.
 *
 * Corp va con zona NULL de punta a punta (no es aeropuerto ni TukTuk), que es
 * justamente el caso donde la mig 211 midió CERO duplicados. El precio se pasa
 * por parámetro para poder distinguir después qué escribió cada hub.
 */
CREATE OR REPLACE FUNCTION pg_temp.guardar(
  p_email text, p_fecha date, p_precio numeric, p_session text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v jsonb;
BEGIN
  PERFORM pg_temp.como(p_email);
  SELECT save_ci_batch(
    'Peru', 'Corp', p_fecha, NULL, p_email,
    -- Las DOS rutas que este hub declara tocar (el DELETE acota por ruta exacta)
    jsonb_build_array(
      jsonb_build_object('category','Corp','timeslot','Morning',
                         'bracket','short','competitors', jsonb_build_array('YangoEconomy','Cabify')),
      jsonb_build_object('category','Corp','timeslot','Evening',
                         'bracket','short','competitors', jsonb_build_array('YangoEconomy','Cabify'))
    ),
    jsonb_build_array(
      jsonb_build_object('year',2026,'week',33,'observed_time','09:00','timeslot','Morning',
        'category','Corp','competition_name','YangoEconomy','distance_bracket','short',
        'price_without_discount', p_precio,       'data_source','manual','time_of_day','Morning'),
      jsonb_build_object('year',2026,'week',33,'observed_time','09:00','timeslot','Morning',
        'category','Corp','competition_name','Cabify','distance_bracket','short',
        'price_without_discount', p_precio + 1,   'data_source','manual','time_of_day','Morning'),
      jsonb_build_object('year',2026,'week',33,'observed_time','15:00','timeslot','Evening',
        'category','Corp','competition_name','YangoEconomy','distance_bracket','short',
        'price_without_discount', p_precio + 2,   'data_source','manual','time_of_day','Evening'),
      jsonb_build_object('year',2026,'week',33,'observed_time','15:00','timeslot','Evening',
        'category','Corp','competition_name','Cabify','distance_bracket','short',
        'price_without_discount', p_precio + 3,   'data_source','manual','time_of_day','Evening')
    ),
    p_session, NULL, false
  ) INTO v;
  RETURN v;
END $$;

-- ══════════════════════════════════════════════════════════════════════
-- Escenario: tres hubs reales de Perú con la sección Ingresar CI
-- ══════════════════════════════════════════════════════════════════════
INSERT INTO roles (name, label, permissions)
VALUES ('qa_corp_hub', 'QA Corp Hub', '{"sections":["dataentry"],"countries":["Peru"]}');

INSERT INTO user_profiles (email, role_id, is_active) VALUES
  ('qa.corp1@local.test', (SELECT id FROM roles WHERE name='qa_corp_hub'), true),
  ('qa.corp2@local.test', (SELECT id FROM roles WHERE name='qa_corp_hub'), true),
  ('qa.corp3@local.test', (SELECT id FROM roles WHERE name='qa_corp_hub'), true);

\echo ''
\echo '══ [1] Los tres guardan: nadie borra al otro ══'

DO $$
DECLARE v jsonb;
BEGIN
  v := pg_temp.guardar('qa.corp1@local.test', DATE '2026-08-12', 10, 'sesion-hub1');
  PERFORM pg_temp.esperar('hub 1 inserta sus 4 filas', v->>'inserted', '4');
  PERFORM pg_temp.esperar('y no borró nada (bucket vacío)', v->>'deleted', '0');

  v := pg_temp.guardar('qa.corp2@local.test', DATE '2026-08-12', 20, 'sesion-hub2');
  PERFORM pg_temp.esperar('hub 2 inserta sus 4 filas', v->>'inserted', '4');
  -- ESTE es el número que importa: si fuera 4, el hub 2 se habría llevado
  -- puesto el trabajo del hub 1 sin ningún error visible.
  PERFORM pg_temp.esperar('hub 2 NO borró las del hub 1', v->>'deleted', '0');

  v := pg_temp.guardar('qa.corp3@local.test', DATE '2026-08-12', 30, 'sesion-hub3');
  PERFORM pg_temp.esperar('hub 3 inserta sus 4 filas', v->>'inserted', '4');
  PERFORM pg_temp.esperar('hub 3 tampoco borró nada ajeno', v->>'deleted', '0');
END $$;

DO $$
DECLARE v int;
BEGIN
  PERFORM pg_temp.como_postgres();
  SELECT count(*) INTO v FROM pricing_observations
   WHERE city='Corp' AND observed_date=DATE '2026-08-12' AND data_source='manual';
  PERFORM pg_temp.esperar('quedan las 12 filas (3 hubs × 4)', v::text, '12');

  SELECT count(DISTINCT uploaded_by) INTO v FROM pricing_observations
   WHERE city='Corp' AND observed_date=DATE '2026-08-12';
  PERFORM pg_temp.esperar('con los 3 dueños distintos', v::text, '3');

  -- Cada hub conserva SUS precios, sin mezclarse.
  SELECT count(*) INTO v FROM pricing_observations
   WHERE city='Corp' AND observed_date=DATE '2026-08-12'
     AND uploaded_by='qa.corp1@local.test' AND price_without_discount IN (10,11,12,13);
  PERFORM pg_temp.esperar('los precios del hub 1 están intactos', v::text, '4');
  SELECT count(*) INTO v FROM pricing_observations
   WHERE city='Corp' AND observed_date=DATE '2026-08-12'
     AND uploaded_by='qa.corp3@local.test' AND price_without_discount IN (30,31,32,33);
  PERFORM pg_temp.esperar('los del hub 3 también', v::text, '4');
END $$;

\echo ''
\echo '══ [2] Cada hub sigue siendo idempotente CONSIGO mismo ══'

DO $$
DECLARE v jsonb; n int;
BEGIN
  -- El hub 2 corrige un precio y vuelve a guardar. Tiene que reemplazar lo
  -- SUYO y no tocar lo de los otros dos.
  v := pg_temp.guardar('qa.corp2@local.test', DATE '2026-08-12', 25, 'sesion-hub2');
  PERFORM pg_temp.esperar('re-guardar borra sus 4 viejas', v->>'deleted', '4');
  PERFORM pg_temp.esperar('y reinserta 4', v->>'inserted', '4');

  PERFORM pg_temp.como_postgres();
  SELECT count(*) INTO n FROM pricing_observations
   WHERE city='Corp' AND observed_date=DATE '2026-08-12' AND data_source='manual';
  PERFORM pg_temp.esperar('siguen siendo 12, no 16', n::text, '12');

  SELECT count(*) INTO n FROM pricing_observations
   WHERE city='Corp' AND observed_date=DATE '2026-08-12'
     AND uploaded_by='qa.corp1@local.test' AND price_without_discount = 10;
  PERFORM pg_temp.esperar('el hub 1 no se enteró', n::text, '1');
END $$;

\echo ''
\echo '══ [3] El candado de bucket no cruza entre hubs ══'

DO $$
DECLARE v bigint; n int;
BEGIN
  PERFORM pg_temp.como_postgres();
  -- La marca de agua de la mig 191 tiene el email en la PK: tres hubs = tres
  -- filas independientes. Si fuera una sola por bucket, el segundo hub
  -- comería un conflicto y no podría guardar.
  SELECT count(*) INTO n FROM ci_bucket_writes
   WHERE country='Peru' AND city='Corp' AND observed_date=DATE '2026-08-12';
  PERFORM pg_temp.esperar('una marca de agua POR HUB', n::text, '3');

  SELECT write_seq INTO v FROM ci_bucket_writes
   WHERE user_email='qa.corp2@local.test' AND city='Corp' AND observed_date=DATE '2026-08-12';
  PERFORM pg_temp.esperar('la del hub 2 va en 2 (guardó dos veces)', v::text, '2');
  SELECT write_seq INTO v FROM ci_bucket_writes
   WHERE user_email='qa.corp1@local.test' AND city='Corp' AND observed_date=DATE '2026-08-12';
  PERFORM pg_temp.esperar('la del hub 1 sigue en 1', v::text, '1');
END $$;

\echo ''
\echo '══ [4] La grilla de un hub no arrastra filas de otro (mig 139) ══'

DO $$
DECLARE n int;
BEGIN
  -- Réplica exacta del filtro de loadObservationsIntoForm.
  PERFORM pg_temp.como('qa.corp1@local.test');
  SELECT count(*) INTO n FROM pricing_observations
   WHERE country='Peru' AND city='Corp' AND observed_date=DATE '2026-08-12'
     AND data_source='manual'
     AND (uploaded_by = 'qa.corp1@local.test' OR uploaded_by IS NULL);
  PERFORM pg_temp.esperar('el hub 1 carga SOLO sus 4', n::text, '4');

  -- Pero VER, ve todas (RLS de lectura es por país). Eso está bien: es lo que
  -- permite auditar; lo que no puede pasar es que las EDITE como propias.
  SELECT count(*) INTO n FROM pricing_observations
   WHERE country='Peru' AND city='Corp' AND observed_date=DATE '2026-08-12';
  PERFORM pg_temp.esperar('aunque por RLS pueda leer las 12', n::text, '12');
END $$;

\echo ''
\echo '══ [5] EL PUNTO DEL EJERCICIO: ¿se cuentan las 3 muestras? ══'

DO $$
DECLARE n bigint; p numeric;
BEGIN
  PERFORM pg_temp.como_postgres();
  PERFORM refresh_ci_aggregates(4000);

  -- El agregado agrupa por ruta y NO por dueño: las 3 mediciones de la misma
  -- ruta caen en el mismo grupo y suman.
  SELECT observation_count, avg_price INTO n, p
    FROM v_bracket_daily_avg_mv
   WHERE country='Peru' AND city='Corp' AND observed_date=DATE '2026-08-12'
     AND competition_name='YangoEconomy' AND distance_bracket='short' AND time_of_day='Morning';

  PERFORM pg_temp.esperar('la ruta Morning/YangoEconomy cuenta 3 muestras, no 1', n::text, '3');
  -- hub1=10, hub2=25 (corregido), hub3=30 → (10+25+30)/3 = 21.666…
  PERFORM pg_temp.esperar('y el promedio es el de las TRES',
                          round(p, 2)::text, '21.67');

  SELECT sum(observation_count) INTO n FROM v_bracket_daily_avg_mv
   WHERE country='Peru' AND city='Corp' AND observed_date=DATE '2026-08-12';
  PERFORM pg_temp.esperar('12 observaciones en total en el día', n::text, '12');
END $$;

\echo ''
\echo '══ [6] Filas legacy sin dueño: no se duplican entre hubs ══'

DO $$
DECLARE n int; v jsonb;
BEGIN
  -- Una fila vieja sin dueño en la MISMA ruta (las hay en producción hasta el
  -- 2026-07-19). El primero que guarde se la reclama; el resto ya no la ve.
  PERFORM pg_temp.como_postgres();
  INSERT INTO pricing_observations
    (city, country, observed_date, year, week, observed_time, timeslot, time_of_day,
     category, competition_name, distance_bracket, price_without_discount,
     data_source, uploaded_by)
  VALUES ('Corp','Peru',DATE '2026-08-13',2026,33,'09:00','Morning','Morning',
          'Corp','YangoEconomy','short', 99, 'manual', NULL);

  v := pg_temp.guardar('qa.corp1@local.test', DATE '2026-08-13', 10, 'sesion-hub1');
  PERFORM pg_temp.esperar('el hub 1 reclama la legacy', v->>'deleted', '1');

  v := pg_temp.guardar('qa.corp2@local.test', DATE '2026-08-13', 20, 'sesion-hub2');
  PERFORM pg_temp.esperar('el hub 2 ya no encuentra ninguna sin dueño', v->>'deleted', '0');

  PERFORM pg_temp.como_postgres();
  SELECT count(*) INTO n FROM pricing_observations
   WHERE city='Corp' AND observed_date=DATE '2026-08-13' AND uploaded_by IS NULL;
  PERFORM pg_temp.esperar('no queda ninguna huérfana', n::text, '0');
  SELECT count(*) INTO n FROM pricing_observations
   WHERE city='Corp' AND observed_date=DATE '2026-08-13';
  PERFORM pg_temp.esperar('y quedan las 8 de los dos hubs', n::text, '8');
END $$;

\echo ''
\echo '✓ simulate-corp-tres-hubs: todo OK'

ROLLBACK;
