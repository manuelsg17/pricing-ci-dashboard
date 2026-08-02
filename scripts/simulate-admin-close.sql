-- ════════════════════════════════════════════════════════════════════════
-- simulate-admin-close.sql — mig 198. Contra Supabase LOCAL.
--
--   docker exec -i supabase_db_pricing-ci-dashboard psql -U postgres -X \
--     < scripts/simulate-admin-close.sql
--
-- LA PREGUNTA: ¿el doble clic del admin deja de duplicar SIN descartar un
-- cierre legítimo?
--
-- Las dos mitades importan igual. Un cierre descartado en silencio es PEOR
-- que un duplicado: el duplicado se ve en los números, el descarte no.
--
-- Todo dentro de una transacción que se revierte.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;
\set ON_ERROR_STOP on
\pset pager off

CREATE OR REPLACE FUNCTION pg_temp.esperar(p_caso text, p_obtenido anyelement, p_esperado anyelement)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_obtenido IS DISTINCT FROM p_esperado THEN
    RAISE EXCEPTION E'\n  ✗ FALLA: %\n    esperado=% obtenido=%', p_caso, p_esperado, p_obtenido;
  END IF;
  RAISE NOTICE '  ok  %', p_caso;
END $$;

-- Se REUSA el rol admin que ya existe: `is_admin()` mira el nombre del rol,
-- así que crear uno nuevo y renombrarlo choca con la clave única.
INSERT INTO user_profiles (email, first_name, last_name, role_id, is_active)
VALUES ('qa.admin@local.test', 'QA', 'Admin',
        (SELECT id FROM roles WHERE name='admin'), true);

SELECT set_config('request.jwt.claims',
  '{"email":"qa.admin@local.test","role":"authenticated"}', true);

-- Helper: crea el latido de una sesión abierta.
CREATE OR REPLACE FUNCTION pg_temp.abrir_sesion(p_zone text, p_ini timestamptz)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO ci_active_sessions (user_email, country, city, zone, observed_date,
    started_at, last_seen_at, turno_progress, total_expected)
  VALUES ('hub.qa@local.test','Peru','Lima', p_zone, DATE '2026-08-01',
    p_ini, now(),
    jsonb_build_object('timings', jsonb_build_object('Mañana', jsonb_build_object(
      'startedAt', p_ini::text, 'endedAt', (p_ini + interval '50 min')::text))), 108)
  ON CONFLICT (user_email) DO UPDATE SET
    zone = EXCLUDED.zone, started_at = EXCLUDED.started_at,
    turno_progress = EXCLUDED.turno_progress, last_seen_at = now();
END $$;

\echo ''
\echo '════ 1. Primer clic: cierra de verdad ════'
DO $$
DECLARE r jsonb;
BEGIN
  PERFORM pg_temp.abrir_sesion('A', '2026-08-01T09:00:00Z');
  r := admin_close_ci_session('Peru','Lima','A', DATE '2026-08-01','hub.qa@local.test');
  PERFORM pg_temp.esperar('el primer clic cierra', (r->>'cerrada')::boolean, true);
  PERFORM pg_temp.esperar('  y no es duplicado', (r->>'duplicado')::boolean, false);
  PERFORM pg_temp.esperar('  insertó UNA fila',
    (SELECT count(*)::int FROM ci_sessions WHERE zone='A'), 1);
  PERFORM pg_temp.esperar('  y borró el latido',
    (SELECT count(*)::int FROM ci_active_sessions WHERE user_email='hub.qa@local.test'), 0);
  PERFORM pg_temp.esperar('  con la duración real de los turnos (50 min)',
    (SELECT duration_minutes FROM ci_sessions WHERE zone='A'), 50.0::numeric);
  PERFORM pg_temp.esperar('  marcada como confiable',
    (SELECT duration_confiable FROM ci_sessions WHERE zone='A'), true);
END $$;

\echo ''
\echo '════ 2. EL BUG: el segundo clic ya NO duplica ════'
DO $$
DECLARE r jsonb;
BEGIN
  r := admin_close_ci_session('Peru','Lima','A', DATE '2026-08-01','hub.qa@local.test');
  PERFORM pg_temp.esperar('el segundo clic NO cierra', (r->>'cerrada')::boolean, false);
  PERFORM pg_temp.esperar('  se reporta como duplicado', (r->>'duplicado')::boolean, true);
  PERFORM pg_temp.esperar('  SIGUE habiendo UNA sola fila',
    (SELECT count(*)::int FROM ci_sessions WHERE zone='A'), 1);
  -- Devuelve el id del cierre anterior, para que la pantalla muestre algo
  -- coherente en vez de un error.
  PERFORM pg_temp.esperar('  y devuelve el id del cierre anterior',
    (r->>'id')::bigint, (SELECT id::bigint FROM ci_sessions WHERE zone='A'));
