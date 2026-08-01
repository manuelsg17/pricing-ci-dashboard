-- ════════════════════════════════════════════════════════════════════════
-- simulate-two-tabs.sql — simulación del guard de concurrencia (mig 191).
-- Correr contra Supabase LOCAL, nunca producción.
--
--   docker exec -i supabase_db_pricing-ci-dashboard psql -U postgres -X \
--     < scripts/simulate-two-tabs.sql
--
-- LA PREGUNTA: ¿el guard frena la pérdida de datos entre dos pestañas SIN
-- generar falsas alarmas en los flujos normales?
--
-- Las falsas alarmas importan tanto como el bug: si el hub ve "conflicto"
-- cuando no lo hay, aprende a ignorar el cartel y el guard deja de servir.
-- Por eso hay tantos casos de "esto NO debe conflictuar" como de "esto SÍ".
--
-- Todo dentro de una transacción que se revierte.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;
\set ON_ERROR_STOP on
\pset pager off

CREATE OR REPLACE FUNCTION pg_temp.esperar(p_caso text, p_ok boolean)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT p_ok THEN RAISE EXCEPTION E'\n  ✗ FALLA: %', p_caso;
  ELSE RAISE NOTICE '  ok  %', p_caso; END IF;
END $$;

-- Guarda un lote y devuelve el seq nuevo, o -1 si el guard lo frenó.
CREATE OR REPLACE FUNCTION pg_temp.guardar(
  p_sid text, p_expected bigint, p_precio numeric,
  p_zone text DEFAULT NULL, p_force boolean DEFAULT false
) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE res jsonb;
BEGIN
  res := save_ci_batch(
    'Peru', 'Lima', DATE '2026-08-01', p_zone, 'hub.dos.tabs@local.test',
    jsonb_build_array(jsonb_build_object(
      'category','TukTuk','timeslot','Morning','bracket','short',
      'point_a',NULL,'point_b',NULL,'competitors',jsonb_build_array('Yango'))),
    jsonb_build_array(jsonb_build_object(
      'country','Peru','city','Lima','observed_date','2026-08-01',
      'category','TukTuk','competition_name','Yango',
      'price_without_discount', p_precio,
      'distance_bracket','short','timeslot','Morning','zone', p_zone,
      'data_source','manual','uploaded_by','hub.dos.tabs@local.test','no_data',false)),
    p_sid, p_expected, p_force);
  RETURN (res->>'seq')::bigint;
EXCEPTION WHEN sqlstate '55006' THEN
  RETURN -1;
END $$;

-- Un hub con acceso a Perú.
INSERT INTO roles (name, label, permissions)
VALUES ('qa_tabs','QA tabs','{"sections":["dataentry"],"countries":["Peru"]}'::jsonb);
INSERT INTO user_profiles (email, first_name, last_name, role_id, is_active)
VALUES ('hub.dos.tabs@local.test','QA','Tabs',(SELECT id FROM roles WHERE name='qa_tabs'), true);

SET LOCAL request.jwt.claims TO '{"email":"hub.dos.tabs@local.test","role":"authenticated"}';
SET LOCAL ROLE authenticated;

\echo ''
\echo '════ 1. Una sola pestaña: nada debe conflictuar ════'
DO $$
DECLARE s1 bigint; s2 bigint; s3 bigint;
BEGIN
  -- Primer guardado: no hay marca previa.
  s1 := pg_temp.guardar('tab-A', NULL, 10);
  PERFORM pg_temp.esperar('primer guardado pasa', s1 = 1);

  -- Segundo guardado de la MISMA pestaña, con la marca al día.
  s2 := pg_temp.guardar('tab-A', s1, 11);
  PERFORM pg_temp.esperar('segundo guardado de la misma pestaña pasa', s2 = 2);

  -- EL CASO QUE NO PUEDE FALLAR: reintento tras un timeout de red. El
  -- cliente no sabe si el primer intento llegó, así que reintenta con la
  -- marca VIEJA. Misma pestaña ⇒ tiene que pasar igual.
  s3 := pg_temp.guardar('tab-A', s1, 12);
  PERFORM pg_temp.esperar('reintento con marca vieja, misma pestaña: PASA', s3 = 3);

  -- Doble click en Guardar: dos llamadas idénticas seguidas.
  PERFORM pg_temp.esperar('doble click en Guardar no conflictúa',
    pg_temp.guardar('tab-A', s3, 12) = 4);
END $$;

