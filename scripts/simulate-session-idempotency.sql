-- ════════════════════════════════════════════════════════════════════════
-- simulate-session-idempotency.sql — el cierre de sesión frente a un
-- reintento de red (mig 197, SESIONES_HALLAZGOS.md P2-11).
-- Correr contra Supabase LOCAL, nunca producción.
--
--   npm run simulate:session-idempotency
--
-- LA PREGUNTA QUE RESPONDE: ¿la base distingue "reintento del mismo cierre"
-- de "cierre nuevo"? Las dos respuestas equivocadas son caras y opuestas:
--
--   · si el reintento inserta   → dos filas para el mismo cierre y la
--     duración se cuenta dos veces en cualquier agregado (el bug de hoy,
--     con evidencia en producción);
--   · si el cierre nuevo NO inserta → la revisión del hub se pierde en
--     silencio, que es peor que el duplicado.
--
-- Todo corre como `authenticated` con JWT simulado y RLS activo: probarlo
-- como `postgres` demostraría que la función anda, no que el hub puede
-- usarla — y ese atajo es exactamente el que CLAUDE.md §3 prohíbe.
--
-- Todo va dentro de una transacción que se REVIERTE al final: no deja filas
-- de prueba. No toca auth.users (CLAUDE.md §2).
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

\set ON_ERROR_STOP on
\pset pager off

-- ── Utilidades ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION pg_temp.esperar(p_caso text, p_obtenido boolean, p_esperado boolean)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_obtenido IS DISTINCT FROM p_esperado THEN
    RAISE EXCEPTION E'\n  ✗ FALLA: %\n    esperado=% obtenido=%', p_caso, p_esperado, p_obtenido;
  ELSE
    RAISE NOTICE '  ok  %', p_caso;
  END IF;
END $$;

-- El payload que manda el cliente. Un solo lugar para armarlo: si mañana se
-- agrega una columna, los 3 escenarios la reciben igual.
CREATE OR REPLACE FUNCTION pg_temp.payload(p_email text, p_zone text DEFAULT NULL, p_rows int DEFAULT 324)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'country', 'Peru',
    'city', 'Arequipa',
    'zone', p_zone,
    'observed_date', '2026-08-01',
    'user_email', p_email,
    'started_at', '2026-08-01T09:00:00Z',
    'ended_at', '2026-08-01T10:40:00Z',
    'duration_minutes', 100,
    'duration_confiable', true,
    'rows_saved', p_rows,
    'total_expected', 324,
    'turno_timings', jsonb_build_object(
      'Mañana', jsonb_build_object('startedAt','2026-08-01T09:00:00Z','endedAt','2026-08-01T10:40:00Z')),
    'active_minutes', 88,
    'idle_minutes', 12,
    'activity_trace', '[{"inicio":1754038800000,"fin":1754044800000}]'::jsonb
  );
$$;

