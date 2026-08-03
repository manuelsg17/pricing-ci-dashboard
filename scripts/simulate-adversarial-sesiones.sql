-- ════════════════════════════════════════════════════════════════════════
-- simulate-adversarial-sesiones.sql — intentar QUEBRAR lo implementado.
--
--   npm run simulate:adversarial
--
-- Las otras simulaciones prueban que los caminos felices funcionan. Esta
-- prueba lo contrario: entradas hostiles, bordes exactos, y hubs atacándose
-- entre sí. Todo lo que acá "pasa" es algo que NO se pudo romper.
--
-- Dos reglas que esta batería sí respeta y que otras se saltaron:
--   · Los caminos de ESCRITURA del hub corren con SET LOCAL ROLE authenticated,
--     no como postgres. Correr como superusuario solo prueba que el SQL
--     compila — así se coló el bug de la mig 199.
--   · Un ataque que "falla" tiene que fallar RUIDOSAMENTE. Un cierre que se
--     descarta en silencio es peor que un duplicado: el duplicado se ve.
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
    RAISE EXCEPTION E'\n  ✗ ROTO: %\n    esperado=% obtenido=%', p_caso, p_esperado, p_obtenido;
  END IF;
  RAISE NOTICE '  ok  %', p_caso;
END $$;

-- Dos hubs distintos + un admin. user_profiles, nunca auth.users a mano.
INSERT INTO roles (name, label, permissions) VALUES
  ('adv_hub','ADV hub','{"sections":["dataentry"],"countries":["Peru"]}'::jsonb);
INSERT INTO user_profiles (email, first_name, last_name, role_id, is_active) VALUES
  ('adv.a@local.test','A','A',(SELECT id FROM roles WHERE name='adv_hub'),true),
  ('adv.b@local.test','B','B',(SELECT id FROM roles WHERE name='adv_hub'),true),
  ('adv.admin@local.test','Ad','Min',(SELECT id FROM roles WHERE name='admin'),true);