\echo ''
\echo '════ 2. Dos pestañas en el MISMO bucket: el guard frena ════'
DO $$
DECLARE sA bigint; sB bigint;
BEGIN
  -- La pestaña B se abrió ANTES de que A guardara, así que su marca quedó
  -- vieja. Es exactamente el escenario del reporte.
  sB := pg_temp.guardar('tab-B', 1, 99);
  PERFORM pg_temp.esperar('pestaña B con marca vieja: FRENADA', sB = -1);

  -- Y lo más importante: no borró nada. El precio de A sigue en la base.
  PERFORM pg_temp.esperar('la data de la pestaña A sobrevivió intacta',
    (SELECT price_without_discount FROM pricing_observations
      WHERE observed_date = DATE '2026-08-01'
        AND uploaded_by = 'hub.dos.tabs@local.test') = 12);

  PERFORM pg_temp.esperar('y no quedaron filas duplicadas',
    (SELECT count(*) FROM pricing_observations
      WHERE observed_date = DATE '2026-08-01'
        AND uploaded_by = 'hub.dos.tabs@local.test') = 1);
END $$;

\echo ''
\echo '════ 3. La pestaña B se sincroniza y ahí sí puede ════'
DO $$
DECLARE actual bigint; sB bigint;
BEGIN
  -- "Traer lo último": B lee la marca actual del servidor.
  SELECT write_seq INTO actual FROM ci_bucket_writes
   WHERE user_email='hub.dos.tabs@local.test' AND city='Lima';
  sB := pg_temp.guardar('tab-B', actual, 55);
  PERFORM pg_temp.esperar('tras sincronizarse, la pestaña B guarda bien', sB = actual + 1);
  PERFORM pg_temp.esperar('y ahora el dato es el de B',
    (SELECT price_without_discount FROM pricing_observations
      WHERE observed_date = DATE '2026-08-01'
        AND uploaded_by='hub.dos.tabs@local.test') = 55);
END $$;

\echo ''
\echo '════ 4. Salida de emergencia: p_force ════'
DO $$
DECLARE sA bigint;
BEGIN
  -- A quedó desincronizada, pero el hub confirma que su pantalla es la buena.
  sA := pg_temp.guardar('tab-A', 1, 77, NULL, true);
  PERFORM pg_temp.esperar('con p_force el guardado pasa igual', sA > 0);
END $$;

\echo ''
\echo '════ 5. Buckets DISTINTOS no se estorban (falsas alarmas) ════'
DO $$
BEGIN
  -- Dos pestañas en distritos distintos de TukTuk es un flujo LEGÍTIMO y
  -- común. Si esto conflictuara, el guard sería inusable.
  PERFORM pg_temp.esperar('pestaña en Comas: primer guardado pasa',
    pg_temp.guardar('tab-C', NULL, 20, 'Comas') = 1);
  PERFORM pg_temp.esperar('pestaña en SJM: NO la afecta la de Comas',
    pg_temp.guardar('tab-D', NULL, 21, 'SJM') = 1);
  PERFORM pg_temp.esperar('Comas sigue pudiendo guardar',
    pg_temp.guardar('tab-C', 1, 22, 'Comas') = 2);
END $$;

\echo ''
\echo '════ 6. Bundle VIEJO (sin identidad de pestaña) sigue funcionando ════'
DO $$
BEGIN
  -- Un hub con la pestaña abierta desde ayer manda p_session_id = NULL.
  -- Tiene que pasar igual que antes: desplegar el guard no puede romperlo.
  PERFORM pg_temp.esperar('sin session_id: pasa (paso "expandir" de §4)',
    pg_temp.guardar(NULL, NULL, 33) IS NULL);
END $$;

\echo ''
\echo '════ 7. Seguridad de la tabla nueva ════'
RESET ROLE;
DO $$
DECLARE v_pol int; v_anon boolean;
BEGIN
  SELECT count(*) INTO v_pol FROM pg_policies
   WHERE tablename='ci_bucket_writes' AND cmd <> 'SELECT';
  PERFORM pg_temp.esperar('sin políticas de escritura (solo entra por la RPC)', v_pol = 0);

  SELECT has_table_privilege('anon','ci_bucket_writes','SELECT') INTO v_anon;
  PERFORM pg_temp.esperar('anon no lee la tabla', v_anon = false);

  PERFORM pg_temp.esperar('save_ci_batch tiene UNA sola firma (sin PGRST203)',
    (SELECT count(*) FROM pg_proc WHERE proname='save_ci_batch') = 1);

  PERFORM pg_temp.esperar('save_ci_batch sigue siendo INVOKER',
    (SELECT prosecdef FROM pg_proc WHERE proname='save_ci_batch') = false);

  PERFORM pg_temp.esperar('el guard es DEFINER con search_path fijado',
    (SELECT proconfig FROM pg_proc WHERE proname='ci_bucket_write_guard')
      = ARRAY['search_path=public, pg_temp']);
END $$;

\echo ''
\echo '✓ TODAS LAS SIMULACIONES DE DOS PESTAÑAS PASARON'
ROLLBACK;
