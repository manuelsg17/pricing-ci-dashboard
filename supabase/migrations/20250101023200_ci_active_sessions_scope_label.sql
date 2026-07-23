-- ============================================================
-- MIGRACIÓN 151: alcance de sesión declarado, visible en Monitoreo
-- ============================================================
--
-- CONTEXTO: Aeropuerto Punto A y Punto B son dos ciudades de BD
-- independientes (`{Base}_Airport_A` / `_B`) — hasta ahora el latido
-- (ci_active_sessions) solo mostraba en cuál de las dos estaba el hub EN
-- ESTE MOMENTO, sin decir si declaró de entrada "solo A", "solo B" o
-- "ambos" (ver selector de alcance nuevo en DataEntry.jsx). Un hub
-- trabajando "Ambos" se veía en Monitoreo saltando de A a B sin contexto.
--
-- Fix: el cliente manda también una etiqueta libre con el alcance
-- declarado (ej. "Airport_A+B", "Airport_B") — mismo criterio que
-- recent_failures/turno_progress (migs 149-150): dato adicional,
-- puramente informativo para el admin, nunca usado para ningún cálculo
-- del lado del servidor.
-- ============================================================

ALTER TABLE public.ci_active_sessions
  ADD COLUMN IF NOT EXISTS scope_label text;

COMMENT ON COLUMN public.ci_active_sessions.scope_label IS
  'Alcance de sesión declarado por el hub al Iniciar Sesión (solo Aeropuerto): ej. "Airport_A", "Airport_B" o "Airport_A+B". Null fuera de Aeropuerto o en filas viejas. Puramente informativo para Monitoreo.';

DROP FUNCTION IF EXISTS public.upsert_ci_active_session(text, text, text, date, int, int, int, jsonb);

CREATE OR REPLACE FUNCTION public.upsert_ci_active_session(
  p_country         text,
  p_city            text,
  p_zone            text,
  p_observed_date   date,
  p_filled_count    int,
  p_total_expected  int,
  p_recent_failures int DEFAULT 0,
  p_turno_progress  jsonb DEFAULT NULL,
  p_scope_label     text DEFAULT NULL
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
    filled_count, total_expected, recent_failures, turno_progress, scope_label,
    started_at, last_seen_at
  ) VALUES (
    v_email, p_country, p_city, p_zone, p_observed_date,
    p_filled_count, p_total_expected, p_recent_failures, p_turno_progress, p_scope_label,
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
    scope_label     = EXCLUDED.scope_label,
    last_seen_at    = now();
    -- started_at deliberadamente FUERA del SET (ver mig 146).
END;
$function$;

GRANT EXECUTE ON FUNCTION public.upsert_ci_active_session(text, text, text, date, int, int, int, jsonb, text) TO authenticated;

-- ============================================================
-- VERIFICACIÓN
--   SELECT upsert_ci_active_session('Peru','Lima_Airport_A',NULL,current_date,5,40,0,
--     '{"total_per_turno":40,"filled":{"Mañana":5,"Tarde":0,"Noche":0}}'::jsonb,
--     'Airport_A+B');
--   SELECT scope_label FROM ci_active_sessions WHERE user_email = auth.email();
--   -- Llamada vieja de 8 args (sin scope_label) sigue funcionando, default NULL:
--   SELECT upsert_ci_active_session('Peru','Lima',NULL,current_date,8,40,0);
--   SELECT scope_label FROM ci_active_sessions WHERE user_email = auth.email(); -- NULL
-- ============================================================