END $$;

\echo ''
\echo '════ 3. Diez clics seguidos (el admin nervioso) ════'
DO $$ BEGIN
  FOR i IN 1..10 LOOP
    PERFORM admin_close_ci_session('Peru','Lima','A', DATE '2026-08-01','hub.qa@local.test');
  END LOOP;
  PERFORM pg_temp.esperar('10 clics más siguen dejando UNA fila',
    (SELECT count(*)::int FROM ci_sessions WHERE zone='A'), 1);
END $$;

\echo ''
\echo '════ 4. Cierre LEGÍTIMAMENTE nuevo: el hub volvió a trabajar ════'
DO $$
DECLARE r jsonb;
BEGIN
  -- El hub reabre y trabaja de nuevo el MISMO día, misma zona. Es el caso que
  -- una clave determinística por started_at habría descartado en silencio.
  PERFORM pg_temp.abrir_sesion('A', '2026-08-01T15:00:00Z');
  r := admin_close_ci_session('Peru','Lima','A', DATE '2026-08-01','hub.qa@local.test');
  PERFORM pg_temp.esperar('un cierre nuevo SÍ cierra', (r->>'cerrada')::boolean, true);
  PERFORM pg_temp.esperar('  ahora hay DOS filas (el rastro de revisiones)',
    (SELECT count(*)::int FROM ci_sessions WHERE zone='A'), 2);
END $$;

\echo ''
\echo '════ 5. Zonas distintas no se confunden ════'
DO $$ BEGIN
  PERFORM pg_temp.abrir_sesion('B', '2026-08-01T09:00:00Z');
  PERFORM admin_close_ci_session('Peru','Lima','B', DATE '2026-08-01','hub.qa@local.test');
  PERFORM pg_temp.esperar('cerrar la zona B no toca la A',
    (SELECT count(*)::int FROM ci_sessions WHERE zone='A'), 2);
  PERFORM pg_temp.esperar('  y la B tiene su propia fila',
    (SELECT count(*)::int FROM ci_sessions WHERE zone='B'), 1);
END $$;

\echo ''
\echo '════ 6. Cerrar algo que nunca existió no inventa una fila ════'
DO $$
DECLARE r jsonb; v_antes int;
BEGIN
  SELECT count(*)::int INTO v_antes FROM ci_sessions;
  r := admin_close_ci_session('Peru','Lima','NUNCA-EXISTIO', DATE '2026-08-01','hub.qa@local.test');
  PERFORM pg_temp.esperar('sin sesión activa no cierra', (r->>'cerrada')::boolean, false);
  PERFORM pg_temp.esperar('  y NO inserta nada',
    (SELECT count(*)::int FROM ci_sessions), v_antes);
  PERFORM pg_temp.esperar('  el id devuelto es NULL (no hay cierre previo)',
    (r->>'id') IS NULL, true);
END $$;

\echo ''
\echo '════ 7. Sin turnos medibles: duración del reloj, marcada NO confiable ════'
DO $$
DECLARE r jsonb;
BEGIN
  INSERT INTO ci_active_sessions (user_email, country, city, zone, observed_date,
    started_at, last_seen_at, turno_progress, total_expected)
  VALUES ('hub.qa@local.test','Peru','Lima','SIN-TURNOS', DATE '2026-08-01',
    now() - interval '40 min', now(), '{}'::jsonb, 108)
  ON CONFLICT (user_email) DO UPDATE SET
    zone=EXCLUDED.zone, started_at=EXCLUDED.started_at,
    turno_progress=EXCLUDED.turno_progress, last_seen_at=now();

  r := admin_close_ci_session('Peru','Lima','SIN-TURNOS', DATE '2026-08-01','hub.qa@local.test');
  PERFORM pg_temp.esperar('cierra igual', (r->>'cerrada')::boolean, true);
  PERFORM pg_temp.esperar('  pero NO se marca como confiable',
    (SELECT duration_confiable FROM ci_sessions WHERE zone='SIN-TURNOS'), false);
  PERFORM pg_temp.esperar('  con motivo explícito',
    (SELECT duration_motivo IS NOT NULL FROM ci_sessions WHERE zone='SIN-TURNOS'), true);
END $$;

