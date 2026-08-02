-- ════════════════════════════════════════════════════════════════════════
-- simulate-duration-backfill.sql — mig 196. Contra Supabase LOCAL.
--
--   docker exec -i supabase_db_pricing-ci-dashboard psql -U postgres -X \
--     < scripts/simulate-duration-backfill.sql
--   (o: npm run simulate:duration-backfill)
--
-- LA PREGUNTA QUE RESPONDE
-- El backfill de la 196 pisa un número que el user usa para gestionar gente.
-- Antes de dejarlo tocar producción hay que poder afirmar, con un caso
-- concreto para cada uno, que:
--
--   1. La fila inflada por una sesión reabierta baja al trabajo real.
--   2. La fila de "0.1 minutos" con la grilla llena sube a lo que tardó.
--   3. La fila de más de 10 horas se acota al techo de la mig 194.
--   4. La fila que YA estaba bien no se toca (ni una tupla muerta).
--   5. La fila sin turno_timings queda en NULL — nunca en 0.
--   6. Correrlo dos veces da exactamente el mismo resultado.
--
-- Y además: que el valor original quede guardado, que exista una vuelta atrás
-- que de verdad restaure, que el ensayo no escriba nada, que el techo de
-- filas por corrida se respete, y que nada de esto quede expuesto por la API.
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

-- El escenario tiene que ser el único habitante de la tabla: las vistas de
-- resumen agregan sobre TODA ci_sessions, y con filas de otra prueba
-- alrededor los totales dejarían de ser verificables. Se borra DENTRO de la
-- transacción que se revierte al final — no toca nada de verdad.
DELETE FROM ci_sessions;

-- Siembra una fila HISTÓRICA: timings reales + el duration_minutes falso que
-- quedó guardado. Devuelve el id.
CREATE OR REPLACE FUNCTION pg_temp.sembrar(
  p_zone text, p_fecha date, p_timings jsonb,
  p_ini timestamptz, p_fin timestamptz,
  p_dur numeric, p_rows int
) RETURNS int LANGUAGE plpgsql AS $$
DECLARE v_id int;
BEGIN
  INSERT INTO ci_sessions (country, city, zone, observed_date, user_email,
    started_at, ended_at, duration_minutes, rows_saved, total_expected, turno_timings)
  VALUES ('Peru','Lima', p_zone, p_fecha, 'qa.backfill@local.test',
    p_ini, p_fin, p_dur, p_rows, 108, p_timings)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE TEMP TABLE casos (nombre text PRIMARY KEY, id int);

