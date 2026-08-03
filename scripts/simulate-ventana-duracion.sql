-- ════════════════════════════════════════════════════════════════════════
-- Mig 210 — la ventana de la sesión tiene que contener al trabajo que mide.
--
-- Reproduce el caso REAL de producción (rayrodriguez / Lima_Airport_B /
-- 2026-07-25: 211.0 minutos declarados en una ventana de 13 segundos) y las
-- tres propiedades del guard, incluida la que un fix apurado rompería:
-- la ventana solo se ENSANCHA, nunca se achica.
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

-- Los timings REALES de la fila peor de producción. Van en una tabla temporal
-- y no en un \set de psql: las variables de psql NO se interpolan adentro de
-- un bloque DO $$ ... $$ (dollar-quoting), así que un \set acá fallaría.
CREATE TEMP TABLE qa210_fixture(timings jsonb);
INSERT INTO qa210_fixture VALUES ('{"Mañana":{"startedAt":"2026-07-25T14:42:43.628Z","endedAt":"2026-07-25T16:36:07.313Z"},"Tarde":{"startedAt":"2026-07-25T19:19:44.459Z","endedAt":"2026-07-25T20:03:43.914Z"},"Noche":{"startedAt":"2026-07-25T22:22:27.807Z","endedAt":"2026-07-25T23:16:02.986Z"}}'::jsonb);

DO $$
DECLARE
  v_timings jsonb;
  v_ini timestamptz; v_fin timestamptz; v_dur numeric; v_conf boolean;
BEGIN
  SELECT timings INTO v_timings FROM qa210_fixture;
  RAISE NOTICE '';
  RAISE NOTICE '── 1 · El caso real: 211 min en una ventana de 13 segundos ──';

  -- Tal cual lo mandaba el cliente viejo: started_at = reloj de pared del
  -- instante del cierre, DESPUÉS de que terminaron los tres turnos.
  INSERT INTO ci_sessions
    (country, city, zone, observed_date, user_email, started_at, ended_at,
     duration_minutes, rows_saved, turno_timings, duration_confiable, duration_motivo)
  VALUES
    ('Peru','QA210_Airport_B',NULL,'2026-07-25','qa210@local.test',
     '2026-07-25T23:18:44.861Z','2026-07-25T23:18:57.894Z',
     211.0, 306, v_timings, true, NULL)
  RETURNING started_at, ended_at, duration_minutes, duration_confiable
    INTO v_ini, v_fin, v_dur, v_conf;

  PERFORM pg_temp.ok(v_ini = '2026-07-25T14:42:43.628Z'::timestamptz,
    'started_at se corrige al primer turno real', v_ini::text);
  PERFORM pg_temp.ok(v_fin = '2026-07-25T23:18:57.894Z'::timestamptz,
    'ended_at NO se toca (es el cierre real)', v_fin::text);
  PERFORM pg_temp.ok(v_dur = 211.0,
    'duration_minutes NO se toca — era el dato bueno', v_dur::text);
  PERFORM pg_temp.ok(v_conf,
    'sigue siendo confiable (no se degrada una medición legítima)', v_conf::text);
  PERFORM pg_temp.ok(v_dur <= extract(epoch from (v_fin - v_ini))/60 + 1,
    'y ahora la ventana CONTIENE al trabajo',
    round(extract(epoch from (v_fin - v_ini))/60,1)::text || ' min de ventana');
END $$;

DO $$
DECLARE
  v_timings jsonb;
  v_ini timestamptz;
BEGIN
  SELECT timings INTO v_timings FROM qa210_fixture;
  RAISE NOTICE '';
  RAISE NOTICE '── 2 · Solo ENSANCHA: una ventana más ancha se respeta ──────';
  -- El hub abrió la sesión 40 min antes de llenar su primera celda. Esa
  -- preparación es real y no hay que recortarla.
  INSERT INTO ci_sessions
    (country, city, zone, observed_date, user_email, started_at, ended_at,
     duration_minutes, rows_saved, turno_timings, duration_confiable, duration_motivo)
  VALUES
    ('Peru','QA210_Ancha',NULL,'2026-07-25','qa210@local.test',
     '2026-07-25T14:02:43.628Z','2026-07-25T23:18:57.894Z',
     211.0, 306, v_timings, true, NULL)
  RETURNING started_at INTO v_ini;

  PERFORM pg_temp.ok(v_ini = '2026-07-25T14:02:43.628Z'::timestamptz,
    'started_at anterior al primer turno se RESPETA', v_ini::text);
END $$;