\echo ''
\echo '════ 8. Seguridad ════'
DO $$
DECLARE v_err text;
BEGIN
  -- Un NO admin no puede cerrar sesiones ajenas: se cambia de identidad, no
  -- se toca el rol admin global (eso rompería el resto de la simulación).
  INSERT INTO roles (name,label,permissions)
  VALUES ('qa_solo_hub','QA hub','{"sections":["dataentry"],"countries":["Peru"]}'::jsonb);
  INSERT INTO user_profiles (email,first_name,last_name,role_id,is_active)
  VALUES ('qa.nohub@local.test','Q','A',(SELECT id FROM roles WHERE name='qa_solo_hub'),true);
  PERFORM set_config('request.jwt.claims',
    '{"email":"qa.nohub@local.test","role":"authenticated"}', true);
  BEGIN
    PERFORM admin_close_ci_session('Peru','Lima','A', DATE '2026-08-01','hub.qa@local.test');
    v_err := 'NO FALLÓ';
  EXCEPTION WHEN OTHERS THEN v_err := 'denegado';
  END;
  PERFORM pg_temp.esperar('un no-admin NO puede cerrar', v_err, 'denegado');
  PERFORM set_config('request.jwt.claims',
    '{"email":"qa.admin@local.test","role":"authenticated"}', true);

  PERFORM pg_temp.esperar('una sola firma (sin overload / PGRST203)',
    (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND proname='admin_close_ci_session'), 1);
  PERFORM pg_temp.esperar('anon sin EXECUTE',
    has_function_privilege('anon','admin_close_ci_session(text,text,text,date,text)','EXECUTE'), false);
  PERFORM pg_temp.esperar('search_path fijado',
    (SELECT proconfig FROM pg_proc WHERE proname='admin_close_ci_session'),
    ARRAY['search_path=public, pg_temp']);
END $$;

\echo ''
\echo '════ 9. Por el ROL REAL, no como postgres ════'
-- LA LECCIÓN DE LA MIG 199. Todo lo de arriba corre como `postgres`, que tiene
-- EXECUTE sobre absolutamente todo. Eso alcanza para probar que el SQL compila
-- y que la lógica es correcta, pero NO prueba que un hub o un admin de verdad
-- pueda ejecutarlo: el cliente llega por PostgREST como rol `authenticated`.
--
-- Ese hueco dejó a los hubs sin poder cerrar sesión en producción el
-- 2026-08-01: el trigger de la mig 195 llamaba a helpers sin EXECUTE para
-- `authenticated` y moría con 42501, mientras esta clase de simulación seguía
-- toda en verde.
DO $$
DECLARE v_antes int; v_r jsonb;
BEGIN
  SELECT count(*)::int INTO v_antes FROM ci_sessions WHERE zone = 'ROL-REAL';
  PERFORM pg_temp.abrir_sesion('ROL-REAL', '2026-08-01T08:00:00Z');

  PERFORM set_config('request.jwt.claims',
    '{"email":"qa.admin@local.test","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;

  -- Camino completo como lo recorre la pantalla de Monitoreo: EXECUTE sobre la
  -- función + cuerpo SECURITY DEFINER + trigger de calidad sobre el INSERT.
  v_r := admin_close_ci_session('Peru','Lima','ROL-REAL', DATE '2026-08-01','hub.qa@local.test');
  RESET ROLE;

  PERFORM pg_temp.esperar('un admin REAL (rol authenticated) puede cerrar',
    (v_r->>'cerrada')::boolean, true);
  PERFORM pg_temp.esperar('  insertó la fila',
    (SELECT count(*)::int FROM ci_sessions WHERE zone='ROL-REAL'), v_antes + 1);
  -- Si el trigger no pudiera leer los timings (42501), la llamada habría
  -- abortado entera. Que la marca venga completa prueba la cadena entera.
  PERFORM pg_temp.esperar('  y el trigger completó la marca de confianza',
    (SELECT duration_confiable FROM ci_sessions WHERE zone='ROL-REAL'), true);

  -- El doble clic también tiene que ser idempotente por el rol real.
  PERFORM set_config('request.jwt.claims',
    '{"email":"qa.admin@local.test","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  v_r := admin_close_ci_session('Peru','Lima','ROL-REAL', DATE '2026-08-01','hub.qa@local.test');
  RESET ROLE;

  PERFORM pg_temp.esperar('  el segundo clic sigue sin duplicar',
    (SELECT count(*)::int FROM ci_sessions WHERE zone='ROL-REAL'), v_antes + 1);
  PERFORM pg_temp.esperar('  y se reporta como duplicado', (v_r->>'duplicado')::boolean, true);
END $$;

\echo ''
\echo '✓ TODAS LAS SIMULACIONES DEL CIERRE ADMIN PASARON'
ROLLBACK;
