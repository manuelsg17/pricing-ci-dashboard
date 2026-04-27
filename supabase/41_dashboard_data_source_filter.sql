-- ============================================================
-- MIGRACIÓN 41: Filtro Fuente (bot / hubs / ambos) en el Dashboard
-- ============================================================
--
-- QUÉ AGREGA:
--   Las vistas v_bracket_weekly_avg y v_bracket_daily_avg ahora
--   incluyen `data_source` en el GROUP BY. Los RPCs aceptan un nuevo
--   parámetro p_data_source ('bot' | 'manual' | NULL):
--     - NULL  → combina ambas fuentes con promedio ponderado por
--               observation_count (comportamiento histórico).
--     - 'bot' → solo data del bot.
--     - 'manual' → solo data de hubs (entrada manual + Excel).
--
--   Los RPCs re-agregan después del filtro para que la matriz del
--   dashboard se mantenga al mismo nivel de granularidad
--   (competition_name, distance_bracket, period, surge).
-- ============================================================

BEGIN;

DROP VIEW IF EXISTS v_bracket_weekly_avg CASCADE;
DROP VIEW IF EXISTS v_bracket_daily_avg  CASCADE;

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
  COUNT(*)                AS observation_count,
  AVG(effective_price)    AS avg_price,
  MIN(observed_date)      AS week_start_date
FROM v_effective_price
WHERE effective_price IS NOT NULL
  AND effective_price > 0
GROUP BY country, city, year, week, category, zone,
         competition_name, distance_bracket, surge, data_source;


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
  COUNT(*)                AS observation_count,
  AVG(effective_price)    AS avg_price
FROM v_effective_price
WHERE effective_price IS NOT NULL
  AND effective_price > 0
GROUP BY country, city, observed_date, category, zone,
         competition_name, distance_bracket, surge, data_source;


-- ── RPCs con filtro p_data_source ─────────────────────────────

CREATE OR REPLACE FUNCTION get_dashboard_data_weekly(
  p_city        text,
  p_category    text,
  p_country     text    DEFAULT 'Peru',
  p_zone        text    DEFAULT NULL,
  p_surge       boolean DEFAULT NULL,
  p_week_start  int     DEFAULT NULL,
  p_year_start  int     DEFAULT NULL,
  p_week_end    int     DEFAULT NULL,
  p_year_end    int     DEFAULT NULL,
  p_data_source text    DEFAULT NULL
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
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT
    competition_name,
    distance_bracket,
    week,
    year,
    MIN(week_start_date)                                                          AS week_start_date,
    ROUND((SUM(avg_price * observation_count) / NULLIF(SUM(observation_count), 0))::numeric, 2) AS avg_price,
    SUM(observation_count)                                                        AS observation_count,
    surge
  FROM v_bracket_weekly_avg
  WHERE country  = p_country
    AND city     = p_city
    AND category = p_category
    AND (p_zone        IS NULL OR zone = p_zone OR p_zone = 'All')
    AND (p_surge       IS NULL OR surge = p_surge)
    AND (p_data_source IS NULL OR data_source = p_data_source)
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


CREATE OR REPLACE FUNCTION get_dashboard_data_daily(
  p_city        text,
  p_category    text,
  p_country     text    DEFAULT 'Peru',
  p_zone        text    DEFAULT NULL,
  p_surge       boolean DEFAULT NULL,
  p_date_start  date    DEFAULT NULL,
  p_date_end    date    DEFAULT NULL,
  p_data_source text    DEFAULT NULL
) RETURNS TABLE (
  competition_name  text,
  distance_bracket  text,
  observed_date     date,
  avg_price         numeric,
  observation_count bigint,
  surge             boolean
)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
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
    AND (p_date_start  IS NULL OR observed_date >= p_date_start)
    AND (p_date_end    IS NULL OR observed_date <= p_date_end)
  GROUP BY competition_name, distance_bracket, observed_date, surge
  ORDER BY competition_name, distance_bracket, observed_date;
$$;

GRANT EXECUTE ON FUNCTION get_dashboard_data_weekly(text, text, text, text, boolean, int, int, int, int, text) TO authenticated;
GRANT EXECUTE ON FUNCTION get_dashboard_data_daily(text, text, text, text, boolean, date, date, text)            TO authenticated;

COMMIT;