\echo ''
\echo '════ 0. El escenario: ocho filas con ocho patologías distintas ════'
DO $$
DECLARE d date := DATE '2026-07-20';
BEGIN
  -- (1) INFLADA por sesión reabierta. El hub trabajó 09:00-11:00 (120 min)
  --     pero dejó la pestaña abierta y el cronómetro de pared midió 6 horas.
  INSERT INTO casos VALUES ('inflada', pg_temp.sembrar('Inflada', d,
    '{"Mañana":{"startedAt":"2026-07-20T09:00:00Z","endedAt":"2026-07-20T11:00:00Z"}}'::jsonb,
    '2026-07-20T09:00:00Z', '2026-07-20T15:00:00Z', 360.0, 108));

  -- (2) EL SÍNTOMA REPORTADO: 0.1 minutos con la grilla entera guardada.
  --     Aeropuerto "Ambos" — al cerrar el Punto A el cronómetro se reinició,
  --     así que el Punto B (una hora de trabajo) midió los SEGUNDOS que
  --     pasaron entre un click y el otro.
  INSERT INTO casos VALUES ('cero_uno', pg_temp.sembrar('Aeropuerto B', d,
    '{"Mañana":{"startedAt":"2026-07-20T09:00:00Z","endedAt":"2026-07-20T10:00:00Z"}}'::jsonb,
    '2026-07-20T09:59:54Z', '2026-07-20T10:00:00Z', 0.1, 108));

  -- (3) MÁS DE 10 HORAS: `started_at` heredado de la sesión de ayer (P1-5).
  --     El trabajo real fueron dos turnos separados: 90 + 40 = 130 min.
  INSERT INTO casos VALUES ('diez_horas', pg_temp.sembrar('Heredada', d,
    '{"Mañana":{"startedAt":"2026-07-20T08:00:00Z","endedAt":"2026-07-20T09:30:00Z"},
      "Tarde":{"startedAt":"2026-07-20T14:00:00Z","endedAt":"2026-07-20T14:40:00Z"}}'::jsonb,
    '2026-07-19T22:00:00Z', '2026-07-20T14:40:00Z', 1000.0, 216));

  -- (4) YA CORRECTA: el número guardado coincide con los turnos. Es la fila
  --     que el backfill NO debe tocar.
  INSERT INTO casos VALUES ('ya_ok', pg_temp.sembrar('Correcta', d,
    '{"Mañana":{"startedAt":"2026-07-20T09:00:00Z","endedAt":"2026-07-20T10:00:00Z"}}'::jsonb,
    '2026-07-20T09:00:00Z', '2026-07-20T10:00:00Z', 60.0, 108));

  -- (5) SIN turno_timings: fila anterior a la mig 159. Su número salió del
  --     cronómetro de pared, que es justo la medición contaminada.
  INSERT INTO casos VALUES ('sin_timings', pg_temp.sembrar('Vieja', d,
    NULL::jsonb, '2026-07-20T09:00:00Z', '2026-07-20T09:45:00Z', 45.0, 108));

  -- (6) EL 0 LITERAL que escribía la vieja admin_close_ci_session cuando no
  --     encontraba fila de latido. Tiene timings, así que es recuperable.
  INSERT INTO casos VALUES ('cero_literal', pg_temp.sembrar('Cerrada por admin', d,
    '{"Noche":{"startedAt":"2026-07-20T19:00:00Z","endedAt":"2026-07-20T19:35:00Z"}}'::jsonb,
    '2026-07-20T19:00:00Z', '2026-07-20T19:35:00Z', 0.0, 108));

  -- (7) Turno de NUEVE horas: laptop cerrada. Se acota al techo de 4h de la
  --     mig 194, y la 195 ya lo dejó marcado como NO confiable.
  INSERT INTO casos VALUES ('capada', pg_temp.sembrar('Laptop abierta', d,
    '{"Mañana":{"startedAt":"2026-07-20T09:00:00Z","endedAt":"2026-07-20T18:00:00Z"}}'::jsonb,
    '2026-07-20T09:00:00Z', '2026-07-20T18:00:00Z', 540.0, 108));

  -- (8) Tramo de DOS SEGUNDOS: medible, pero redondea a 0.0 minutos. Un 0 se
  --     promedia y miente, así que tiene que terminar en NULL igual que (5).
  INSERT INTO casos VALUES ('dos_segundos', pg_temp.sembrar('Instantánea', d,
    '{"Mañana":{"startedAt":"2026-07-20T09:00:00Z","endedAt":"2026-07-20T09:00:02Z"}}'::jsonb,
    '2026-07-20T09:00:00Z', '2026-07-20T09:00:02Z', 0.1, 4));
END $$;

DO $$ BEGIN
  PERFORM pg_temp.esperar('se sembraron 8 filas',
    (SELECT count(*) FROM ci_sessions), 8::bigint);
  PERFORM pg_temp.esperar('  y las 8 arrancan sin marcar (pendientes)',
    (SELECT count(*) FROM ci_sessions WHERE duration_backfilled_at IS NULL), 8::bigint);
  PERFORM pg_temp.esperar('  la suma "antes" es la inflada: 2005.2 minutos',
    (SELECT sum(duration_minutes) FROM ci_sessions), 2005.2::numeric);
END $$;

\echo ''
\echo '════ 1. ENSAYO (p_dry_run): mira pero no toca ════'
DO $$
DECLARE v_suma numeric; v_marcadas bigint;
BEGIN
  CALL ci_backfill_duration_minutes(p_dry_run => true, p_commit_por_lote => false);

  SELECT sum(duration_minutes), count(*) FILTER (WHERE duration_backfilled_at IS NOT NULL)
    INTO v_suma, v_marcadas FROM ci_sessions;
  PERFORM pg_temp.esperar('el ensayo no cambió ningún valor', v_suma, 2005.2::numeric);
  PERFORM pg_temp.esperar('el ensayo no marcó ninguna fila', v_marcadas, 0::bigint);
  PERFORM pg_temp.esperar('  y no llenó ningún legacy',
    (SELECT count(*) FROM ci_sessions WHERE duration_minutes_legacy IS NOT NULL), 0::bigint);
