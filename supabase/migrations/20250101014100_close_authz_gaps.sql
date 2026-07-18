-- ════════════════════════════════════════════════════════════════════════
-- Migración 101 — Cerrar gaps de mig 100 (audit final 2026-05-31)
--
-- CONTEXTO:
--   La verificación post-mig-100 identificó 2 huecos reales:
--
--   GAP 1: las RPCs get_indrive_summary, get_indrive_weekly,
--   get_indrive_counts, get_bot_vs_hubs_summary, get_available_zones
--   aceptan p_country sin require_country_access(). Vector: hub_expert
--   Peru llama get_indrive_summary(p_country=>'Colombia') y lee data
--   cross-country. Mig 100 solo dejó RAISE NOTICE como recordatorio.
--
--   GAP 2 (bonus): apply_indrive_bot_prices tenía signatures
--   superpuestas — la versión 3-arg (mig 65) quedó UNGUARDED en mig 100.
--
--   GAP 3: las RPCs get_indrive_* referenciaban bid_4/bid_5 que mig 98
--   dropeó. Si alguien las llamaba, fallaban con "column does not exist".
--
-- QUÉ HACE:
--   A) Drop de TODAS las firmas viejas de las 6 RPCs afectadas.
--   B) Re-create con PERFORM require_country_access(p_country) al inicio.
--   C) Limpiar referencias a bid_4/bid_5 en bid_proxy (mig 98 los dropeó).
--
-- LO QUE NO HACE:
--   - WITH CHECK por país en INSERT/UPDATE/DELETE de pricing_observations.
--     El audit lo flagueó pero es defensa redundante: INSERT/UPDATE/DELETE
--     ya están restringidos a can_edit()=is_admin() desde mig 88, y los
--     admins siempre pasan can_access_country (short-circuit).
--   - bot_upsert_observations (mig 91): corre como service_role (bypass
--     RLS). No exfilable por authenticated.
--
-- COMPAT:
--   - Frontend usa todos los callsites por nombre (sb.rpc('fn', {p_country,...}))
--     → orden interno no rompe.
--   - apply_indrive_bot_prices firma 2-arg de mig 100 se elimina y se
--     unifica en la 3-arg que esperaba el frontend.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ════════════════════════════════════════════════════════════════════════
-- A. get_available_zones
-- ════════════════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS get_available_zones(text, text, text);

CREATE OR REPLACE FUNCTION get_available_zones(
  p_city     text,
  p_category text,
  p_country  text
) RETURNS TABLE (zone text)
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM require_country_access(p_country);
  RETURN QUERY
  SELECT DISTINCT COALESCE(po.zone, 'All') AS zone
  FROM pricing_observations po
  WHERE po.country  = p_country
    AND po.city     = p_city
    AND po.category = p_category
  ORDER BY 1;
END;
$$;

GRANT EXECUTE ON FUNCTION get_available_zones(text, text, text) TO authenticated;

-- ════════════════════════════════════════════════════════════════════════
-- B. get_indrive_summary  (sin bid_4/bid_5, con guard)
-- ════════════════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS get_indrive_summary(text, numeric);
DROP FUNCTION IF EXISTS get_indrive_summary(numeric, text);

CREATE OR REPLACE FUNCTION get_indrive_summary(
  p_country         text,
  outlier_threshold numeric DEFAULT 100
)
RETURNS TABLE (
  city          text,
  category      text,
  obs_with_bids bigint,
  outlier_recs  bigint,
  avg_rec       numeric,
  min_rec       numeric,
  max_rec       numeric,
  avg_bid       numeric
)
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM require_country_access(p_country);
  RETURN QUERY
  WITH bid_proxy AS (
    SELECT
      po.city,
      po.category,
      po.recommended_price,
      CASE
        WHEN COALESCE(po.bid_1,0) > 0 OR COALESCE(po.bid_2,0) > 0 OR COALESCE(po.bid_3,0) > 0
        THEN (
          SELECT AVG(v) FROM UNNEST(ARRAY[
            NULLIF(po.bid_1,0), NULLIF(po.bid_2,0), NULLIF(po.bid_3,0)
          ]) t(v) WHERE v IS NOT NULL
        )
        WHEN po.price_without_discount > 0 THEN po.price_without_discount
        WHEN po.minimal_bid > 0            THEN po.minimal_bid
        ELSE NULL
      END AS bid_avg
    FROM pricing_observations po
    WHERE po.competition_name = 'InDrive'
      AND po.data_source = 'manual'
      AND po.country = p_country
  ),
  with_bids AS (SELECT * FROM bid_proxy WHERE bid_avg IS NOT NULL)
  SELECT
    wb.city,
    wb.category,
    COUNT(*)                                                              AS obs_with_bids,
    COUNT(*) FILTER (WHERE wb.recommended_price > outlier_threshold)      AS outlier_recs,
    ROUND(AVG(wb.recommended_price) FILTER (WHERE wb.recommended_price > 0
      AND wb.recommended_price <= outlier_threshold), 2)                  AS avg_rec,
    ROUND(MIN(wb.recommended_price) FILTER (WHERE wb.recommended_price > 0
      AND wb.recommended_price <= outlier_threshold), 2)                  AS min_rec,
    ROUND(MAX(wb.recommended_price) FILTER (WHERE wb.recommended_price > 0
      AND wb.recommended_price <= outlier_threshold), 2)                  AS max_rec,
    ROUND(AVG(wb.bid_avg), 2)                                             AS avg_bid
  FROM with_bids wb
  GROUP BY wb.city, wb.category
  ORDER BY wb.city, wb.category;
