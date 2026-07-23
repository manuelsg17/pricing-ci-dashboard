-- ============================================================
-- MIGRACIÓN 156: 3 fixes de revisión adversarial (2026-07-23)
-- ============================================================
--
-- Repaso adversarial de las migraciones 151-155 (Fases A-G de reglas de
-- sesión para Ingresar CI) encontró 3 bugs reales de lado servidor:
--
-- 1) `admin_close_ci_session` (mig 153) tocaba `ci_active_sessions` SOLO
--    por `user_email` — como esa tabla tiene PK=user_email (una sola fila
--    "dónde está ahora" por hub), cerrar una sesión VIEJA/colgada de un
--    hub que HOY está activo en otra ciudad le robaba el `started_at` real
--    a esa sesión archivada (quedaba con datos de la sesión en curso) Y
--    borraba el latido vivo de la sesión real — el hub desaparecía de "en
--    vivo"/presencia aunque siguiera trabajando. Fix: acotar el
--    SELECT/DELETE también por (country, city, zone, observed_date) — solo
--    tocar el latido si corresponde EXACTO a la sesión que se está
--    cerrando.
--
-- 2) `get_hub_monitoring` (mig 155): el `DISTINCT ON (...) ORDER BY ...
--    started_at DESC` de `sess_zone` podía desempatar de forma no
--    determinística si dos filas de la MISMA zona tenían el mismo
--    started_at exacto — con el fix de (1), una fila cerrada por admin ya
--    no debería "robar" started_at de una real, pero igual conviene un
--    desempate determinístico. Fix: agregar `cs.id DESC` como criterio
--    final (la fila con mayor id = la más reciente insertada, sin
--    ambigüedad).
--
-- 3) `upsert_ci_active_session` (mig 146, tocada en 149-151) nunca llamaba
--    `require_country_access(p_country)` — inofensivo mientras el RLS de
--    `ci_active_sessions` solo dejaba ver la fila propia o admin, pero la
--    mig 152 (`get_active_sessions_presence`) expone filas de OTROS
--    usuarios a cualquier authenticated con acceso a ESE país. Sin este
--    chequeo, un usuario con acceso solo al país X podía llamar
--    `upsert_ci_active_session('Y', ...)` e inyectar una fila de presencia
--    falsa visible para los hubs/admin reales del país Y. Fix: agregar el
--    mismo gate que ya usan el resto de las RPCs country-aware.
-- ============================================================

-- ── Fix 1: admin_close_ci_session acota por sesión exacta ──────────────
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

  -- Acotado a la sesión EXACTA que se está cerrando (country/city/zone/
  -- fecha) — antes solo filtraba por user_email, y como ci_active_sessions
  -- tiene una sola fila por hub, cerrar una sesión vieja podía robarle el
  -- started_at real y borrar el latido de una sesión ACTIVA distinta del
  -- mismo hub.
  SELECT started_at INTO v_started_at
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

  -- Mismo criterio de acotado — solo borra el latido si es EXACTO el de
  -- la sesión que se acaba de cerrar, nunca uno vivo no relacionado.
  DELETE FROM ci_active_sessions
  WHERE user_email = p_user_email
    AND country = p_country
    AND city = p_city
    AND COALESCE(NULLIF(zone, ''), '') = COALESCE(NULLIF(p_zone, ''), '')
    AND observed_date = p_observed_date;
END;
$function$;

-- ── Fix 2: get_hub_monitoring, desempate determinístico por id ─────────
CREATE OR REPLACE FUNCTION public.get_hub_monitoring(
  p_country text,
  p_from    date,
  p_to      date
) RETURNS TABLE(
  city           text,
  observed_date  date,
  uploaded_by    text,
  n_rows         bigint,
  n_categories   bigint,
  n_competitors  bigint,
  started_at     timestamptz,
  ended_at       timestamptz,
  total_expected bigint
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'access_denied: el monitoreo es solo para admin'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM require_country_access(p_country);

  RETURN QUERY
  WITH agg AS (
    SELECT
      po.city,
      po.observed_date,
      COALESCE(po.uploaded_by, '(sin dueño)') AS uploaded_by,
      count(*)::bigint                            AS n_rows,
      count(DISTINCT po.category)::bigint         AS n_categories,
      count(DISTINCT po.competition_name)::bigint AS n_competitors
    FROM pricing_observations po
    WHERE po.country = p_country
      AND po.data_source = 'manual'
      AND po.observed_date BETWEEN p_from AND p_to
    GROUP BY po.city, po.observed_date, COALESCE(po.uploaded_by, '(sin dueño)')
  ),
  sess_zone AS (
    SELECT DISTINCT ON (cs.city, cs.observed_date, cs.user_email, cs.zone)
      cs.city, cs.observed_date, cs.user_email, cs.zone,
      cs.total_expected, cs.started_at, cs.ended_at
    FROM ci_sessions cs
    WHERE cs.country = p_country
      AND cs.observed_date BETWEEN p_from AND p_to
    -- `cs.id DESC` desempata determinísticamente si dos revisiones de la
    -- MISMA zona tuvieran started_at idéntico (antes podía tomar cualquiera
    -- de las dos arbitrariamente).
    ORDER BY cs.city, cs.observed_date, cs.user_email, cs.zone, cs.started_at DESC, cs.id DESC
  ),
  sess_agg AS (
    SELECT
      sz.city, sz.observed_date, sz.user_email,
      MIN(sz.started_at)                              AS started_at,
      MAX(sz.ended_at)                                 AS ended_at,
      SUM(COALESCE(sz.total_expected, 0))::bigint      AS total_expected
    FROM sess_zone sz
    GROUP BY sz.city, sz.observed_date, sz.user_email
  )
  SELECT
    a.city, a.observed_date, a.uploaded_by,
    a.n_rows, a.n_categories, a.n_competitors,
    s.started_at, s.ended_at, s.total_expected
  FROM agg a
  LEFT JOIN sess_agg s
    ON s.city = a.city AND s.observed_date = a.observed_date AND s.user_email = a.uploaded_by;
END;
$function$;

-- ── Fix 3: upsert_ci_active_session valida acceso al país ───────────────
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
  -- Antes de la mig 152 (get_active_sessions_presence) esto era inofensivo:
  -- el RLS de ci_active_sessions solo dejaba ver la fila propia o admin. Con
  -- 152 exponiendo presencia de OTROS hubs a cualquier authenticated con
  -- acceso al país, faltaba este mismo gate que ya usan el resto de las
  -- RPCs country-aware — sin él, alguien con acceso solo al país X podía
  -- mandar un latido falso para el país Y y aparecer como presencia real
  -- para los hubs/admin de Y.
  PERFORM require_country_access(p_country);

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

-- ============================================================
-- VERIFICACIÓN
--   -- Fix 1: cerrar una sesión vieja de Trujillo no debe tocar un latido
--   -- vivo de Lima del MISMO hub.
--   -- Fix 3: llamar upsert_ci_active_session con un país sin acceso debe
--   -- fallar con access_denied (antes pasaba sin chequeo).
-- ============================================================
