-- ============================================================
-- MIGRACIÓN 150: progreso por turno visible en Monitoreo
-- ============================================================
--
-- CONTEXTO: la grilla de Ingresar CI ahora se organiza por turno
-- (Mañana/Tarde/Noche, ver mig 148 y el reorg de DataEntry.jsx) — el hub
-- completa un turno entero antes de pasar al siguiente. Pero Monitoreo
-- solo mostraba el progreso TOTAL (filled_count/total_expected), que no
-- dice nada de en qué turno está trabado un hub ni si ya cerró la mañana
-- y sigue con la tarde. El admin no tenía forma de distinguir "recién
-- arrancando la mañana" de "atascado en la noche" con el mismo número
-- total.
--
-- Fix: el cliente (sendHeartbeat) ahora manda también el desglose por
-- turno — mismo criterio que recent_failures (mig 149): dato adicional,
-- no autoritativo, puramente informativo para el admin.
-- ============================================================

ALTER TABLE public.ci_active_sessions
  ADD COLUMN IF NOT EXISTS turno_progress jsonb;

COMMENT ON COLUMN public.ci_active_sessions.turno_progress IS
  'Progreso por turno reportado por el cliente en cada latido: {"total_per_turno": N, "filled": {"<label turno>": N, ...}}. Null en filas viejas (previas a esta mig) o si el cliente no lo manda. Solo informativo para Monitoreo — no se usa para ningún cálculo del lado del servidor.';

DROP FUNCTION IF EXISTS public.upsert_ci_active_session(text, text, text, date, int, int, int);

CREATE OR REPLACE FUNCTION public.upsert_ci_active_session(
  p_country         text,
  p_city            text,
  p_zone            text,
  p_observed_date   date,
  p_filled_count    int,
  p_total_expected  int,
  p_recent_failures int DEFAULT 0,
  p_turno_progress  jsonb DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_email text := auth.email();
BEGIN
  IF v_email IS NULL THEN
    RAISE EXCEPTION 'no_session' USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO ci_active_sessions (
    user_email, country, city, zone, observed_date,
    filled_count, total_expected, recent_failures, turno_progress,
    started_at, last_seen_at
  ) VALUES (
    v_email, p_country, p_city, p_zone, p_observed_date,
    p_filled_count, p_total_expected, p_recent_failures, p_turno_progress,
    now(), now()
  )
  ON CONFLICT (user_email) DO UPDATE SET
    country         = EXCLUDED.country,
    city            = EXCLUDED.city,
    zone            = EXCLUDED.zone,
    observed_date   = EXCLUDED.observed_date,
    filled_count    = EXCLUDED.filled_count,
    total_expected  = EXCLUDED.total_expected,
    recent_failures = EXCLUDED.recent_failures,
    turno_progress  = EXCLUDED.turno_progress,
    last_seen_at    = now();
    -- started_at deliberadamente FUERA del SET (ver mig 146).
END;
$function$;

GRANT EXECUTE ON FUNCTION public.upsert_ci_active_session(text, text, text, date, int, int, int, jsonb) TO authenticated;

-- ============================================================
-- VERIFICACIÓN
--   SELECT upsert_ci_active_session('Peru','Lima',NULL,current_date,5,40,0,
--     '{"total_per_turno":40,"filled":{"Mañana":5,"Tarde":0,"Noche":0}}'::jsonb);
--   SELECT turno_progress FROM ci_active_sessions WHERE user_email = auth.email();
--   -- Llamada vieja de 7 args (sin turno_progress) sigue funcionando, default NULL:
--   SELECT upsert_ci_active_session('Peru','Lima',NULL,current_date,8,40,0);
--   SELECT turno_progress FROM ci_active_sessions WHERE user_email = auth.email(); -- NULL
-- ============================================================
