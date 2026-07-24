-- ════════════════════════════════════════════════════════════════════════
-- 160_ci_session_handoff.sql — relevo entre hubs a mitad de sesión
-- (pedido user 2026-07-24, punto 3: "si el hub avanza un turno y se
-- accidenta, ¿cómo sigue otro hub?").
--
-- HALLAZGO clave: hoy, si el Hub B entra a una (ciudad, zona, fecha) que
-- YA trabajó el Hub A, el auto-load de la grilla NO carga el trabajo de
-- Hub A — a propósito (mig 139: cargar filas ajenas duplicaría al
-- re-guardar, porque el DELETE de "Guardar progreso" siempre es por
-- dueño). Sin un mecanismo explícito, un relevo real haría que Hub B
-- vea una grilla vacía y termine re-haciendo el turno que Hub A ya
-- completó.
--
-- SOLUCIÓN: reasignar las filas YA GUARDADAS de Hub A → Hub B
-- (pricing_observations.uploaded_by). A partir de ahí son "propias" de
-- Hub B y su auto-load normal (sin cambios de código) las carga solo.
--
-- 1. get_ci_session_turno_timings — lectura, cualquier authenticated con
--    acceso al país (mismo criterio que get_active_sessions_presence):
--    trae el turno_timings más reciente para (country, city, zone, date)
--    SIN IMPORTAR quién lo generó. El cliente lo usa para seedear los
--    timings por turno ANTES de que el efecto de estampado corra sobre
--    la grilla recién auto-cargada — sin esto, un turno ya completo por
--    OTRO hub se re-estamparía con el timestamp de "ahora" del hub que
--    lo carga, arruinando la métrica de velocidad (mismo bug que ya se
--    evitó para reabrir-desde-Historial, generalizado acá al auto-load).
--
-- 2. admin_reassign_ci_session — solo admin. Cierra la sesión activa de
--    origen si existe (mismo camino que admin_close_ci_session, así el
--    tiempo parcial de Hub A no se pierde) y reasigna sus filas
--    guardadas a destino. El rastro de auditoría ("Editada Nx — última
--    vez por X") ya agrupa por (ciudad|zona|fecha) sin filtrar por
--    usuario, así que el relevo queda visible en Historial sin cambios
--    adicionales.
-- ════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.get_ci_session_turno_timings(
  p_country text, p_city text, p_zone text, p_observed_date date
)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  PERFORM require_country_access(p_country);
  SELECT turno_timings INTO v_result
  FROM ci_sessions
  WHERE country = p_country
    AND city = p_city
    AND COALESCE(NULLIF(zone, ''), '') = COALESCE(NULLIF(p_zone, ''), '')
    AND observed_date = p_observed_date
    AND turno_timings IS NOT NULL
  ORDER BY started_at DESC
  LIMIT 1;
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.admin_reassign_ci_session(
  p_country text, p_city text, p_zone text, p_observed_date date,
  p_from_email text, p_to_email text
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_rows_reassigned bigint;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'access_denied: reasignar sesiones es solo para admin'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM require_country_access(p_country);

  IF p_from_email = p_to_email THEN
    RAISE EXCEPTION 'invalid_input: el hub origen y destino no pueden ser el mismo';
  END IF;

  -- Cerrar primero la sesión activa de origen (si existe) — deja su rastro
  -- de tiempo/filas en ci_sessions ANTES de reasignar filas, mismo criterio
  -- que un cierre administrativo normal (mig 157/159): si no se hace acá,
  -- el tiempo parcial de Hub A en el turno que estaba trabajando se pierde.
  IF EXISTS (
    SELECT 1 FROM ci_active_sessions
    WHERE user_email = p_from_email
      AND country = p_country
      AND city = p_city
      AND COALESCE(NULLIF(zone, ''), '') = COALESCE(NULLIF(p_zone, ''), '')
      AND observed_date = p_observed_date
  ) THEN
    PERFORM admin_close_ci_session(p_country, p_city, p_zone, p_observed_date, p_from_email);
  END IF;

  -- Reasignar las filas YA guardadas: de acá en más son "de" p_to_email, así
  -- que el próximo auto-load de Hub B (loadObservationsIntoForm, que SIEMPRE
  -- filtra por uploaded_by=self) las trae solas, sin duplicar nada al
  -- re-guardar.
  UPDATE pricing_observations
  SET uploaded_by = p_to_email
  WHERE country = p_country
    AND city = p_city
    AND COALESCE(NULLIF(zone, ''), '') = COALESCE(NULLIF(p_zone, ''), '')
    AND observed_date = p_observed_date
    AND uploaded_by = p_from_email
    AND data_source = 'manual';
  GET DIAGNOSTICS v_rows_reassigned = ROW_COUNT;

  IF v_rows_reassigned = 0 THEN
    RAISE EXCEPTION 'nothing_to_reassign: % no tiene filas guardadas en %/%/%/% para reasignar',
      p_from_email, p_country, p_city, p_zone, p_observed_date;
  END IF;
END;
$function$;