END $$;

\echo ''
\echo '════ 2. Techo por corrida (p_max_filas): acotado de verdad ════'
DO $$ BEGIN
  CALL ci_backfill_duration_minutes(p_lote => 500, p_max_filas => 1, p_commit_por_lote => false);
  PERFORM pg_temp.esperar('con p_max_filas=1 corrigió exactamente 1 fila',
    (SELECT count(*) FROM ci_sessions WHERE duration_backfilled_at IS NOT NULL), 1::bigint);
  -- Y la corrida siguiente REANUDA donde quedó, no vuelve a empezar.
  CALL ci_backfill_duration_minutes(p_lote => 2, p_max_filas => 2, p_commit_por_lote => false);
  PERFORM pg_temp.esperar('la corrida siguiente reanuda (3 corregidas en total)',
    (SELECT count(*) FROM ci_sessions WHERE duration_backfilled_at IS NOT NULL), 3::bigint);
END $$;

\echo ''
\echo '════ 3. El backfill completo, en lotes de 2 ════'
DO $$ BEGIN
  CALL ci_backfill_duration_minutes(p_lote => 2, p_commit_por_lote => false);
  PERFORM pg_temp.esperar('no queda ninguna fila sin recalcular',
    (SELECT pendientes FROM ci_duration_backfill_resumen), 0::bigint);
END $$;

