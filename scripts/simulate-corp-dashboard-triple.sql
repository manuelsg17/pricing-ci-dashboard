-- ════════════════════════════════════════════════════════════════════════
-- simulate-corp-dashboard-triple.sql — la pregunta del user, de punta a punta.
-- Supabase LOCAL, nunca producción.
--
--   docker exec -i supabase_db_pricing-ci-dashboard psql -U postgres -X \
--     < scripts/simulate-corp-dashboard-triple.sql
--
-- LA PREGUNTA: si TRES hubs completan Corporativo el mismo día, ¿el DASHBOARD
-- muestra el triple de datapoints?
--
-- `simulate-corp-tres-hubs.sql` ya probó que los tres guardan sin pisarse. Esto
-- prueba el tramo que faltaba y que es el que le importa al negocio: que esa
-- data llegue hasta el agregado que alimenta la pantalla. Son cosas distintas
-- — la data puede estar perfecta en `pricing_observations` y el dashboard
-- seguir mostrando 1 muestra si el agregado agrupara por dueño.
--
-- Se reproduce la grilla REAL de Corp medida en producción el 2026-08-10:
-- 3 turnos × 6 tramos × 9 competidores = 162 celdas por hub.
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

/**
 * Un hub completa TODA la grilla de Corp, igual que en producción.
 *
 * `p_delta` desplaza los precios de ese hub: tres personas midiendo la misma
 * ruta a distinta hora no anotan el mismo número, y si lo hicieran no se
 * podría distinguir "se guardaron las tres" de "se guardó una tres veces".
 */
CREATE OR REPLACE FUNCTION pg_temp.completar_corp(p_email text, p_fecha date, p_delta numeric)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  v_turnos   text[] := ARRAY['Morning','Midday','Evening'];
  v_brackets text[] := ARRAY['very_short','short','median','average','long','very_long'];
  v_comps    text[] := ARRAY['Cabify','CabifyExtraComfort','CabifyLite','CabifyXL',
                             'YangoComfort','YangoEconomy','YangoPlus','YangoPremier','YangoXL'];
  v_rutas jsonb := '[]'::jsonb;
  v_filas jsonb := '[]'::jsonb;
  t text; b text; c text; i int := 0;
BEGIN
  FOREACH t IN ARRAY v_turnos LOOP
    FOREACH b IN ARRAY v_brackets LOOP
      v_rutas := v_rutas || jsonb_build_object(
        'category','Corp','timeslot',t,'bracket',b,
        'competitors', to_jsonb(v_comps));
      FOREACH c IN ARRAY v_comps LOOP
        i := i + 1;
        v_filas := v_filas || jsonb_build_object(
          'year',2026,'week',33,
          'observed_time', CASE t WHEN 'Morning' THEN '09:00' WHEN 'Midday' THEN '13:00' ELSE '18:00' END,
          'timeslot',t,'time_of_day',t,
          'category','Corp','competition_name',c,'distance_bracket',b,
          -- Precio plausible que crece con la distancia, más el desplazamiento
          -- propio del hub.
          'price_without_discount',
            round((8 + array_position(v_brackets,b) * 2.5 + p_delta)::numeric, 2),
          'data_source','manual');
      END LOOP;
    END LOOP;
  END LOOP;

  EXECUTE format('SET LOCAL request.jwt.claims TO %L',
                 json_build_object('email', p_email, 'role','authenticated')::text);
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN save_ci_batch('Peru','Corp',p_fecha,NULL,p_email,v_rutas,v_filas,
                       'sesion-'||p_email, NULL, false);
END $$;

-- ── Escenario ─────────────────────────────────────────────────────────
INSERT INTO roles (name,label,permissions)
VALUES ('qa_corp3','QA Corp','{"sections":["dataentry"],"countries":["Peru"]}')
ON CONFLICT (name) DO NOTHING;
INSERT INTO user_profiles (email, role_id, is_active) VALUES
  ('sim.raisa@local.test',   (SELECT id FROM roles WHERE name='qa_corp3'), true),
  ('sim.mafer@local.test',   (SELECT id FROM roles WHERE name='qa_corp3'), true),
  ('sim.eduardo@local.test', (SELECT id FROM roles WHERE name='qa_corp3'), true)
ON CONFLICT (email) DO NOTHING;

\echo ''
\echo '══ [1] Los tres completan Corp el mismo día ══'

