-- ============================================================
-- MIGRACIÓN 153: cierre administrativo de sesiones colgadas
-- ============================================================
--
-- CONTEXTO: el panel "Progreso guardado sin terminar" (mig 147,
-- get_unfinished_ci_sessions) hasta ahora era de SOLO LECTURA — el admin
-- veía a quién preguntarle, pero no tenía forma de cerrar la sesión desde
-- ahí. Con "Terminar Sesión" ahora exigiendo SIEMPRE la grilla completa
-- (mig 151/Fase A de este plan), este panel deja de ser síntoma de un
-- modo permisivo y pasa a ser lo que siempre debió ser: la red de
-- seguridad para cuando a un hub se le corta la sesión de verdad
-- (batería, corte de red, llamada urgente) — casos que van a seguir
-- pasando pase lo que pase.
--
-- Esta RPC NUNCA toca pricing_observations — lo que el hub ya guardó con
-- "Guardar Progreso" queda intacto. Solo agrega la fila de cierre en
-- ci_sessions (con `closed_by` = el admin que cerró, para que quede claro
-- que no fue el propio hub) y limpia el latido si seguía vivo.
-- ============================================================

ALTER TABLE public.ci_sessions
  ADD COLUMN IF NOT EXISTS closed_by text;

COMMENT ON COLUMN public.ci_sessions.closed_by IS
  'Email del admin que cerró esta sesión manualmente desde Monitoreo (ver admin_close_ci_session, mig 153). NULL = el propio hub la terminó con "Terminar Sesión".';

CREATE OR REPLACE FUNCTION public.admin_close_ci_session(
  p_country       text,
  p_city          text,
  p_zone          text,
  p_observed_date date,
  p_user_email    text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_admin      text := auth.email();
  v_started_at timestamptz;
  v_rows_saved bigint;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'access_denied: cerrar sesiones es solo para admin'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM require_country_access(p_country);

  -- Si el latido (mig 146) sigue vivo, su started_at es el dato real de
  -- cuándo arrancó — si ya no está (el hub cerró la laptop hace rato y el
  -- latido quedó viejo/limpiado), no hay forma de saberlo: se usa `now()`
  -- como fallback, quedando duration_minutes en 0 (mejor un 0 explícito
  -- que inventar un número).
  SELECT started_at INTO v_started_at
  FROM ci_active_sessions
  WHERE user_email = p_user_email
  LIMIT 1;

  -- Igual criterio de zona que get_unfinished_ci_sessions (mig 147): Corp
  -- guarda zone='' en algunas filas viejas.
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
    started_at, ended_at, duration_minutes, rows_saved, closed_by
  ) VALUES (
    p_country, p_city, p_zone, p_observed_date, p_user_email,
    COALESCE(v_started_at, now()), now(),
    CASE WHEN v_started_at IS NOT NULL
      THEN round(EXTRACT(EPOCH FROM (now() - v_started_at)) / 60.0, 1)
      ELSE 0
    END,
    COALESCE(v_rows_saved, 0),
    v_admin
  );

  DELETE FROM ci_active_sessions WHERE user_email = p_user_email;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.admin_close_ci_session(text, text, text, date, text) TO authenticated;

-- ============================================================
-- VERIFICACIÓN
--   SELECT admin_close_ci_session('Peru','Lima_Airport_A',NULL,current_date,'hub1@yango.test');
--    (falla con access_denied si el que llama no es admin)
--   SELECT * FROM ci_sessions WHERE closed_by IS NOT NULL ORDER BY id DESC LIMIT 1;
-- ============================================================