\echo ''
\echo '════ 4. Fila por fila: cada patología quedó como debe ════'
DO $$
DECLARE v_id int;
BEGIN
  -- (1) INFLADA: 360 → 120. El trabajo real fueron dos horas.
  SELECT id INTO v_id FROM casos WHERE nombre = 'inflada';
  PERFORM pg_temp.esperar('inflada: 360 → 120 minutos',
    (SELECT duration_minutes FROM ci_sessions WHERE id = v_id), 120.0::numeric);
  PERFORM pg_temp.esperar('  con el original preservado en legacy',
    (SELECT duration_minutes_legacy FROM ci_sessions WHERE id = v_id), 360.0::numeric);
  PERFORM pg_temp.esperar('  y clasificada como inflada_corregida',
    (SELECT clasificacion FROM ci_duration_backfill_audit WHERE id = v_id), 'inflada_corregida');
  PERFORM pg_temp.esperar('  con delta -240',
    (SELECT delta FROM ci_duration_backfill_audit WHERE id = v_id), -240.0::numeric);

  -- (2) EL SÍNTOMA: 0.1 → 60. Una hora de trabajo deja de figurar como 6 seg.
  SELECT id INTO v_id FROM casos WHERE nombre = 'cero_uno';
  PERFORM pg_temp.esperar('0.1 minutos con 108 celdas → 60 minutos',
    (SELECT duration_minutes FROM ci_sessions WHERE id = v_id), 60.0::numeric);
  PERFORM pg_temp.esperar('  clasificada como subestimada_corregida',
    (SELECT clasificacion FROM ci_duration_backfill_audit WHERE id = v_id), 'subestimada_corregida');
  PERFORM pg_temp.esperar('  y marcada confiable (los dos turnos tenían inicio y fin)',
    (SELECT duration_confiable FROM ci_sessions WHERE id = v_id), true);

  -- (3) MÁS DE 10 HORAS: 1000 → 130 (90 de Mañana + 40 de Tarde, separados).
  SELECT id INTO v_id FROM casos WHERE nombre = 'diez_horas';
  PERFORM pg_temp.esperar('1000 minutos heredados → 130 reales',
    (SELECT duration_minutes FROM ci_sessions WHERE id = v_id), 130.0::numeric);
  PERFORM pg_temp.esperar('  y el original queda auditable',
    (SELECT min_antes FROM ci_duration_backfill_audit WHERE id = v_id), 1000.0::numeric);

  -- (4) YA CORRECTA: intacta. Ni valor, ni legacy, ni marca de backfill.
  SELECT id INTO v_id FROM casos WHERE nombre = 'ya_ok';
  PERFORM pg_temp.esperar('la fila ya correcta conserva sus 60 minutos',
    (SELECT duration_minutes FROM ci_sessions WHERE id = v_id), 60.0::numeric);
  PERFORM pg_temp.esperar('  el backfill NO la marcó (no la pisó)',
    (SELECT duration_backfilled_at FROM ci_sessions WHERE id = v_id), NULL::timestamptz);
  PERFORM pg_temp.esperar('  ni le llenó legacy',
    (SELECT duration_minutes_legacy FROM ci_sessions WHERE id = v_id), NULL::numeric);
  PERFORM pg_temp.esperar('  y la auditoría la muestra como sin_tocar',
    (SELECT clasificacion FROM ci_duration_backfill_audit WHERE id = v_id), 'sin_tocar');
  PERFORM pg_temp.esperar('  con min_antes = min_ahora',
    (SELECT min_antes = min_ahora FROM ci_duration_backfill_audit WHERE id = v_id), true);

  -- (5) SIN TIMINGS: NULL, nunca 0.
  SELECT id INTO v_id FROM casos WHERE nombre = 'sin_timings';
  PERFORM pg_temp.esperar('sin turno_timings → NULL (no 0)',
    (SELECT duration_minutes FROM ci_sessions WHERE id = v_id), NULL::numeric);
  PERFORM pg_temp.esperar('  pero el valor viejo NO se perdió',
    (SELECT duration_minutes_legacy FROM ci_sessions WHERE id = v_id), 45.0::numeric);
  PERFORM pg_temp.esperar('  clasificada como anulada',
    (SELECT clasificacion FROM ci_duration_backfill_audit WHERE id = v_id), 'anulada');

  -- (6) EL 0 LITERAL: recuperado desde los turnos.
  SELECT id INTO v_id FROM casos WHERE nombre = 'cero_literal';
  PERFORM pg_temp.esperar('el 0 literal se recupera a 35 minutos',
    (SELECT duration_minutes FROM ci_sessions WHERE id = v_id), 35.0::numeric);

  -- (7) CAPADA: 540 → 240, y sigue marcada como no confiable (mig 195). El
  --     número nuevo es un PISO, no la verdad, y eso tiene que verse.
  SELECT id INTO v_id FROM casos WHERE nombre = 'capada';
  PERFORM pg_temp.esperar('el turno de 9h se acota a 240 minutos',
    (SELECT duration_minutes FROM ci_sessions WHERE id = v_id), 240.0::numeric);
  PERFORM pg_temp.esperar('  y la auditoría avisa que es un piso (turno_recortado)',
    (SELECT duration_motivo FROM ci_duration_backfill_audit WHERE id = v_id), 'turno_recortado');

  -- (8) DOS SEGUNDOS: medible pero redondea a 0.0 → NULL.
  SELECT id INTO v_id FROM casos WHERE nombre = 'dos_segundos';
  PERFORM pg_temp.esperar('un tramo de 2 segundos NO deja un 0 guardado',
    (SELECT duration_minutes FROM ci_sessions WHERE id = v_id), NULL::numeric);
END $$;

\echo ''
\echo '════ 5. Ninguna fila quedó en 0, ni por arriba del techo ════'
DO $$ BEGIN
  PERFORM pg_temp.esperar('cero filas con duration_minutes = 0',
    (SELECT count(*) FROM ci_sessions WHERE duration_minutes = 0), 0::bigint);
  PERFORM pg_temp.esperar('cero filas con trabajo guardado y menos de 2 minutos',
    (SELECT count(*) FROM ci_sessions
      WHERE coalesce(rows_saved,0) > 20 AND duration_minutes < 2), 0::bigint);
  PERFORM pg_temp.esperar('cero filas por encima de 12h (3 turnos × techo de 4h)',
    (SELECT count(*) FROM ci_sessions WHERE duration_minutes > 720), 0::bigint);
END $$;