DO $$
DECLARE v jsonb;
BEGIN
  v := pg_temp.completar_corp('sim.raisa@local.test',   DATE '2026-08-12', 0);
  PERFORM pg_temp.esperar('Raisa guarda la grilla completa', v->>'inserted', '162');
  RESET ROLE;

  v := pg_temp.completar_corp('sim.mafer@local.test',   DATE '2026-08-12', 1.5);
  PERFORM pg_temp.esperar('Mafer guarda la suya', v->>'inserted', '162');
  PERFORM pg_temp.esperar('y NO borró nada de Raisa', v->>'deleted', '0');
  RESET ROLE;

  v := pg_temp.completar_corp('sim.eduardo@local.test', DATE '2026-08-12', 3.0);
  PERFORM pg_temp.esperar('Eduardo guarda la suya', v->>'inserted', '162');
  PERFORM pg_temp.esperar('y tampoco borró nada ajeno', v->>'deleted', '0');
  RESET ROLE;
END $$;

DO $$
DECLARE v int;
BEGIN
  RESET ROLE;
  SELECT count(*) INTO v FROM pricing_observations
   WHERE city='Corp' AND observed_date=DATE '2026-08-12' AND data_source='manual';
  PERFORM pg_temp.esperar('486 filas en la base (162 × 3)', v::text, '486');
  SELECT count(DISTINCT uploaded_by) INTO v FROM pricing_observations
   WHERE city='Corp' AND observed_date=DATE '2026-08-12';
  PERFORM pg_temp.esperar('con los 3 dueños', v::text, '3');
END $$;

\echo ''
\echo '══ [2] EL PUNTO: ¿el dashboard muestra el TRIPLE? ══'

DO $$
DECLARE v_comb int; v_dp bigint; v_min bigint; v_max bigint;
BEGIN
  RESET ROLE;
  PERFORM refresh_ci_aggregates(4000);

  SELECT count(*), sum(observation_count), min(observation_count), max(observation_count)
    INTO v_comb, v_dp, v_min, v_max
    FROM v_bracket_daily_avg_mv
   WHERE city='Corp' AND country='Peru' AND observed_date=DATE '2026-08-12'
     AND data_source='manual';

  -- 162 combinaciones distintas de (turno × tramo × competidor), cada una con
  -- las 3 mediciones adentro.
  PERFORM pg_temp.esperar('el dashboard ve 162 combinaciones', v_comb::text, '162');
  PERFORM pg_temp.esperar('y 486 datapoints en total', v_dp::text, '486');
  PERFORM pg_temp.esperar('CADA celda con 3 muestras (mínimo)', v_min::text, '3');
  PERFORM pg_temp.esperar('CADA celda con 3 muestras (máximo)', v_max::text, '3');
END $$;

DO $$
DECLARE v numeric; v_esp numeric;
BEGIN
  RESET ROLE;
  -- El promedio tiene que ser el de las TRES mediciones, no el del último que
  -- guardó. Para 'short' (posición 2): 8 + 2*2.5 = 13 · +0 / +1,5 / +3
  -- → (13 + 14,5 + 16) / 3 = 14,5
  SELECT round(avg_price,2) INTO v FROM v_bracket_daily_avg_mv
   WHERE city='Corp' AND observed_date=DATE '2026-08-12' AND data_source='manual'
     AND distance_bracket='short' AND competition_name='YangoEconomy'
     AND time_of_day='Morning';
  PERFORM pg_temp.esperar('el promedio es el de las 3, no el del último', v::text, '14.50');
END $$;

\echo ''
\echo '══ [3] Un solo hub habría dado un tercio ══'

DO $$
DECLARE v bigint;
BEGIN
  RESET ROLE;
  -- Control: el mismo día con UN solo hub. Es lo que el dashboard mostraba
  -- hasta ahora, y la referencia contra la que se compara el triple.
  PERFORM pg_temp.completar_corp('sim.raisa@local.test', DATE '2026-08-13', 0);
  RESET ROLE;
  PERFORM refresh_ci_aggregates(4000);

  SELECT sum(observation_count) INTO v FROM v_bracket_daily_avg_mv
   WHERE city='Corp' AND observed_date=DATE '2026-08-13' AND data_source='manual';
  PERFORM pg_temp.esperar('con UN hub: 162 datapoints', v::text, '162');

  SELECT sum(observation_count) INTO v FROM v_bracket_daily_avg_mv
   WHERE city='Corp' AND observed_date=DATE '2026-08-12' AND data_source='manual';
  PERFORM pg_temp.esperar('con TRES hubs: 486 datapoints = exactamente el triple', v::text, '486');
END $$;

\echo ''
\echo '✓ simulate-corp-dashboard-triple: el dashboard SÍ refleja las 3 mediciones'

ROLLBACK;
