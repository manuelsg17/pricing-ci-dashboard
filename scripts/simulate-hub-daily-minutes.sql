-- ════════════════════════════════════════════════════════════════════════
-- simulate-hub-daily-minutes.sql — mig 195. Contra Supabase LOCAL.
--
--   docker exec -i supabase_db_pricing-ci-dashboard psql -U postgres -X \
--     < scripts/simulate-hub-daily-minutes.sql
--
-- LAS DOS PREGUNTAS QUE RESPONDE:
--   1. ¿La suma por hub y día deja de contar dos veces el mismo minuto
--      cuando el hub reabre una sesión para corregir?
--   2. ¿La marca de confianza distingue un número exacto de uno capado,
--      estimado o inventado?
--
-- Se mide contra el dato REAL de producción que originó el pedido: 20 de 26
-- hub-días tienen más de una fila, y la peor suma ingenua daba 827 minutos —
-- casi 14 horas en un día.
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

-- Un hub con acceso a Perú.
INSERT INTO roles (name, label, permissions)
VALUES ('qa_dur','QA duracion','{"sections":["dataentry"],"countries":["Peru"]}'::jsonb);
INSERT INTO user_profiles (email, first_name, last_name, role_id, is_active)
VALUES ('qa.dur@local.test','QA','Dur',(SELECT id FROM roles WHERE name='qa_dur'), true);

-- Desde la mig 201 las dos RPCs son SOLO ADMIN, además de exigir acceso al
-- país: devuelven quién trabajó y cuántos minutos, y la RLS de ci_sessions
-- reserva ese dato a admin y al dueño. Antes bastaba con tener el país, y eso
-- era una fuga: cualquier hub enumeraba el trabajo de sus compañeros.
--
-- El cuerpo de esta simulación prueba la LÓGICA DE UNIÓN, así que corre con
-- identidad de admin. Que un NO admin quede afuera se verifica en el bloque 8.
INSERT INTO user_profiles (email, first_name, last_name, role_id, is_active)
VALUES ('qa.duradm@local.test','QA','DurAdm',(SELECT id FROM roles WHERE name='admin'), true);

SELECT set_config('request.jwt.claims',
  '{"email":"qa.duradm@local.test","role":"authenticated"}', true);

