-- ════════════════════════════════════════════════════════════════════════
-- 159_ci_turno_timings.sql — medir cuánto tarda cada hub por turno
-- (Mañana/Tarde/Noche), no solo la sesión completa.
--
-- Pedido del user (2026-07-24): "quiero medir el tiempo que les toma
-- avanzar cada turno... para saber quién es más rápido". Hasta ahora
-- ci_sessions solo guarda started_at/ended_at de la SESIÓN entera —
-- ninguna granularidad por turno.
--
-- El cliente (DataEntry.jsx) ya estampa `turnoTimings` por bucket
-- (ciudad/zona) en cuanto detecta el primer fill (startedAt) y el 100%
-- relleno (endedAt) de cada turno, y lo manda:
--   1. En cada heartbeat (ci_active_sessions.turno_progress.timings) —
--      reusa la MISMA columna jsonb que mig 150 ya agregó para
--      total_per_turno/filled (aditivo, LiveSessionsPanel solo lee esas
--      2 claves, no rompe nada).
--   2. Al Terminar Sesión, en el INSERT directo a ci_sessions (columna
--      nueva de esta migración).
--
-- Este archivo solo cubre el lado servidor que faltaba: la columna en
-- ci_sessions, y que el cierre ADMINISTRATIVO (force-close desde
-- Monitoreo) copie los timings del heartbeat antes de borrarlo — mismo
-- patrón que mig 157 ya aplicó para total_expected (sin esto, un force-
-- close perdería en silencio el tiempo parcial acumulado del turno en
-- curso).
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE public.ci_sessions
  ADD COLUMN IF NOT EXISTS turno_timings jsonb;

COMMENT ON COLUMN public.ci_sessions.turno_timings IS
  'Timestamps de inicio/fin por turno: {"Mañana": {"startedAt": ISO, "endedAt": ISO}, "Tarde": {...}, "Noche": {...}}. Solo trae timestamps de turnos que el hub llegó a tocar; un turno nunca iniciado no aparece.';

CREATE OR REPLACE FUNCTION public.admin_close_ci_session(p_country text, p_city text, p_zone text, p_observed_date date, p_user_email text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_admin          text := auth.email();
  v_started_at     timestamptz;
  v_total_expected int;
  v_turno_timings  jsonb;
  v_rows_saved     bigint;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'access_denied: cerrar sesiones es solo para admin'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM require_country_access(p_country);

  -- turno_progress->'timings' (mig 159): mismo motivo que total_expected
  -- (mig 157) — un latido en vuelo puede tener el dato más fresco que lo
  -- que el cliente llegue a mandar en su propio Terminar Sesión.
  SELECT started_at, total_expected, turno_progress->'timings'
    INTO v_started_at, v_total_expected, v_turno_timings
  FROM ci_active_sessions
  WHERE user_email = p_user_email
    AND country = p_country
    AND city = p_city
    AND COALESCE(NULLIF(zone, ''), '') = COALESCE(NULLIF(p_zone, ''), '')
    AND observed_date = p_observed_date
  LIMIT 1;

  SELECT count(*) INTO v_rows_saved
  FROM pricing_observations po
  WHERE po.country = p_country
    AND po.city = p_city
    AND COALESCE(NULLIF(po.zone, ''), '') = COALESCE(NULLIF(p_zone, ''), '')
    AND po.observed_date = p_observed_date
    AND po.uploaded_by = p_user_email
    AND po.data_source = 'manual';

  INSERT INTO ci_sessions (
    country, city, zone, observed_date, user_email,
    started_at, ended_at, duration_minutes, rows_saved, total_expected,
    turno_timings, closed_by
  ) VALUES (
    p_country, p_city, p_zone, p_observed_date, p_user_email,
    COALESCE(v_started_at, now()), now(),
    CASE WHEN v_started_at IS NOT NULL
      THEN round(EXTRACT(EPOCH FROM (now() - v_started_at)) / 60.0, 1)
      ELSE 0
    END,
    COALESCE(v_rows_saved, 0),
    v_total_expected,
    v_turno_timings,
    v_admin
  );

  DELETE FROM ci_active_sessions
  WHERE user_email = p_user_email
    AND country = p_country
    AND city = p_city
    AND COALESCE(NULLIF(zone, ''), '') = COALESCE(NULLIF(p_zone, ''), '')
    AND observed_date = p_observed_date;
END;
$function$;
