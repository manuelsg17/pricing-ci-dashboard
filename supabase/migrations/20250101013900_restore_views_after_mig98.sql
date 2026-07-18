-- ════════════════════════════════════════════════════════════════════════
-- Migración 99 — URGENTE: restaurar vistas y RPCs tras CASCADE de mig 98
--
-- CONTEXTO:
--   Mig 98 dropeó bid_4 y bid_5 con CASCADE. v_effective_price los
--   referenciaba en su CASE WHEN para promediar bids InDrive → cascada
--   wipeó la vista. Eso a su vez cascadeó a:
--     · v_bracket_weekly_avg (depends on v_effective_price)
--     · v_bracket_daily_avg  (depends on v_effective_price)
--     · get_dashboard_data_weekly (SQL function querying v_bracket_weekly_avg)
--     · get_dashboard_data_daily  (SQL function querying v_bracket_daily_avg)
--     · freeze_pricing_wa, indrive RPCs, etc. (mismo patrón)
--
--   Síntoma: Dashboard tira 404 en POST /rpc/get_dashboard_data_weekly.
--
-- QUÉ HACE:
--   1. Re-crear v_effective_price SIN bid_4/bid_5 (columnas ya no existen).
--      InDrive ahora promedia solo bid_1, bid_2, bid_3 — suficiente para
--      el algoritmo (las observaciones tenían >99% NULL en bid_4/5).
--   2. Re-crear v_bracket_weekly_avg y v_bracket_daily_avg (versión de mig 42
--      con country + data_source + time_of_day).
--   3. Re-crear get_dashboard_data_weekly y get_dashboard_data_daily
--      (versión de mig 65: p_country requerido).
--
-- LO QUE NO HACE:
--   Las RPCs auxiliares (get_indrive_summary, freeze_pricing_wa,
--   get_bot_vs_hubs_summary, etc.) también pueden haber sido cascadeadas.
--   Si fallan después de mig 99, re-aplicar mig 65 y mig 56 las restaura.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── (A) v_effective_price SIN bid_4/bid_5 ──────────────────────────────
DROP VIEW IF EXISTS v_effective_price CASCADE;

CREATE VIEW v_effective_price AS
SELECT
  id,
  country,
  city,
  year,
  week,
  observed_date,
  observed_time,
  time_of_day,
  category,
  zone,
  competition_name,
  distance_km,
  distance_bracket,
  surge,
  rush_hour,
  timeslot,
  data_source,
  upload_batch_id,
  CASE
    WHEN competition_name = 'InDrive'
         AND (COALESCE(bid_1,0) + COALESCE(bid_2,0) + COALESCE(bid_3,0)) > 0
    THEN (
      COALESCE(NULLIF(bid_1, 0), 0) +
      COALESCE(NULLIF(bid_2, 0), 0) +
      COALESCE(NULLIF(bid_3, 0), 0)
    )::numeric / NULLIF(
      (CASE WHEN COALESCE(bid_1,0) > 0 THEN 1 ELSE 0 END +
       CASE WHEN COALESCE(bid_2,0) > 0 THEN 1 ELSE 0 END +
       CASE WHEN COALESCE(bid_3,0) > 0 THEN 1 ELSE 0 END), 0)
    ELSE COALESCE(price_without_discount, recommended_price)
  END AS effective_price
FROM pricing_observations;

-- ── (B) v_bracket_weekly_avg (versión mig 42) ──────────────────────────
CREATE VIEW v_bracket_weekly_avg AS
SELECT
  country,
  city,
  year,
  week,
  category,
  COALESCE(zone, 'All') AS zone,
  competition_name,
  distance_bracket,
  surge,
  data_source,
  time_of_day,
  COUNT(*)             AS observation_count,
  AVG(effective_price) AS avg_price,
  MIN(observed_date)   AS week_start_date
FROM v_effective_price
WHERE effective_price IS NOT NULL
  AND effective_price > 0
GROUP BY
  country, city, year, week, category, zone,
  competition_name, distance_bracket, surge, data_source, time_of_day;

-- ── (C) v_bracket_daily_avg (versión mig 42) ───────────────────────────
CREATE VIEW v_bracket_daily_avg AS
SELECT
  country,
  city,
  observed_date,
  EXTRACT(isodow FROM observed_date)::int AS day_of_week,
  category,
  COALESCE(zone, 'All') AS zone,
  competition_name,
  distance_bracket,
  surge,
  data_source,
  time_of_day,
  COUNT(*)             AS observation_count,
  AVG(effective_price) AS avg_price
FROM v_effective_price
WHERE effective_price IS NOT NULL
  AND effective_price > 0
GROUP BY
  country, city, observed_date, category, zone,
  competition_name, distance_bracket, surge, data_source, time_of_day;

-- ── (D) get_dashboard_data_weekly (versión mig 65) ─────────────────────
DROP FUNCTION IF EXISTS get_dashboard_data_weekly(text, text, text, text, boolean, int, int, int, int, text, text[]);
DROP FUNCTION IF EXISTS get_dashboard_data_weekly(text, text, text, text, boolean, int, int, int, int, text);
DROP FUNCTION IF EXISTS get_dashboard_data_weekly(text, text, text, text, boolean, int, int, int, int);