\echo ''
\echo '════ 6. El titular: cuánto cambió el total ════'
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM ci_duration_backfill_resumen;
  PERFORM pg_temp.esperar('8 filas en total', r.filas, 8::bigint);
  PERFORM pg_temp.esperar('7 corregidas', r.filas_corregidas, 7::bigint);
  PERFORM pg_temp.esperar('1 intacta (la que ya estaba bien)', r.filas_intactas, 1::bigint);
  PERFORM pg_temp.esperar('2 quedaron en NULL (sin timings / 2 segundos)',
    r.quedaron_en_null, 2::bigint);
  -- Infladas: 360→120, 1000→130, 540→240. Cortas: 0.1→60 y 0→35.
  PERFORM pg_temp.esperar('3 estaban infladas', r.estaban_infladas, 3::bigint);
  PERFORM pg_temp.esperar('2 estaban cortas (el 0.1 y el 0 literal)', r.estaban_cortas, 2::bigint);
  PERFORM pg_temp.esperar('minutos antes: 2005.2', r.minutos_antes, 2005.2::numeric);
  -- 120 + 60 + 130 + 60 (intacta) + 35 + 240 = 645
  PERFORM pg_temp.esperar('minutos ahora: 645.0', r.minutos_ahora, 645.0::numeric);
  PERFORM pg_temp.esperar('delta: -1360.2', r.delta_minutos, -1360.2::numeric);
  RAISE NOTICE '  → el histórico figuraba un % por ciento por encima del trabajo real',
    round((r.minutos_antes - r.minutos_ahora) / r.minutos_ahora * 100, 0);
END $$;

\echo ''
\echo '════ 7. IDEMPOTENCIA: correrlo de nuevo no cambia nada ════'
CREATE TEMP TABLE foto AS
  SELECT id, duration_minutes, duration_minutes_legacy, duration_backfilled_at
    FROM ci_sessions;

DO $$
DECLARE v_dif bigint;
BEGIN
  CALL ci_backfill_duration_minutes(p_commit_por_lote => false);
  CALL ci_backfill_duration_minutes(p_lote => 1, p_commit_por_lote => false);

  SELECT count(*) INTO v_dif FROM (
    SELECT id, duration_minutes, duration_minutes_legacy, duration_backfilled_at FROM ci_sessions
    EXCEPT
    SELECT id, duration_minutes, duration_minutes_legacy, duration_backfilled_at FROM foto
  ) q;
  PERFORM pg_temp.esperar('dos corridas más dejan la tabla idéntica', v_dif, 0::bigint);
  PERFORM pg_temp.esperar('  y el legacy sigue siendo el ORIGINAL, no el recalculado',
    (SELECT duration_minutes_legacy FROM ci_sessions
      WHERE id = (SELECT id FROM casos WHERE nombre='inflada')), 360.0::numeric);
  PERFORM pg_temp.esperar('  sin filas pendientes',
    (SELECT pendientes FROM ci_duration_backfill_resumen), 0::bigint);
END $$;

\echo ''
\echo '════ 8. Una fila NUEVA, ya correcta, no entra al backfill ════'
DO $$
DECLARE v_id int;
BEGIN
  -- Es el caso de un hub que cierra sesión después de aplicar la migración:
  -- nace con el algoritmo bueno (mig 194) y el backfill no tiene nada que
  -- hacerle. Si entrara, `pendientes` dejaría de servir como señal.
  v_id := pg_temp.sembrar('Nueva', DATE '2026-07-26',
    '{"Tarde":{"startedAt":"2026-07-26T14:00:00Z","endedAt":"2026-07-26T14:25:00Z"}}'::jsonb,
    '2026-07-26T14:00:00Z', '2026-07-26T14:25:00Z', 25.0, 108);
  CALL ci_backfill_duration_minutes(p_commit_por_lote => false);
  PERFORM pg_temp.esperar('la fila nueva y correcta no se toca',
    (SELECT duration_backfilled_at FROM ci_sessions WHERE id = v_id), NULL::timestamptz);
  PERFORM pg_temp.esperar('  y no figura como pendiente',
    (SELECT pendientes FROM ci_duration_backfill_resumen), 0::bigint);
  DELETE FROM ci_sessions WHERE id = v_id;
END $$;