-- Helper: inserta una sesión con turnos dados.
CREATE OR REPLACE FUNCTION pg_temp.sesion(
  p_fecha date, p_zone text, p_timings jsonb, p_fin timestamptz
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO ci_sessions (country, city, zone, observed_date, user_email,
    started_at, ended_at, duration_minutes, rows_saved, turno_timings)
  VALUES ('Peru','Lima', p_zone, p_fecha, 'qa.dur@local.test',
    ci_started_from_timings(p_timings), p_fin,
    ci_duration_from_timings(p_timings, p_fin), 10, p_timings);
END $$;

\echo ''
\echo '════ 1. La marca de confianza clasifica bien ════'
DO $$
DECLARE d date := DATE '2026-07-20';
BEGIN
  -- (a) EXACTA: todos los turnos con inicio y fin reales.
  PERFORM pg_temp.sesion(d, 'A',
    '{"Mañana":{"startedAt":"2026-07-20T09:00:00Z","endedAt":"2026-07-20T10:00:00Z"}}'::jsonb,
    '2026-07-20T10:00:00Z');
  PERFORM pg_temp.esperar('turnos completos → confiable',
    (SELECT duration_confiable FROM ci_sessions WHERE zone='A' AND observed_date=d), true);
  PERFORM pg_temp.esperar('  y sin motivo',
    (SELECT duration_motivo FROM ci_sessions WHERE zone='A' AND observed_date=d), NULL::text);
  PERFORM pg_temp.esperar('  con 60 minutos',
    (SELECT duration_minutes FROM ci_sessions WHERE zone='A' AND observed_date=d), 60.0::numeric);

  -- (b) RECORTADA: un turno de 9 horas (laptop cerrada). Se capa a 4h, y el
  --     número resultante es un PISO, no la verdad.
  PERFORM pg_temp.sesion(d, 'B',
    '{"Mañana":{"startedAt":"2026-07-20T09:00:00Z","endedAt":"2026-07-20T18:00:00Z"}}'::jsonb,
    '2026-07-20T18:00:00Z');
  PERFORM pg_temp.esperar('turno de 9h → NO confiable',
    (SELECT duration_confiable FROM ci_sessions WHERE zone='B' AND observed_date=d), false);
  PERFORM pg_temp.esperar('  motivo turno_recortado',
    (SELECT duration_motivo FROM ci_sessions WHERE zone='B' AND observed_date=d), 'turno_recortado');
  PERFORM pg_temp.esperar('  capado a 240 min, no 540',
    (SELECT duration_minutes FROM ci_sessions WHERE zone='B' AND observed_date=d), 240.0::numeric);

  -- (c) ESTIMADA: turno sin endedAt, cerrado con el fin de sesión.
  PERFORM pg_temp.sesion(d, 'C',
    '{"Mañana":{"startedAt":"2026-07-20T09:00:00Z"}}'::jsonb,
    '2026-07-20T09:45:00Z');
  PERFORM pg_temp.esperar('turno sin fin → NO confiable',
    (SELECT duration_confiable FROM ci_sessions WHERE zone='C' AND observed_date=d), false);
  PERFORM pg_temp.esperar('  motivo turno_estimado',
    (SELECT duration_motivo FROM ci_sessions WHERE zone='C' AND observed_date=d), 'turno_estimado');

  -- (d) SIN DATO: el caso del ancho cero, que producía "0.0 confiable".
  PERFORM pg_temp.sesion(d, 'D',
    '{"Mañana":{"startedAt":"2026-07-20T09:00:00Z","endedAt":"2026-07-20T09:00:00Z"}}'::jsonb,
    '2026-07-20T09:00:00Z');
  PERFORM pg_temp.esperar('tramo de ancho CERO → NO confiable',
    (SELECT duration_confiable FROM ci_sessions WHERE zone='D' AND observed_date=d), false);
  PERFORM pg_temp.esperar('  y la duración es NULL, no 0',
    (SELECT duration_minutes FROM ci_sessions WHERE zone='D' AND observed_date=d), NULL::numeric);
END $$;

\echo ''
\echo '════ 2. Sesión REABIERTA: el caso que duplicaba minutos ════'
DO $$
DECLARE d date := DATE '2026-07-21'; v_union numeric; v_ingenua numeric;
BEGIN
  -- El hub trabaja 09:00-11:00 y cierra.
  PERFORM pg_temp.sesion(d, 'E',
    '{"Mañana":{"startedAt":"2026-07-21T09:00:00Z","endedAt":"2026-07-21T11:00:00Z"}}'::jsonb,
    '2026-07-21T11:00:00Z');
  -- A las 15:00 reabre para corregir UNA celda. Los timings viejos viajan con
  -- la fila nueva: es el rastro de revisiones, y es deliberado.
  PERFORM pg_temp.sesion(d, 'E',
    '{"Mañana":{"startedAt":"2026-07-21T09:00:00Z","endedAt":"2026-07-21T11:00:00Z"},
      "Tarde":{"startedAt":"2026-07-21T15:00:00Z","endedAt":"2026-07-21T15:05:00Z"}}'::jsonb,
    '2026-07-21T15:05:00Z');

  SELECT sum(duration_minutes) INTO v_ingenua FROM ci_sessions
   WHERE user_email='qa.dur@local.test' AND observed_date=d;
  SELECT minutos INTO v_union FROM ci_hub_daily_minutes('Peru', d, d);

  -- 120 (primera) + 125 (segunda, que RE-CUENTA la mañana) = 245
  PERFORM pg_temp.esperar('la suma ingenua duplica la mañana', v_ingenua, 245.0::numeric);
  -- 09:00-11:00 (120) + 15:00-15:05 (5) = 125 reales
  PERFORM pg_temp.esperar('la UNIÓN da los minutos reales', v_union, 125.0::numeric);
  PERFORM pg_temp.esperar('  o sea 120 minutos de más en la ingenua',
    round(v_ingenua - v_union, 1), 120.0::numeric);
  PERFORM pg_temp.esperar('  y reporta que fueron 2 sesiones',
    (SELECT sesiones FROM ci_hub_daily_minutes('Peru', d, d)), 2);