-- Cierra como ese hub, con RLS puesto. Devuelve el jsonb de la RPC.
CREATE OR REPLACE FUNCTION pg_temp.cerrar(p_email text, p_token uuid, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE v_out jsonb;
BEGIN
  EXECUTE format('SET LOCAL request.jwt.claims TO %L',
                 json_build_object('email', p_email, 'role', 'authenticated')::text);
  SET LOCAL ROLE authenticated;
  SELECT close_ci_session(p_token, p_payload) INTO v_out;
  RESET ROLE;
  RETURN v_out;
END $$;

-- Igual que la anterior pero para los caminos que DEBEN fallar: devuelve el
-- SQLSTATE en vez de propagar la excepción.
CREATE OR REPLACE FUNCTION pg_temp.cerrar_falla(p_email text, p_token uuid, p_payload jsonb)
RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('SET LOCAL request.jwt.claims TO %L',
                 json_build_object('email', p_email, 'role', 'authenticated')::text);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM close_ci_session(p_token, p_payload);
    RESET ROLE;
    RETURN 'sin_error';
  EXCEPTION WHEN others THEN
    RESET ROLE;
    RETURN SQLSTATE;
  END;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.filas(p_email text)
RETURNS int LANGUAGE sql AS $$
  SELECT count(*)::int FROM ci_sessions
  WHERE user_email = p_email AND observed_date = '2026-08-01' AND city = 'Arequipa';
$$;

\echo ''
\echo '════ 1. Reintento exacto: NO debe duplicar ════'
-- El caso real: el servidor insertó, la respuesta se perdió, el hub ve "no se
-- pudo cerrar" y vuelve a apretar Terminar. Mismo token, siempre.
DO $$
DECLARE
  v_tok  uuid := '11111111-1111-4111-8111-111111111111';
  v_mail text := 'hub.uno@local.test';
  v_a    jsonb;
  v_b    jsonb;
  v_c    jsonb;
BEGIN
  v_a := pg_temp.cerrar(v_mail, v_tok, pg_temp.payload(v_mail));
  PERFORM pg_temp.esperar('el primer cierre inserta', (v_a->>'duplicado')::boolean, false);
  PERFORM pg_temp.esperar('y devuelve un id', (v_a->>'id') IS NOT NULL, true);

  -- Reintento a los 47 segundos, que es la distancia real medida entre las
  -- dos filas duplicadas de producción.
  v_b := pg_temp.cerrar(v_mail, v_tok, pg_temp.payload(v_mail));
  PERFORM pg_temp.esperar('el reintento se reconoce como duplicado', (v_b->>'duplicado')::boolean, true);
  PERFORM pg_temp.esperar('y devuelve el MISMO id, no uno nuevo', v_b->>'id' = v_a->>'id', true);

  -- Un tercer reintento (el hub insiste) tampoco.
  v_c := pg_temp.cerrar(v_mail, v_tok, pg_temp.payload(v_mail));
  PERFORM pg_temp.esperar('el tercer reintento tampoco inserta', v_c->>'id' = v_a->>'id', true);

  PERFORM pg_temp.esperar('quedó UNA sola fila', pg_temp.filas(v_mail) = 1, true);
END $$;

\echo ''
\echo '════ 1b. El reintento no puede pisar la fila ya escrita ════'
-- Un reintento con datos distintos (el hub siguió tocando la grilla entre el
-- primer envío y el segundo) NO debe modificar la fila original: el cierre
-- que quedó registrado es el primero, y el rastro tiene que ser fiel.
DO $$
DECLARE
  v_tok  uuid := '11111111-1111-4111-8111-111111111111';
  v_mail text := 'hub.uno@local.test';
  v_rows int;
BEGIN
  PERFORM pg_temp.cerrar(v_mail, v_tok, pg_temp.payload(v_mail, NULL, 999));
  SELECT rows_saved INTO v_rows FROM ci_sessions WHERE close_token = v_tok;
  PERFORM pg_temp.esperar('la fila original queda intacta (324, no 999)', v_rows = 324, true);
  PERFORM pg_temp.esperar('y sigue habiendo una sola fila', pg_temp.filas(v_mail) = 1, true);
END $$;

\echo ''
\echo '════ 2. Cierre legítimamente nuevo: SÍ debe insertar ════'
-- El hub reabre la sesión del historial para corregir una celda y vuelve a
-- terminar. Mismo hub, misma ciudad, misma fecha — pero es un cierre nuevo, y
-- ese rastro de revisiones es deliberado. Es lo que una constraint única
-- ingenua sobre (city, zone, date, user) habría matado en silencio.
DO $$
DECLARE
  v_mail text := 'hub.uno@local.test';
  v_out  jsonb;
BEGIN
  v_out := pg_temp.cerrar(v_mail, '22222222-2222-4222-8222-222222222222', pg_temp.payload(v_mail));
  PERFORM pg_temp.esperar('un token nuevo SÍ inserta', (v_out->>'duplicado')::boolean, false);
  PERFORM pg_temp.esperar('quedan DOS filas: el cierre y su revisión', pg_temp.filas(v_mail) = 2, true);

  -- Y el reintento de ESA revisión tampoco duplica.
  v_out := pg_temp.cerrar(v_mail, '22222222-2222-4222-8222-222222222222', pg_temp.payload(v_mail));
  PERFORM pg_temp.esperar('el reintento de la revisión se ignora', (v_out->>'duplicado')::boolean, true);
  PERFORM pg_temp.esperar('siguen siendo dos filas', pg_temp.filas(v_mail) = 2, true);
END $$;

\echo ''
\echo '════ 2b. Aeropuerto "Ambos": dos cierres del mismo hub a la vez ════'
-- Punto A y Punto B se cierran con segundos de diferencia y son cierres
-- DISTINTOS. Si compartieran token, el segundo se descartaría como duplicado
-- y el hub perdería un frente entero de trabajo sin enterarse.
DO $$
DECLARE
  v_mail text := 'hub.aeropuerto@local.test';
  v_a    jsonb;
  v_b    jsonb;
BEGIN
  v_a := pg_temp.cerrar(v_mail, '33333333-3333-4333-8333-33333333333a', pg_temp.payload(v_mail, 'Punto A'));
  v_b := pg_temp.cerrar(v_mail, '33333333-3333-4333-8333-33333333333b', pg_temp.payload(v_mail, 'Punto B'));
  PERFORM pg_temp.esperar('Punto A inserta', (v_a->>'duplicado')::boolean, false);
  PERFORM pg_temp.esperar('Punto B inserta (no se toma por reintento de A)', (v_b->>'duplicado')::boolean, false);
  PERFORM pg_temp.esperar('dos filas, una por punto', pg_temp.filas(v_mail) = 2, true);
END $$;

\echo ''
\echo '════ 3. Dos hubs distintos cerrando a la vez ════'
-- Intercalados a propósito (A abre, B cierra, A reintenta, B reintenta): si
-- el índice único estuviera puesto sobre la identidad del bucket en vez de
-- sobre el token, el cierre del segundo hub rebotaría contra el del primero.
DO $$
DECLARE
  v_a    text := 'hub.dos@local.test';
  v_b    text := 'hub.tres@local.test';
  v_ta   uuid := '44444444-4444-4444-8444-44444444444a';
  v_tb   uuid := '44444444-4444-4444-8444-44444444444b';
  v_r1   jsonb;
  v_r2   jsonb;
  v_r3   jsonb;
  v_r4   jsonb;
BEGIN
  v_r1 := pg_temp.cerrar(v_a, v_ta, pg_temp.payload(v_a));
  v_r2 := pg_temp.cerrar(v_b, v_tb, pg_temp.payload(v_b));
  v_r3 := pg_temp.cerrar(v_a, v_ta, pg_temp.payload(v_a));
  v_r4 := pg_temp.cerrar(v_b, v_tb, pg_temp.payload(v_b));

  PERFORM pg_temp.esperar('el hub A inserta', (v_r1->>'duplicado')::boolean, false);
  PERFORM pg_temp.esperar('el hub B inserta, sin chocar con A', (v_r2->>'duplicado')::boolean, false);
  PERFORM pg_temp.esperar('el reintento de A es duplicado de A', v_r3->>'id' = v_r1->>'id', true);
  PERFORM pg_temp.esperar('el reintento de B es duplicado de B', v_r4->>'id' = v_r2->>'id', true);
  PERFORM pg_temp.esperar('una fila para A', pg_temp.filas(v_a) = 1, true);
  PERFORM pg_temp.esperar('una fila para B', pg_temp.filas(v_b) = 1, true);
END $$;

\echo ''
\echo '════ 4. RLS sigue mandando ════'
DO $$
DECLARE
  v_a text := 'hub.dos@local.test';
  v_b text := 'hub.tres@local.test';
BEGIN
  -- Un hub no puede registrar el cierre de OTRO. La función es SECURITY
  -- INVOKER justamente para que esto lo decida la política, no la función.
  PERFORM pg_temp.esperar(
    'un hub no puede cerrar la sesión de otro (42501)',
    pg_temp.cerrar_falla(v_a, '55555555-5555-4555-8555-555555555555',
                         pg_temp.payload(v_b)) = '42501',
    true);

  -- Sin token no hay idempotencia posible: se rechaza ruidosamente en vez de
  -- insertar una fila que el próximo reintento va a duplicar igual.
  PERFORM pg_temp.esperar(
    'sin close_token la RPC falla (22004)',
    pg_temp.cerrar_falla(v_a, NULL, pg_temp.payload(v_a)) = '22004',
    true);

  -- Token de otro usuario: el INSERT no hace nada por el índice único y el
  -- SELECT posterior no lo ve por RLS. Tiene que gritar, no devolver OK — un
  -- OK acá sería un cierre real perdido en silencio.
  PERFORM pg_temp.esperar(
    'un token ajeno no se traga en silencio (23505)',
    pg_temp.cerrar_falla(v_b, '44444444-4444-4444-8444-44444444444a',
                         pg_temp.payload(v_b)) = '23505',
    true);
END $$;

\echo ''
\echo '════ 5. La fila que queda es la correcta ════'
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM ci_sessions
   WHERE close_token = '11111111-1111-4111-8111-111111111111';

  PERFORM pg_temp.esperar('guarda el token', r.close_token IS NOT NULL, true);
  PERFORM pg_temp.esperar('guarda los minutos activos', r.active_minutes = 88, true);
  PERFORM pg_temp.esperar('guarda los minutos descontados', r.idle_minutes = 12, true);
  PERFORM pg_temp.esperar('guarda la traza para poder recalibrar', jsonb_array_length(r.activity_trace) = 1, true);
  PERFORM pg_temp.esperar('la duración de pared sigue estando', r.duration_minutes = 100, true);
  -- El trigger de la mig 195 sigue funcionando por este camino nuevo.
  PERFORM pg_temp.esperar('la marca de confianza se conserva', r.duration_confiable, true);
END $$;

\echo ''
\echo '════ 6. Compatibilidad hacia atrás ════'
-- El INSERT directo del bundle viejo (sin token) tiene que seguir andando
-- durante todo el período en que conviven las dos versiones (CLAUDE.md §4).
-- Sigue duplicando —no hay magia— pero no se rompe.
DO $$
DECLARE v_mail text := 'hub.viejo@local.test';
BEGIN
  EXECUTE format('SET LOCAL request.jwt.claims TO %L',
                 json_build_object('email', v_mail, 'role', 'authenticated')::text);
  SET LOCAL ROLE authenticated;
  INSERT INTO ci_sessions (country, city, observed_date, user_email, started_at, ended_at,
                           duration_minutes, rows_saved)
  VALUES ('Peru','Arequipa','2026-08-01', v_mail, now(), now(), 100, 324);
  INSERT INTO ci_sessions (country, city, observed_date, user_email, started_at, ended_at,
                           duration_minutes, rows_saved)
  VALUES ('Peru','Arequipa','2026-08-01', v_mail, now(), now(), 100, 324);
  RESET ROLE;

  PERFORM pg_temp.esperar('dos filas sin token conviven (NULL no colisiona)',
                          pg_temp.filas(v_mail) = 2, true);
END $$;

\echo ''
\echo '════ 7. Permisos e higiene ════'
DO $$
DECLARE v_ok boolean;
BEGIN
  PERFORM pg_temp.esperar('anon NO puede cerrar sesiones',
    has_function_privilege('anon', 'public.close_ci_session(uuid,jsonb)', 'EXECUTE'), false);
  PERFORM pg_temp.esperar('authenticated sí puede',
    has_function_privilege('authenticated', 'public.close_ci_session(uuid,jsonb)', 'EXECUTE'), true);

  -- search_path fijo: un search_path mutable en una función expuesta es una
  -- vía de escalación clásica (CLAUDE.md §3).
  SELECT proconfig @> ARRAY['search_path=public, pg_temp'] INTO v_ok
    FROM pg_proc WHERE oid = 'public.close_ci_session(uuid,jsonb)'::regprocedure;
  PERFORM pg_temp.esperar('close_ci_session fija search_path', v_ok, true);

  -- Una sola función con ese nombre: dos firmas serían el overload que
  -- PostgREST no puede resolver (PGRST203).
  SELECT count(*) = 1 INTO v_ok FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'close_ci_session';
  PERFORM pg_temp.esperar('no hay overloads de close_ci_session', v_ok, true);

  -- El índice único, que es lo que sostiene todo lo anterior.
  SELECT count(*) = 1 INTO v_ok FROM pg_indexes
   WHERE schemaname='public' AND tablename='ci_sessions' AND indexname='uniq_ci_sessions_close_token';
  PERFORM pg_temp.esperar('el índice único de close_token existe', v_ok, true);

  -- Y que no haya quedado drift de políticas por este cambio.
  SELECT count(*) = 0 INTO v_ok FROM (
    SELECT tablename, cmd FROM pg_policies
     WHERE schemaname='public' AND tablename='ci_sessions'
     GROUP BY tablename, cmd HAVING count(*) > 1) x;
  PERFORM pg_temp.esperar('ci_sessions sin políticas duplicadas por comando', v_ok, true);
END $$;

\echo ''
\echo '✓ simulación de idempotencia del cierre: todo en verde'

-- Nada de esto queda en la base.
ROLLBACK;