\echo ''
\echo '════ 9. VUELTA ATRÁS: el backfill es reversible ════'
DO $$
DECLARE v_restauradas bigint;
BEGIN
  UPDATE ci_sessions
     SET duration_minutes        = duration_minutes_legacy,
         duration_minutes_legacy = NULL,
         duration_backfilled_at  = NULL
   WHERE duration_backfilled_at IS NOT NULL;
  GET DIAGNOSTICS v_restauradas = ROW_COUNT;

  PERFORM pg_temp.esperar('la vuelta atrás toca solo las 7 filas corregidas',
    v_restauradas, 7::bigint);
  PERFORM pg_temp.esperar('  y el total vuelve a ser el original (2005.2)',
    (SELECT sum(duration_minutes) FROM ci_sessions), 2005.2::numeric);
  PERFORM pg_temp.esperar('  incluida la fila que estaba en 0.1',
    (SELECT duration_minutes FROM ci_sessions
      WHERE id = (SELECT id FROM casos WHERE nombre='cero_uno')), 0.1::numeric);
  PERFORM pg_temp.esperar('  y la que nunca se tocó sigue en 60',
    (SELECT duration_minutes FROM ci_sessions
      WHERE id = (SELECT id FROM casos WHERE nombre='ya_ok')), 60.0::numeric);
  -- Y después de revertir, el backfill se puede volver a correr de cero.
  CALL ci_backfill_duration_minutes(p_commit_por_lote => false);
  PERFORM pg_temp.esperar('tras revertir, el backfill vuelve a corregir las 7',
    (SELECT count(*) FROM ci_sessions WHERE duration_backfilled_at IS NOT NULL), 7::bigint);
END $$;

\echo ''
\echo '════ 10. Higiene de permisos (CLAUDE.md §3) ════'
DO $$ BEGIN
  PERFORM pg_temp.esperar('anon NO puede leer la auditoría',
    has_table_privilege('anon', 'public.ci_duration_backfill_audit', 'SELECT'), false);
  PERFORM pg_temp.esperar('authenticated tampoco',
    has_table_privilege('authenticated', 'public.ci_duration_backfill_audit', 'SELECT'), false);
  PERFORM pg_temp.esperar('anon NO puede leer el resumen',
    has_table_privilege('anon', 'public.ci_duration_backfill_resumen', 'SELECT'), false);
  PERFORM pg_temp.esperar('authenticated NO puede ejecutar el backfill',
    has_function_privilege('authenticated',
      'public.ci_backfill_duration_minutes(int,int,boolean,boolean)', 'EXECUTE'), false);
  PERFORM pg_temp.esperar('anon tampoco',
    has_function_privilege('anon',
      'public.ci_backfill_duration_minutes(int,int,boolean,boolean)', 'EXECUTE'), false);

  -- Una vista sin security_invoker lee las tablas con los privilegios del
  -- dueño y bypasea la RLS de ci_sessions.
  PERFORM pg_temp.esperar('la auditoría corre con security_invoker',
    (SELECT 'security_invoker=true' = ANY(c.reloptions) FROM pg_class c
      WHERE c.relname = 'ci_duration_backfill_audit'), true);
  PERFORM pg_temp.esperar('el resumen también',
    (SELECT 'security_invoker=true' = ANY(c.reloptions) FROM pg_class c
      WHERE c.relname = 'ci_duration_backfill_resumen'), true);

  -- search_path fijado en la función y en el procedimiento nuevos.
  PERFORM pg_temp.esperar('ci_duration_recalculada fija search_path',
    (SELECT proconfig IS NOT NULL FROM pg_proc
      WHERE oid = 'public.ci_duration_recalculada(jsonb,timestamptz)'::regprocedure), true);
  PERFORM pg_temp.esperar('ci_backfill_duration_minutes fija search_path',
    (SELECT proconfig IS NOT NULL FROM pg_proc
      WHERE oid = 'public.ci_backfill_duration_minutes(int,int,boolean,boolean)'::regprocedure), true);
END $$;

\echo ''
\echo '════ 11. Validación de argumentos ════'
DO $$
DECLARE v text;
BEGIN
  BEGIN
    CALL ci_backfill_duration_minutes(p_lote => 0, p_commit_por_lote => false);
    v := 'NO FALLÓ';
  EXCEPTION WHEN OTHERS THEN v := 'rechazado';
  END;
  PERFORM pg_temp.esperar('un lote de 0 se rechaza (si no, bucle infinito)', v, 'rechazado');
END $$;

\echo ''
\echo '✓ TODAS LAS SIMULACIONES DEL BACKFILL DE DURACIÓN PASARON'
ROLLBACK;