END $$;

\echo ''
\echo '════ 3. Turnos SOLAPADOS: unión, no suma ════'
DO $$
DECLARE d date := DATE '2026-07-22'; v numeric;
BEGIN
  -- El hub intercala Mañana y Tarde: 09:00-10:00 y 09:30-10:30.
  -- Sumar da 120 min por 90 reales de reloj de pared.
  PERFORM pg_temp.sesion(d, 'F',
    '{"Mañana":{"startedAt":"2026-07-22T09:00:00Z","endedAt":"2026-07-22T10:00:00Z"},
      "Tarde":{"startedAt":"2026-07-22T09:30:00Z","endedAt":"2026-07-22T10:30:00Z"}}'::jsonb,
    '2026-07-22T10:30:00Z');
  SELECT minutos INTO v FROM ci_hub_daily_minutes('Peru', d, d);
  PERFORM pg_temp.esperar('turnos solapados cuentan una sola vez (90, no 120)', v, 90.0::numeric);
END $$;

\echo ''
\echo '════ 4. Tramos SEPARADOS sí se suman ════'
DO $$
DECLARE d date := DATE '2026-07-23'; v numeric;
BEGIN
  -- Mañana 09:00-10:00 y Noche 18:00-18:30: no se tocan, son 90 minutos.
  PERFORM pg_temp.sesion(d, 'G',
    '{"Mañana":{"startedAt":"2026-07-23T09:00:00Z","endedAt":"2026-07-23T10:00:00Z"},
      "Noche":{"startedAt":"2026-07-23T18:00:00Z","endedAt":"2026-07-23T18:30:00Z"}}'::jsonb,
    '2026-07-23T18:30:00Z');
  SELECT minutos INTO v FROM ci_hub_daily_minutes('Peru', d, d);
  PERFORM pg_temp.esperar('tramos que no se tocan SÍ se suman (90)', v, 90.0::numeric);
END $$;

\echo ''
\echo '════ 5. Dos CIUDADES el mismo día ════'
DO $$
DECLARE d date := DATE '2026-07-24'; v numeric;
BEGIN
  -- El hub cierra Comas y después SJM. Son ciudades/zonas distintas pero UNA
  -- sola persona: el tiempo real es la unión, no la suma de sus registros.
  PERFORM pg_temp.sesion(d, 'Comas',
    '{"Mañana":{"startedAt":"2026-07-24T09:00:00Z","endedAt":"2026-07-24T10:00:00Z"}}'::jsonb,
    '2026-07-24T10:00:00Z');
  PERFORM pg_temp.sesion(d, 'SJM',
    '{"Mañana":{"startedAt":"2026-07-24T10:00:00Z","endedAt":"2026-07-24T11:00:00Z"}}'::jsonb,
    '2026-07-24T11:00:00Z');
  SELECT minutos INTO v FROM ci_hub_daily_minutes('Peru', d, d);
  PERFORM pg_temp.esperar('dos distritos consecutivos = 120 min de trabajo', v, 120.0::numeric);
  PERFORM pg_temp.esperar('  y el día figura como 2 sesiones',
    (SELECT sesiones FROM ci_hub_daily_minutes('Peru', d, d)), 2);
END $$;

\echo ''
\echo '════ 6. El día hereda la desconfianza de cualquiera de sus filas ════'
DO $$
DECLARE d date := DATE '2026-07-25';
BEGIN
  PERFORM pg_temp.sesion(d, 'H',
    '{"Mañana":{"startedAt":"2026-07-25T09:00:00Z","endedAt":"2026-07-25T10:00:00Z"}}'::jsonb,
    '2026-07-25T10:00:00Z');
  PERFORM pg_temp.esperar('con una sola fila exacta, el día es confiable',
    (SELECT confiable FROM ci_hub_daily_minutes('Peru', d, d)), true);

  -- Se le suma una fila capada: el total del día pasa a ser un PISO.
  PERFORM pg_temp.sesion(d, 'I',
    '{"Tarde":{"startedAt":"2026-07-25T13:00:00Z","endedAt":"2026-07-25T22:00:00Z"}}'::jsonb,
    '2026-07-25T22:00:00Z');
  PERFORM pg_temp.esperar('una sola fila capada contamina el día entero',
    (SELECT confiable FROM ci_hub_daily_minutes('Peru', d, d)), false);
