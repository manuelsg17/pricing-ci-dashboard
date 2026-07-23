-- ============================================================
-- MIGRACIÓN 149: fallos recientes de latido, visibles en Monitoreo
-- ============================================================
--
-- CONTEXTO: sendHeartbeat (DataEntry.jsx) traga cualquier error en
-- silencio a propósito (nunca debe interrumpir al hub) — pero eso deja al
-- admin sin forma de distinguir "el hub cerró la laptop" de "la red del
-- hub está fallando intermitentemente" (como pasó hoy con Ray): en ambos
-- casos, `ci_active_sessions.last_seen_at` simplemente deja de avanzar, y
-- se ven IDÉNTICOS desde Monitoreo.
--
-- Fix: el cliente cuenta sus propios fallos de latido consecutivos (un
-- contador local, sin tocar el flujo real del hub). Cuando un latido POR
-- FIN tiene éxito después de 1+ fallos, reporta ese conteo junto con el
-- latido normal — así una sesión que sigue "en vivo" puede mostrar que
-- tuvo problemas intermitentes ANTES de que el hub tenga que avisar.
-- ============================================================

ALTER TABLE public.ci_active_sessions
  ADD COLUMN IF NOT EXISTS recent_failures int NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.ci_active_sessions.recent_failures IS
  'Fallos de sendHeartbeat() consecutivos, contados client-side, reportados en el latido exitoso siguiente — señal de conectividad intermitente para Monitoreo (no autoritativa: si TODOS los latidos fallan, la fila simplemente deja de actualizarse, igual que hoy).';

-- CREATE OR REPLACE no alcanza acá: agregar un 7mo parámetro cambia la
-- IDENTIDAD de la función (el tipo de parámetros es parte de la firma), así
-- que sin este DROP quedarían DOS overloads (6 y 7 params) — una llamada
-- posicional con 6 args pasaría a ser ambigua entre ambas ("function ... is
-- not unique"). Detectado en verificación local antes de tocar prod.
DROP FUNCTION IF EXISTS public.upsert_ci_active_session(text, text, text, date, int, int);

CREATE OR REPLACE FUNCTION public.upsert_ci_active_session(
  p_country         text,
  p_city            text,
  p_zone            text,
  p_observed_date   date,
  p_filled_count    int,
  p_total_expected  int,
  p_recent_failures int DEFAULT 0
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
    filled_count, total_expected, recent_failures, started_at, last_seen_at
  ) VALUES (
    v_email, p_country, p_city, p_zone, p_observed_date,
    p_filled_count, p_total_expected, p_recent_failures, now(), now()
  )
  ON CONFLICT (user_email) DO UPDATE SET
    country         = EXCLUDED.country,
    city            = EXCLUDED.city,
    zone            = EXCLUDED.zone,
    observed_date   = EXCLUDED.observed_date,
    filled_count    = EXCLUDED.filled_count,
    total_expected  = EXCLUDED.total_expected,
    recent_failures = EXCLUDED.recent_failures,
    last_seen_at    = now();
    -- started_at deliberadamente FUERA del SET (ver mig 146).
END;
$function$;

GRANT EXECUTE ON FUNCTION public.upsert_ci_active_session(text, text, text, date, int, int, int) TO authenticated;

-- ============================================================
-- VERIFICACIÓN
--   SELECT upsert_ci_active_session('Peru','Lima',NULL,current_date,5,40,0);
--   SELECT recent_failures FROM ci_active_sessions WHERE user_email = auth.email(); -- 0
--   SELECT upsert_ci_active_session('Peru','Lima',NULL,current_date,8,40,3);
--   SELECT recent_failures FROM ci_active_sessions WHERE user_email = auth.email(); -- 3
--   SELECT upsert_ci_active_session('Peru','Lima',NULL,current_date,9,40); -- p_recent_failures omitido
--   SELECT recent_failures FROM ci_active_sessions WHERE user_email = auth.email(); -- 0 (default)
-- ============================================================
