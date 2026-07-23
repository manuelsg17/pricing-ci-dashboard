-- ============================================================
-- MIGRACIÓN 157: admin_close_ci_session persiste total_expected
-- ============================================================
--
-- Segunda pasada de revisión adversarial (2026-07-23) sobre las migraciones
-- 151-156 encontró un bug real en `admin_close_ci_session` (mig 153/156):
-- lee `started_at` de la fila viva de `ci_active_sessions` para calcular la
-- duración, pero NUNCA lee `total_expected` de esa misma fila — el INSERT en
-- `ci_sessions` simplemente omite esa columna, que queda NULL.
--
-- Como `get_hub_monitoring` (mig 155/156) arma `sess_zone` con
-- `DISTINCT ON (city, observed_date, user_email, zone) ORDER BY started_at
-- DESC, id DESC`, la fila insertada por un cierre administrativo pasa a ser
-- la "última" de esa zona — y su `total_expected` NULL hace que
-- `sess_agg`'s `SUM(COALESCE(total_expected, 0))` colapse a 0 para esa zona.
-- Resultado real: Monitoreo → Detalle muestra "25 filas guardadas / 0
-- disponibles" en vez de "25/40", justo para las sesiones colgadas que un
-- admin fuerza a cerrar — rompiendo en silencio la columna que la mig 155
-- vino a agregar, exactamente para esa clase de sesiones.
--
-- Fix: leer también `total_expected` de la fila viva (mismo SELECT que ya
-- trae `started_at`) y persistirlo en el INSERT.
-- ============================================================

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
  v_admin          text := auth.email();
  v_started_at     timestamptz;
  v_total_expected int;
  v_rows_saved     bigint;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'access_denied: cerrar sesiones es solo para admin'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM require_country_access(p_country);

  -- Acotado a la sesión EXACTA que se está cerrando (mig 156) — trae también
  -- total_expected, que antes se perdía en el cierre administrativo.
  SELECT started_at, total_expected INTO v_started_at, v_total_expected
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
    started_at, ended_at, duration_minutes, rows_saved, total_expected, closed_by
  ) VALUES (
    p_country, p_city, p_zone, p_observed_date, p_user_email,
    COALESCE(v_started_at, now()), now(),
    CASE WHEN v_started_at IS NOT NULL
      THEN round(EXTRACT(EPOCH FROM (now() - v_started_at)) / 60.0, 1)
      ELSE 0
    END,
    COALESCE(v_rows_saved, 0),
    v_total_expected,
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

-- ============================================================
-- VERIFICACIÓN
--   -- Cerrar una sesión colgada con total_expected=40 en su latido vivo debe
--   -- dejar la fila de ci_sessions con total_expected=40, no NULL/0.
-- ============================================================