END $$;

\echo ''
\echo '════ 7. Tiempo por turno: solo sobre lo confiable ════'
DO $$
DECLARE v_prom numeric; v_muestras bigint;
BEGIN
  -- De todo lo sembrado, Mañana tiene tramos confiables de 60, 120, 60 y 60
  -- min (zonas A, E×1 por dedupe de fila, F-solapado, G, Comas, SJM...).
  -- Lo que se verifica es que los NO confiables (B capado, C estimado,
  -- D ancho cero) queden FUERA.
  SELECT muestras, min_prom INTO v_muestras, v_prom
    FROM ci_turno_minutes('Peru', DATE '2026-07-20', DATE '2026-07-25')
   WHERE turno = 'Mañana';
  PERFORM pg_temp.esperar('hay muestras de Mañana', v_muestras > 0, true);
  PERFORM pg_temp.esperar('el promedio de Mañana es plausible (<= 240)', v_prom <= 240, true);

  -- El capado de 9 horas NO puede estar en el promedio.
  PERFORM pg_temp.esperar('el máximo de Mañana no llega al techo de 4h',
    (SELECT min_max FROM ci_turno_minutes('Peru', DATE '2026-07-20', DATE '2026-07-25')
      WHERE turno='Mañana') < 240, true);
END $$;

\echo ''
\echo '════ 8. Quién puede pedir estos números (mig 201) ════'
DO $$
DECLARE v_err text;
BEGIN
  -- ANTES DE LA MIG 201 ESTO ERA UNA FUGA. Con solo tener el país alcanzaba, y
  -- la RPC —SECURITY DEFINER— devolvía el email, los minutos y las sesiones de
  -- TODOS los hubs de ese país, bypaseando la RLS de ci_sessions. Reproducido
  -- el 2026-08-02: el hub A leía 0 filas de B por la tabla y las obtenía todas
  -- por la RPC.
  PERFORM set_config('request.jwt.claims',
    '{"email":"qa.dur@local.test","role":"authenticated"}', true);   -- NO admin, países=['Peru']

  BEGIN
    PERFORM * FROM ci_hub_daily_minutes('Peru', current_date - 30, current_date);
    v_err := 'NO FALLÓ';
  EXCEPTION WHEN OTHERS THEN v_err := 'denegado';
  END;
  PERFORM pg_temp.esperar('un hub NO admin no ve los minutos ni de su propio país', v_err, 'denegado');

  BEGIN
    PERFORM * FROM ci_turno_minutes('Peru', current_date - 30, current_date);
    v_err := 'NO FALLÓ';
  EXCEPTION WHEN OTHERS THEN v_err := 'denegado';
  END;
  PERFORM pg_temp.esperar('  tampoco los tiempos por turno', v_err, 'denegado');

  -- Y el admin sí, que es lo que la pantalla de Monitoreo necesita.
  PERFORM set_config('request.jwt.claims',
    '{"email":"qa.duradm@local.test","role":"authenticated"}', true);
  BEGIN
    PERFORM * FROM ci_hub_daily_minutes('Peru', current_date - 30, current_date);
    v_err := 'permitido';
  EXCEPTION WHEN OTHERS THEN v_err := 'FALLÓ PARA EL ADMIN';
  END;
  PERFORM pg_temp.esperar('  el admin sí puede', v_err, 'permitido');
END $$;

\echo ''
\echo '════ 9. Backfill: no quedan filas sin clasificar ════'
DO $$ BEGIN
  PERFORM pg_temp.esperar('toda fila nueva sale clasificada por el trigger',
    (SELECT count(*) FROM ci_sessions WHERE duration_confiable IS NULL), 0::bigint);
END $$;

\echo ''
\echo '✓ TODAS LAS SIMULACIONES DE DURACIÓN POR HUB/DÍA PASARON'
ROLLBACK;