DO $$
DECLARE v_ini timestamptz; v_conf boolean; v_motivo text;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '── 3 · Sin turno_timings no hay de dónde corregir ───────────';
  INSERT INTO ci_sessions
    (country, city, zone, observed_date, user_email, started_at, ended_at,
     duration_minutes, rows_saved, turno_timings, duration_confiable, duration_motivo)
  VALUES
    ('Peru','QA210_SinTimings',NULL,'2026-07-25','qa210@local.test',
     '2026-07-25T20:00:00Z','2026-07-25T20:30:00Z',
     30.0, 36, NULL, NULL, NULL)
  RETURNING started_at, duration_confiable, duration_motivo
    INTO v_ini, v_conf, v_motivo;

  PERFORM pg_temp.ok(v_ini = '2026-07-25T20:00:00Z'::timestamptz,
    'started_at queda tal cual', v_ini::text);
  PERFORM pg_temp.ok(NOT v_conf,
    'y sin timings la fila no es confiable (mig 195/199)', coalesce(v_motivo,'null'));
END $$;

DO $$
DECLARE
  v_timings jsonb;
  v_ini timestamptz; v_conf boolean; v_motivo text;
BEGIN
  SELECT timings INTO v_timings FROM qa210_fixture;
  RAISE NOTICE '';
  RAISE NOTICE '── 4 · El piso de la mig 201 sigue vivo ─────────────────────';
  INSERT INTO ci_sessions
    (country, city, zone, observed_date, user_email, started_at, ended_at,
     duration_minutes, rows_saved, turno_timings, duration_confiable, duration_motivo)
  VALUES
    ('Peru','QA210_Juguete',NULL,'2026-07-25','qa210@local.test',
     '2026-07-25T23:18:44Z','2026-07-25T23:18:50Z',
     0.1, 306, v_timings, true, NULL)
  RETURNING started_at, duration_confiable, duration_motivo
    INTO v_ini, v_conf, v_motivo;

  PERFORM pg_temp.ok(NOT v_conf AND v_motivo = 'duracion_de_juguete',
    'una duración de 0.1 min sigue perdiendo la confianza', v_motivo);
  PERFORM pg_temp.ok(v_ini = '2026-07-25T14:42:43.628Z'::timestamptz,
    'y la ventana igual se corrige', v_ini::text);
END $$;

DO $$
DECLARE
  v_timings jsonb;
  v_id bigint; v_ini timestamptz;
BEGIN
  SELECT timings INTO v_timings FROM qa210_fixture;
  RAISE NOTICE '';
  RAISE NOTICE '── 5 · El UPDATE del backfill (mig 196) también lo respeta ──';
  INSERT INTO ci_sessions
    (country, city, zone, observed_date, user_email, started_at, ended_at,
     duration_minutes, rows_saved, turno_timings, duration_confiable, duration_motivo)
  VALUES
    ('Peru','QA210_Update',NULL,'2026-07-25','qa210@local.test',
     '2026-07-25T14:42:43.628Z','2026-07-25T23:18:57.894Z',
     5.0, 306, v_timings, true, NULL)
  RETURNING id INTO v_id;

  -- El backfill reescribe la duración al valor real de los turnos.
  UPDATE ci_sessions SET duration_minutes = 211.0 WHERE id = v_id
  RETURNING started_at INTO v_ini;

  PERFORM pg_temp.ok(v_ini = '2026-07-25T14:42:43.628Z'::timestamptz,
    'tras el UPDATE la ventana sigue conteniendo al trabajo', v_ini::text);
END $$;

DO $$
DECLARE v_mal int;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '── 6 · Las dos invariantes, sobre TODA la tabla ─────────────';
  SELECT count(*) INTO v_mal FROM ci_sessions
   WHERE duration_confiable AND duration_minutes < 1;
  PERFORM pg_temp.ok(v_mal = 0, 'ninguna confiable con menos de 1 minuto', v_mal::text);

  SELECT count(*) INTO v_mal FROM ci_sessions
   WHERE duration_confiable
     AND duration_minutes > extract(epoch from (ended_at - started_at))/60 + 1;
  PERFORM pg_temp.ok(v_mal = 0, 'ninguna confiable excede su propia ventana', v_mal::text);

  SELECT count(*) INTO v_mal FROM ci_sessions WHERE started_at > ended_at;
  PERFORM pg_temp.ok(v_mal = 0, 'ninguna ventana invertida', v_mal::text);
END $$;

DO $$ BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '✓ TODAS LAS SIMULACIONES DE LA 210 PASARON';
END $$;

ROLLBACK;