END;
$$;

GRANT EXECUTE ON FUNCTION get_indrive_summary(text, numeric) TO authenticated;

-- ════════════════════════════════════════════════════════════════════════
-- C. get_indrive_weekly  (sin bid_4/bid_5, con guard)
-- ════════════════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS get_indrive_weekly(text, numeric);
DROP FUNCTION IF EXISTS get_indrive_weekly(numeric, text);

CREATE OR REPLACE FUNCTION get_indrive_weekly(
  p_country         text,
  outlier_threshold numeric DEFAULT 100
)
RETURNS TABLE (
  city     text,
  category text,
  week     text,
  obs      bigint,
  avg_rec  numeric,
  avg_bid  numeric
)
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM require_country_access(p_country);
  RETURN QUERY
  WITH bid_proxy AS (
    SELECT
      po.city,
      po.category,
      po.observed_date,
      TO_CHAR(
        DATE_TRUNC('week', po.observed_date::date + INTERVAL '1 day') - INTERVAL '1 day',
        'IYYY"-W"IW'
      ) AS iso_week,
      po.recommended_price,
      CASE
        WHEN COALESCE(po.bid_1,0) > 0 OR COALESCE(po.bid_2,0) > 0 OR COALESCE(po.bid_3,0) > 0
        THEN (
          SELECT AVG(v) FROM UNNEST(ARRAY[
            NULLIF(po.bid_1,0), NULLIF(po.bid_2,0), NULLIF(po.bid_3,0)
          ]) t(v) WHERE v IS NOT NULL
        )
        WHEN po.price_without_discount > 0 THEN po.price_without_discount
        WHEN po.minimal_bid > 0            THEN po.minimal_bid
        ELSE NULL
      END AS bid_avg
    FROM pricing_observations po
    WHERE po.competition_name = 'InDrive'
      AND po.data_source = 'manual'
      AND po.country = p_country
  ),
  with_bids AS (SELECT * FROM bid_proxy WHERE bid_avg IS NOT NULL)
  SELECT
    wb.city,
    wb.category,
    wb.iso_week                                                          AS week,
    COUNT(*)                                                             AS obs,
    ROUND(AVG(wb.recommended_price) FILTER (WHERE wb.recommended_price > 0
      AND wb.recommended_price <= outlier_threshold), 2)                 AS avg_rec,
    ROUND(AVG(wb.bid_avg), 2)                                            AS avg_bid
  FROM with_bids wb
  GROUP BY wb.city, wb.category, wb.iso_week
  ORDER BY wb.city, wb.category, wb.iso_week DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION get_indrive_weekly(text, numeric) TO authenticated;

-- ════════════════════════════════════════════════════════════════════════
-- D. get_indrive_counts  (sin bid_4/bid_5, con guard)
-- ════════════════════════════════════════════════════════════════════════
DROP FUNCTION IF EXISTS get_indrive_counts(text);

CREATE OR REPLACE FUNCTION get_indrive_counts(
  p_country text
)
RETURNS TABLE (total_rows bigint, rows_with_bids bigint)
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM require_country_access(p_country);
  RETURN QUERY
  SELECT
    COUNT(*) AS total_rows,
    COUNT(*) FILTER (
      WHERE COALESCE(bid_1,0) > 0 OR COALESCE(bid_2,0) > 0 OR COALESCE(bid_3,0) > 0
         OR COALESCE(price_without_discount,0) > 0
         OR COALESCE(minimal_bid,0) > 0
    ) AS rows_with_bids
  FROM pricing_observations
  WHERE competition_name = 'InDrive'
    AND data_source = 'manual'
    AND country = p_country;
END;
$$;

GRANT EXECUTE ON FUNCTION get_indrive_counts(text) TO authenticated;

-- ════════════════════════════════════════════════════════════════════════
-- E. get_bot_vs_hubs_summary  (con guard)
-- ════════════════════════════════════════════════════════════════════════
DO $bot_vs_hubs$
DECLARE
  v_sig text;