CREATE OR REPLACE FUNCTION pg_temp.como(p_email text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', p_email, 'role', 'authenticated')::text, true);
END $$;

\echo ''
\echo '════════ 1. DURACIÓN: entradas hostiles ════════'
DO $$
DECLARE f timestamptz := '2026-08-01T20:00:00Z';
BEGIN
  -- jsonb que NO es un objeto. Nada de esto debe hacer explotar el cierre.
  PERFORM pg_temp.esperar('jsonb null → NULL',
    ci_duration_from_timings('null'::jsonb, f), NULL::numeric);
  PERFORM pg_temp.esperar('un ARRAY en vez de objeto → NULL',
    ci_duration_from_timings('[1,2,3]'::jsonb, f), NULL::numeric);
  PERFORM pg_temp.esperar('un string suelto → NULL',
    ci_duration_from_timings('"hola"'::jsonb, f), NULL::numeric);
  PERFORM pg_temp.esperar('objeto vacío → NULL',
    ci_duration_from_timings('{}'::jsonb, f), NULL::numeric);
  -- Valores basura DENTRO de un turno: se ignora el turno, no se aborta.
  PERFORM pg_temp.esperar('startedAt que no es fecha → NULL, sin excepción',
    ci_duration_from_timings('{"M":{"startedAt":"no-soy-fecha","endedAt":"tampoco"}}'::jsonb, f),
    NULL::numeric);
  PERFORM pg_temp.esperar('turno que es un número, no un objeto → se ignora',
    ci_duration_from_timings('{"M":42,"T":{"startedAt":"2026-08-01T10:00:00Z","endedAt":"2026-08-01T10:30:00Z"}}'::jsonb, f),
    30.0::numeric);
  -- SQL injection por la clave del turno: jsonb_each la trata como dato.
  PERFORM pg_temp.esperar('clave con comillas y punto y coma no rompe nada',
    ci_duration_from_timings('{"a''; DROP TABLE ci_sessions; --":{"startedAt":"2026-08-01T10:00:00Z","endedAt":"2026-08-01T10:15:00Z"}}'::jsonb, f),
    15.0::numeric);
  PERFORM pg_temp.esperar('  y la tabla sigue existiendo',
    (SELECT count(*)::int FROM pg_class WHERE relname='ci_sessions'), 1);
END $$;

\echo ''
\echo '════════ 2. DURACIÓN: los bordes exactos ════════'
DO $$
DECLARE f timestamptz := '2026-08-01T23:59:00Z';
BEGIN
  -- El techo de 4h por turno.
  PERFORM pg_temp.esperar('exactamente 4h NO se recorta',
    ci_duration_from_timings('{"M":{"startedAt":"2026-08-01T08:00:00Z","endedAt":"2026-08-01T12:00:00Z"}}'::jsonb, f),
    240.0::numeric);
  PERFORM pg_temp.esperar('  y sigue siendo confiable',
    ci_duration_quality_from_timings('{"M":{"startedAt":"2026-08-01T08:00:00Z","endedAt":"2026-08-01T12:00:00Z"}}'::jsonb, f),
    NULL::text);
  PERFORM pg_temp.esperar('4h + 1 segundo SÍ se recorta a 240',
    ci_duration_from_timings('{"M":{"startedAt":"2026-08-01T08:00:00Z","endedAt":"2026-08-01T12:00:01Z"}}'::jsonb, f),
    240.0::numeric);
  PERFORM pg_temp.esperar('  y se marca turno_recortado',
    ci_duration_quality_from_timings('{"M":{"startedAt":"2026-08-01T08:00:00Z","endedAt":"2026-08-01T12:00:01Z"}}'::jsonb, f),
    'turno_recortado');

  -- Ancho cero: artefacto de grilla que llega completa, no "trabajo instantáneo".
  PERFORM pg_temp.esperar('tramo de ancho CERO → NULL, nunca 0',
    ci_duration_from_timings('{"M":{"startedAt":"2026-08-01T10:00:00Z","endedAt":"2026-08-01T10:00:00Z"}}'::jsonb, f),
    NULL::numeric);

  -- Reloj desincronizado: fin ANTES del inicio.
  PERFORM pg_temp.esperar('fin anterior al inicio → se cierra con el fin de sesión',
    ci_duration_from_timings('{"M":{"startedAt":"2026-08-01T23:00:00Z","endedAt":"2026-08-01T09:00:00Z"}}'::jsonb, f),
    59.0::numeric);
  PERFORM pg_temp.esperar('  y se marca como estimado',
    ci_duration_quality_from_timings('{"M":{"startedAt":"2026-08-01T23:00:00Z","endedAt":"2026-08-01T09:00:00Z"}}'::jsonb, f),
    'turno_estimado');

  -- Unión, no suma.
  PERFORM pg_temp.esperar('turnos SOLAPADOS cuentan una sola vez',
    ci_duration_from_timings('{"M":{"startedAt":"2026-08-01T10:00:00Z","endedAt":"2026-08-01T11:00:00Z"},
                               "T":{"startedAt":"2026-08-01T10:30:00Z","endedAt":"2026-08-01T11:30:00Z"}}'::jsonb, f),
    90.0::numeric);
  PERFORM pg_temp.esperar('turnos CONTIGUOS exactos se fusionan (no se duplica el borde)',
    ci_duration_from_timings('{"M":{"startedAt":"2026-08-01T10:00:00Z","endedAt":"2026-08-01T11:00:00Z"},
                               "T":{"startedAt":"2026-08-01T11:00:00Z","endedAt":"2026-08-01T12:00:00Z"}}'::jsonb, f),
    120.0::numeric);
  PERFORM pg_temp.esperar('turnos SEPARADOS sí se suman por separado',
    ci_duration_from_timings('{"M":{"startedAt":"2026-08-01T08:00:00Z","endedAt":"2026-08-01T09:00:00Z"},
                               "N":{"startedAt":"2026-08-01T20:00:00Z","endedAt":"2026-08-01T21:00:00Z"}}'::jsonb, f),
    120.0::numeric);

  -- Formato epoch-ms (contrato declarado del cliente).
  PERFORM pg_temp.esperar('epoch en milisegundos se entiende igual',
    ci_duration_from_timings(
      jsonb_build_object('M', jsonb_build_object(
        'startedAt', (extract(epoch from timestamptz '2026-08-01T10:00:00Z')*1000)::bigint::text,
        'endedAt',   (extract(epoch from timestamptz '2026-08-01T10:45:00Z')*1000)::bigint::text)), f),
    45.0::numeric);
END $$;

\echo ''
\echo '════════ 3. DURACIÓN: volumen ════════'
DO $$
DECLARE v_j jsonb := '{}'::jsonb; i int;
BEGIN
  -- 200 turnos alternados, la mitad solapando. Si la unión estuviera mal, esto
  -- daría un número disparatado; si fuera O(n²) mal escrito, tardaría.
  FOR i IN 0..199 LOOP
    v_j := v_j || jsonb_build_object('t'||i, jsonb_build_object(
      'startedAt', (timestamptz '2026-08-01T00:00:00Z' + (i * interval '1 min'))::text,
      'endedAt',   (timestamptz '2026-08-01T00:00:00Z' + (i * interval '1 min') + interval '2 min')::text));
  END LOOP;
  -- Cada tramo arranca 1 min después del anterior y dura 2 → todos encadenados.
  -- Unión = desde t0 hasta t199+2min = 201 minutos.
  PERFORM pg_temp.esperar('200 turnos encadenados → unión correcta (201 min)',
    ci_duration_from_timings(v_j, '2026-08-02T00:00:00Z'), 201.0::numeric);
END $$;

\echo ''
\echo '════════ 4. SEGURIDAD: un hub atacando a otro ════════'
DO $$
DECLARE v_err text; v_tok uuid := gen_random_uuid();
        v_payload jsonb; v_r jsonb; v_id int;
BEGIN
  v_payload := jsonb_build_object(
    'country','Peru','city','Lima','zone','ADV',
    'observed_date','2026-08-01','started_at', now()::text, 'ended_at', now()::text,
    'duration_minutes', 30, 'rows_saved', 54, 'total_expected', 54);

  -- (a) A intenta CERRAR una sesión a nombre de B.
  PERFORM pg_temp.como('adv.a@local.test');
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM close_ci_session(gen_random_uuid(),
      v_payload || jsonb_build_object('user_email','adv.b@local.test'));
    v_err := 'NO FALLÓ';
  EXCEPTION WHEN OTHERS THEN v_err := 'denegado';
  END;
  RESET ROLE;
  PERFORM pg_temp.esperar('A NO puede cerrar una sesión a nombre de B', v_err, 'denegado');

  -- (b) A intenta el INSERT directo a nombre de B (el camino del bundle viejo).
  PERFORM pg_temp.como('adv.a@local.test');
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO ci_sessions (country,city,zone,observed_date,user_email,started_at,ended_at,
                             duration_minutes,rows_saved,total_expected)
    VALUES ('Peru','Lima','ADV',DATE '2026-08-01','adv.b@local.test',now(),now(),30,54,54);
    v_err := 'NO FALLÓ';
  EXCEPTION WHEN OTHERS THEN v_err := 'denegado';
  END;
  RESET ROLE;
  PERFORM pg_temp.esperar('A NO puede insertar una fila a nombre de B (RLS)', v_err, 'denegado');

  -- (c) B cierra legítimamente; A intenta REUSAR su close_token.
  PERFORM pg_temp.como('adv.b@local.test');
  SET LOCAL ROLE authenticated;
  v_r := close_ci_session(v_tok, v_payload || jsonb_build_object('user_email','adv.b@local.test'));
  RESET ROLE;
  v_id := (v_r->>'id')::int;
  PERFORM pg_temp.esperar('B cierra lo suyo sin problema', (v_r->>'duplicado')::boolean, false);

  PERFORM pg_temp.como('adv.a@local.test');
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM close_ci_session(v_tok, v_payload || jsonb_build_object('user_email','adv.a@local.test'));
    v_err := 'NO FALLÓ';
  EXCEPTION WHEN OTHERS THEN v_err := 'denegado';
  END;
  RESET ROLE;
  -- Tiene que fallar RUIDOSAMENTE: si se tragara el conflicto, A perdería su
  -- cierre en silencio creyendo que quedó guardado.
  PERFORM pg_temp.esperar('A NO puede reusar el token de B, y falla ruidoso', v_err, 'denegado');
  PERFORM pg_temp.esperar('  y la fila de B quedó intacta',
    (SELECT user_email FROM ci_sessions WHERE id = v_id), 'adv.b@local.test');

  -- (d) A no puede LEER la sesión de B.
  PERFORM pg_temp.como('adv.a@local.test');
  SET LOCAL ROLE authenticated;
  PERFORM pg_temp.esperar('A no ve las sesiones de B',
    (SELECT count(*)::int FROM ci_sessions WHERE user_email='adv.b@local.test'), 0);
  RESET ROLE;

  -- (e) Un hub NO puede cerrar por la puerta del admin.
  PERFORM pg_temp.como('adv.a@local.test');
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM admin_close_ci_session('Peru','Lima','ADV',DATE '2026-08-01','adv.b@local.test');
    v_err := 'NO FALLÓ';
  EXCEPTION WHEN OTHERS THEN v_err := 'denegado';
  END;
  RESET ROLE;
  PERFORM pg_temp.esperar('un hub NO puede usar admin_close_ci_session', v_err, 'denegado');
END $$;

\echo ''
\echo ''
\echo '════════ 5. SEGURIDAD: quién ve los minutos de quién ════════'
DO $$
DECLARE v_err text;
BEGIN
  -- OJO: hasta la mig 201 este bloque afirmaba que un hub común PODÍA leer
  -- ci_hub_daily_minutes de su propio país, y lo daba por correcto. Era la
  -- fuga: esas RPCs son SECURITY DEFINER y devuelven el email, los minutos y
  -- la cantidad de sesiones de TODOS los hubs del país, bypaseando la RLS de
  -- ci_sessions. O sea que esta batería tenía el agujero codificado como
  -- comportamiento esperado. Ahora son solo-admin.
  PERFORM pg_temp.como('adv.a@local.test');   -- hub NO admin, países=['Peru']
  SET LOCAL ROLE authenticated;

  BEGIN
    PERFORM * FROM ci_hub_daily_minutes('Peru', DATE '2026-07-01', DATE '2026-08-01');
    v_err := 'NO FALLÓ';
  EXCEPTION WHEN OTHERS THEN v_err := 'denegado';
  END;
  PERFORM pg_temp.esperar('un hub NO admin no ve minutos ajenos, ni de su país', v_err, 'denegado');

  BEGIN
    PERFORM * FROM ci_turno_minutes('Peru', DATE '2026-07-01', DATE '2026-08-01');
    v_err := 'NO FALLÓ';
  EXCEPTION WHEN OTHERS THEN v_err := 'denegado';
  END;
  PERFORM pg_temp.esperar('  ni los tiempos por turno', v_err, 'denegado');
  RESET ROLE;

  -- El admin sí, que es para quien existe la pantalla.
  PERFORM pg_temp.como('adv.admin@local.test');
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM * FROM ci_hub_daily_minutes('Peru', DATE '2026-07-01', DATE '2026-08-01');
    v_err := 'permitido';
  EXCEPTION WHEN OTHERS THEN v_err := 'FALLÓ PARA EL ADMIN';
  END;
  PERFORM pg_temp.esperar('  el admin sí', v_err, 'permitido');
  RESET ROLE;
END $$;

\echo ''
\echo '════════ 5b. SEGURIDAD: cruce de países donde el hub SÍ llega ════════'
DO $$
DECLARE v_err text;
BEGIN
  -- El aislamiento por país se sigue probando, pero por una RPC que un hub
  -- común pueda llamar. En ci_hub_daily_minutes ya no aplica: solo llegan
  -- admins, y el rol admin tiene countries=['all'], así que su
  -- require_country_access quedó inalcanzable (defensa en profundidad, por si
  -- mañana se le acotan los países al rol admin).
  PERFORM pg_temp.como('adv.a@local.test');
  SET LOCAL ROLE authenticated;

  BEGIN
    PERFORM close_ci_session(gen_random_uuid(), jsonb_build_object(
      'country','Colombia','city','Bogota','observed_date','2026-08-01',
      'user_email','adv.a@local.test','started_at', now()::text,
      'ended_at', now()::text, 'duration_minutes', 30,
      'rows_saved', 10, 'total_expected', 10));
    v_err := 'NO FALLÓ';
  EXCEPTION WHEN OTHERS THEN v_err := 'denegado';
  END;
  PERFORM pg_temp.esperar('un hub de Peru NO cierra sesiones de Colombia', v_err, 'denegado');

  BEGIN
    PERFORM close_ci_session(gen_random_uuid(), jsonb_build_object(
      'country','Peru','city','Lima','observed_date','2026-08-01',
      'user_email','adv.a@local.test','started_at', now()::text,
      'ended_at', now()::text, 'duration_minutes', 30,
      'rows_saved', 10, 'total_expected', 10));
    v_err := 'permitido';
  EXCEPTION WHEN OTHERS THEN v_err := 'FALLÓ LO PROPIO';
  END;
  PERFORM pg_temp.esperar('  pero SÍ las de su propio país', v_err, 'permitido');
  RESET ROLE;
END $$;

\echo '════════ 6. El camino del BUNDLE VIEJO (regresión de la mig 199) ════════'
DO $$
DECLARE v_err text; v_conf boolean;
BEGIN
  -- Exactamente lo que hace DataEntry.jsx:2347 del bundle desplegado: manda
  -- turno_timings y NO manda duration_confiable. Es el INSERT que quedó roto
  -- entre la mig 195 y la 199.
  PERFORM pg_temp.como('adv.a@local.test');
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO ci_sessions (country,city,zone,observed_date,user_email,started_at,ended_at,
                             duration_minutes,rows_saved,total_expected,turno_timings)
    VALUES ('Peru','Lima','ADV-VIEJO',DATE '2026-08-01','adv.a@local.test',
            now()-interval '40 min', now(), 40.0, 108, 108,
            '{"Mañana":{"startedAt":"2026-08-01T09:00:00Z","endedAt":"2026-08-01T09:40:00Z"}}'::jsonb)
    RETURNING duration_confiable INTO v_conf;
    v_err := 'ok';
  EXCEPTION WHEN OTHERS THEN v_err := SQLSTATE || ' ' || SQLERRM;
  END;
  RESET ROLE;
  PERFORM pg_temp.esperar('el bundle VIEJO puede cerrar (no vuelve el 42501)', v_err, 'ok');
  PERFORM pg_temp.esperar('  y el trigger completó la marca solo', v_conf, true);

  -- Y el helper sigue SIN exponerse a authenticated (la higiene de la 194).
  PERFORM pg_temp.esperar('ci_ts_or_null sigue sin EXECUTE para authenticated',
    has_function_privilege('authenticated','public.ci_ts_or_null(text)','EXECUTE'), false);
  PERFORM pg_temp.esperar('  ni para anon',
    has_function_privilege('anon','public.ci_ts_or_null(text)','EXECUTE'), false);
END $$;

\echo ''
\echo '════════ 7. ADMIN CLOSE: zona NULL vs cadena vacía ════════'
DO $$
DECLARE v_r jsonb; v_n int;
BEGIN
  -- El COALESCE(NULLIF(zone,''),'') tiene que tratar NULL y '' como lo mismo,
  -- o el admin cierra una sesión y deja el latido vivo (o duplica).
  PERFORM pg_temp.como('adv.admin@local.test');

  INSERT INTO ci_active_sessions (user_email,country,city,zone,observed_date,
    started_at,last_seen_at,turno_progress,total_expected)
  VALUES ('adv.a@local.test','Peru','Arequipa',NULL,DATE '2026-08-01',
    now()-interval '30 min', now(),
    jsonb_build_object('timings', jsonb_build_object('Mañana', jsonb_build_object(
      'startedAt',(now()-interval '30 min')::text,'endedAt',now()::text))), 108)
  ON CONFLICT (user_email) DO UPDATE SET city=EXCLUDED.city, zone=EXCLUDED.zone,
    observed_date=EXCLUDED.observed_date, started_at=EXCLUDED.started_at,
    turno_progress=EXCLUDED.turno_progress, last_seen_at=now();

  SET LOCAL ROLE authenticated;
  -- Se pide el cierre con '' aunque el latido tenga NULL.
  v_r := admin_close_ci_session('Peru','Arequipa','',DATE '2026-08-01','adv.a@local.test');
  RESET ROLE;

  PERFORM pg_temp.esperar('zona NULL en el latido se cierra pidiendo ""',
    (v_r->>'cerrada')::boolean, true);
  PERFORM pg_temp.esperar('  y el latido quedó borrado',
    (SELECT count(*)::int FROM ci_active_sessions WHERE user_email='adv.a@local.test'), 0);

  -- Segundo clic sobre lo mismo: idempotente aun con la asimetría NULL/''.
  PERFORM pg_temp.como('adv.admin@local.test');
  SET LOCAL ROLE authenticated;
  v_r := admin_close_ci_session('Peru','Arequipa','',DATE '2026-08-01','adv.a@local.test');
  RESET ROLE;
  PERFORM pg_temp.esperar('  el segundo clic no duplica', (v_r->>'duplicado')::boolean, true);
END $$;

\echo ''
\echo '════════ 8. BACKFILL: idempotencia y vuelta atrás bajo presión ════════'
DO $$
DECLARE v_pend int; v_corr int; v_total numeric; v_total2 numeric;
BEGIN
  -- Se ensucia a propósito una fila ya corregida y se re-corre.
  UPDATE ci_sessions SET duration_minutes = 999.9, duration_backfilled_at = NULL,
                         duration_minutes_legacy = NULL
   WHERE zone = 'ADV-VIEJO';

  CALL ci_backfill_duration_minutes(p_commit_por_lote => false);

  SELECT count(*)::int INTO v_pend FROM ci_sessions s
   WHERE s.duration_minutes IS DISTINCT FROM ci_duration_recalculada(s.turno_timings, s.ended_at);
  PERFORM pg_temp.esperar('tras re-correr no quedan filas pendientes', v_pend, 0);
  PERFORM pg_temp.esperar('  la fila ensuciada volvió a su valor real',
    (SELECT duration_minutes FROM ci_sessions WHERE zone='ADV-VIEJO'), 40.0::numeric);
  PERFORM pg_temp.esperar('  y su valor sucio quedó en legacy',
    (SELECT duration_minutes_legacy FROM ci_sessions WHERE zone='ADV-VIEJO'), 999.9::numeric);

  -- Correrlo otra vez no debe tocar NADA.
  SELECT coalesce(sum(duration_minutes),0) INTO v_total FROM ci_sessions;
  CALL ci_backfill_duration_minutes(p_commit_por_lote => false);
  SELECT coalesce(sum(duration_minutes),0) INTO v_total2 FROM ci_sessions;
  PERFORM pg_temp.esperar('una segunda corrida no cambia el total', v_total2, v_total);

  -- Vuelta atrás.
  UPDATE ci_sessions SET duration_minutes = duration_minutes_legacy,
                         duration_minutes_legacy = NULL, duration_backfilled_at = NULL
   WHERE duration_backfilled_at IS NOT NULL;
  PERFORM pg_temp.esperar('la vuelta atrás restaura el valor sucio',
    (SELECT duration_minutes FROM ci_sessions WHERE zone='ADV-VIEJO'), 999.9::numeric);
  PERFORM pg_temp.esperar('  y no quedan filas marcadas como corregidas',
    (SELECT count(*)::int FROM ci_sessions WHERE duration_backfilled_at IS NOT NULL), 0);
END $$;

\echo ''
\echo '════════ 9. Higiene que no puede degradarse ════════'
DO $$ BEGIN
  PERFORM pg_temp.esperar('ninguna SECURITY DEFINER sin search_path',
    (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.prosecdef AND p.proconfig IS NULL), 0);
  PERFORM pg_temp.esperar('ninguna tabla con 2+ políticas para el mismo comando',
    (SELECT count(*)::int FROM (SELECT 1 FROM pg_policies WHERE schemaname='public'
      GROUP BY tablename, cmd HAVING count(*) > 1) d), 0);
  PERFORM pg_temp.esperar('sin overloads en las RPCs de sesión',
    (SELECT count(*)::int FROM (
      SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public'
         AND p.proname IN ('close_ci_session','admin_close_ci_session','save_ci_batch',
                           'ci_hub_daily_minutes','ci_turno_minutes')
       GROUP BY p.proname HAVING count(*) > 1) d), 0);
  PERFORM pg_temp.esperar('anon sin EXECUTE en las RPCs de sesión',
    (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public'
        AND p.proname IN ('close_ci_session','admin_close_ci_session','save_ci_batch',
                          'ci_hub_daily_minutes','ci_turno_minutes','ci_backfill_duration_minutes')
        AND has_function_privilege('anon', p.oid, 'EXECUTE')), 0);
  PERFORM pg_temp.esperar('roles/user_profiles NUNCA con gate=section (escalación)',
    (SELECT count(*)::int FROM section_write_grants
      WHERE table_name IN ('roles','user_profiles') AND gate = 'section'), 0);
END $$;

\echo ''
\echo '✓ NO SE PUDO QUEBRAR NADA — batería adversarial completa'
ROLLBACK;