CREATE OR REPLACE FUNCTION get_dashboard_data_weekly(
  p_city        text,
  p_category    text,
  p_country     text,
  p_zone        text    DEFAULT NULL,
  p_surge       boolean DEFAULT NULL,
  p_week_start  int     DEFAULT NULL,
  p_year_start  int     DEFAULT NULL,
  p_week_end    int     DEFAULT NULL,
  p_year_end    int     DEFAULT NULL,
  p_data_source text    DEFAULT NULL,
  p_time_of_day text[]  DEFAULT NULL
) RETURNS TABLE (
  competition_name  text,
  distance_bracket  text,
  week              int,
  year              int,
  week_start_date   date,
  avg_price         numeric,
  observation_count bigint,
  surge             boolean
)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    competition_name,
    distance_bracket,
    week,
    year,
    MIN(week_start_date)                                                                        AS week_start_date,
    ROUND((SUM(avg_price * observation_count) / NULLIF(SUM(observation_count), 0))::numeric, 2) AS avg_price,
    SUM(observation_count)                                                                       AS observation_count,
    surge
  FROM v_bracket_weekly_avg
  WHERE country  = p_country
    AND city     = p_city
    AND category = p_category
    AND (p_zone        IS NULL OR zone = p_zone OR p_zone = 'All')
    AND (p_surge       IS NULL OR surge = p_surge)
    AND (p_data_source IS NULL OR data_source = p_data_source)
    AND (p_time_of_day IS NULL OR time_of_day = ANY(p_time_of_day))
    AND (
      p_year_start IS NULL OR
      (year > p_year_start) OR
      (year = p_year_start AND week >= p_week_start)
    )
    AND (
      p_year_end IS NULL OR
      (year < p_year_end) OR
      (year = p_year_end AND week <= p_week_end)
    )
  GROUP BY competition_name, distance_bracket, week, year, surge
  ORDER BY competition_name, distance_bracket, year, week;
$$;

GRANT EXECUTE ON FUNCTION get_dashboard_data_weekly(text, text, text, text, boolean, int, int, int, int, text, text[]) TO authenticated;

-- ── (E) get_dashboard_data_daily (versión mig 65) ──────────────────────
DROP FUNCTION IF EXISTS get_dashboard_data_daily(text, text, text, text, boolean, date, date, text, text[]);
DROP FUNCTION IF EXISTS get_dashboard_data_daily(text, text, text, text, boolean, date, date, text);
DROP FUNCTION IF EXISTS get_dashboard_data_daily(text, text, text, text, boolean, date, date);

CREATE OR REPLACE FUNCTION get_dashboard_data_daily(
  p_city        text,
  p_category    text,
  p_country     text,
  p_zone        text    DEFAULT NULL,
  p_surge       boolean DEFAULT NULL,
  p_date_start  date    DEFAULT NULL,
  p_date_end    date    DEFAULT NULL,
  p_data_source text    DEFAULT NULL,
  p_time_of_day text[]  DEFAULT NULL
) RETURNS TABLE (
  competition_name  text,
  distance_bracket  text,
  observed_date     date,
  avg_price         numeric,
  observation_count bigint,
  surge             boolean
)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    competition_name,
    distance_bracket,
    observed_date,
    ROUND((SUM(avg_price * observation_count) / NULLIF(SUM(observation_count), 0))::numeric, 2) AS avg_price,
    SUM(observation_count)                                                                       AS observation_count,
    surge
  FROM v_bracket_daily_avg
  WHERE country  = p_country
    AND city     = p_city
    AND category = p_category
    AND (p_zone        IS NULL OR zone = p_zone OR p_zone = 'All')
    AND (p_surge       IS NULL OR surge = p_surge)
    AND (p_data_source IS NULL OR data_source = p_data_source)
    AND (p_time_of_day IS NULL OR time_of_day = ANY(p_time_of_day))
    AND (p_date_start  IS NULL OR observed_date >= p_date_start)
    AND (p_date_end    IS NULL OR observed_date <= p_date_end)
  GROUP BY competition_name, distance_bracket, observed_date, surge
  ORDER BY competition_name, distance_bracket, observed_date;
$$;

GRANT EXECUTE ON FUNCTION get_dashboard_data_daily(text, text, text, text, boolean, date, date, text, text[]) TO authenticated;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
--
-- 1. Vistas existen:
--    SELECT table_name FROM information_schema.views
--    WHERE table_schema='public' AND table_name LIKE 'v_%';
--    → debe incluir v_effective_price, v_bracket_weekly_avg, v_bracket_daily_avg
--
-- 2. Funciones existen:
--    SELECT proname FROM pg_proc WHERE proname IN ('get_dashboard_data_weekly','get_dashboard_data_daily');
--    → 2 filas
--
-- 3. Test directo:
--    SELECT * FROM get_dashboard_data_weekly('Lima','Economy/Comfort','Peru');
--    → debe devolver filas
--
-- ════════════════════════════════════════════════════════════════════════
-- SI OTRAS RPCs FALLAN (cascade más profundo):
--
-- Re-aplicar mig 65 (RPCs require country) que define todas las demás:
--   - get_available_zones
--   - get_indrive_summary, get_indrive_weekly, get_indrive_counts
--   - apply_indrive_bot_prices
--   - upsert_pricing_batch
--   - get_bot_vs_hubs_summary
--
-- Y mig 56 si freeze_pricing_wa también está rota.
-- ════════════════════════════════════════════════════════════════════════