BEGIN
  SELECT pg_get_function_identity_arguments(p.oid) INTO v_sig
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname='public' AND p.proname='get_bot_vs_hubs_summary'
  LIMIT 1;

  IF v_sig IS NULL THEN
    RAISE NOTICE '[mig 101] get_bot_vs_hubs_summary no existe — skip';
  ELSE
    RAISE NOTICE '[mig 101] get_bot_vs_hubs_summary firma actual: %', v_sig;
    -- Drop la firma para re-crearla con guard
    EXECUTE format('DROP FUNCTION IF EXISTS get_bot_vs_hubs_summary(%s)', v_sig);
  END IF;
END
$bot_vs_hubs$;

-- Re-creamos con la firma estándar esperada por el frontend
CREATE OR REPLACE FUNCTION get_bot_vs_hubs_summary(
  p_country text
) RETURNS TABLE (
  city                text,
  category            text,
  competition_name    text,
  bot_count           bigint,
  manual_count        bigint,
  bot_avg_price       numeric,
  manual_avg_price    numeric,
  price_delta_pct     numeric
)
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM require_country_access(p_country);
  RETURN QUERY
  WITH agg AS (
    SELECT
      po.city,
      po.category,
      po.competition_name,
      po.data_source,
      COUNT(*) AS cnt,
      AVG(COALESCE(po.price_without_discount, po.price_with_discount, po.recommended_price))::numeric(10,2) AS avg_price
    FROM pricing_observations po
    WHERE po.country = p_country
      AND po.data_source IN ('bot', 'manual')
    GROUP BY po.city, po.category, po.competition_name, po.data_source
  )
  SELECT
    a.city,
    a.category,
    a.competition_name,
    COALESCE(MAX(CASE WHEN a.data_source='bot' THEN a.cnt END), 0)        AS bot_count,
    COALESCE(MAX(CASE WHEN a.data_source='manual' THEN a.cnt END), 0)     AS manual_count,
    MAX(CASE WHEN a.data_source='bot' THEN a.avg_price END)               AS bot_avg_price,
    MAX(CASE WHEN a.data_source='manual' THEN a.avg_price END)            AS manual_avg_price,
    CASE
      WHEN MAX(CASE WHEN a.data_source='manual' THEN a.avg_price END) > 0 THEN
        ROUND(((MAX(CASE WHEN a.data_source='bot' THEN a.avg_price END)
              / MAX(CASE WHEN a.data_source='manual' THEN a.avg_price END)) - 1) * 100, 2)
      ELSE NULL
    END                                                                   AS price_delta_pct
  FROM agg a
  GROUP BY a.city, a.category, a.competition_name
  ORDER BY a.city, a.category, a.competition_name;
END;
$$;

GRANT EXECUTE ON FUNCTION get_bot_vs_hubs_summary(text) TO authenticated;

-- ════════════════════════════════════════════════════════════════════════
-- F. apply_indrive_bot_prices  (limpiar dual signature de mig 100 + mig 65)
-- ════════════════════════════════════════════════════════════════════════
-- Mig 100 dejó 2-arg (text, text) sin dropear la 3-arg de mig 65.
-- Unificamos en la 3-arg con guard (la que el frontend ya esperaba).
DROP FUNCTION IF EXISTS apply_indrive_bot_prices(text);
DROP FUNCTION IF EXISTS apply_indrive_bot_prices(text, text);
DROP FUNCTION IF EXISTS apply_indrive_bot_prices(text, text, text);

CREATE OR REPLACE FUNCTION apply_indrive_bot_prices(
  p_country  text,
  p_city     text DEFAULT NULL,
  p_category text DEFAULT NULL
) RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_updated int;
BEGIN
  PERFORM require_country_access(p_country);

  UPDATE pricing_observations po
  SET price_without_discount = po.minimal_bid * (1 + ic.adjustment_pct/100.0)
  FROM indrive_config ic
  WHERE po.country = p_country
    AND po.city    = ic.city
    AND po.category = ic.category
    AND po.competition_name = 'InDrive'
    AND po.data_source = 'bot'
    AND (p_city     IS NULL OR po.city     = p_city)
    AND (p_category IS NULL OR po.category = p_category)
    AND po.minimal_bid IS NOT NULL
    AND po.minimal_bid > 0;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;

GRANT EXECUTE ON FUNCTION apply_indrive_bot_prices(text, text, text) TO authenticated;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
--
-- 1. Las 6 funciones tienen guard:
--    Para cada una probar como hub_expert Peru:
--      SELECT * FROM get_indrive_summary('Colombia');
--      → ERROR: access_denied
--
-- 2. Como admin: todas funcionan sin errores.
--
-- 3. Confirmar que apply_indrive_bot_prices tiene UNA SOLA firma:
--    SELECT pg_get_function_identity_arguments(p.oid)
--    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname='public' AND p.proname='apply_indrive_bot_prices';
--    → 1 fila: "p_country text, p_city text DEFAULT NULL, p_category text DEFAULT NULL"
-- ════════════════════════════════════════════════════════════════════════
