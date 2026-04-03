-- ============================================================
-- VIEWS
-- ============================================================

-- --------------------------------------------------------
-- Vista 1: precio efectivo por observación
-- Aplica lógica InDrive: promedio de bids no-cero,
-- si no hay bids usa price_without_discount → recommended_price
-- --------------------------------------------------------
CREATE OR REPLACE VIEW v_effective_price AS
SELECT
  id,
  city,
  year,
  week,
  observed_date,
  category,
  zone,
  competition_name,
  distance_km,
  distance_bracket,
  surge,
  timeslot,
  rush_hour,
  CASE
    WHEN competition_name = 'InDrive'
         AND (COALESCE(bid_1,0) + COALESCE(bid_2,0) + COALESCE(bid_3,0)
              + COALESCE(bid_4,0) + COALESCE(bid_5,0)) > 0
    THEN (
      COALESCE(NULLIF(bid_1, 0), 0) +
      COALESCE(NULLIF(bid_2, 0), 0) +
      COALESCE(NULLIF(bid_3, 0), 0) +
      COALESCE(NULLIF(bid_4, 0), 0) +
      COALESCE(NULLIF(bid_5, 0), 0)
    )::numeric / NULLIF(
      (CASE WHEN COALESCE(bid_1,0) > 0 THEN 1 ELSE 0 END +
       CASE WHEN COALESCE(bid_2,0) > 0 THEN 1 ELSE 0 END +
       CASE WHEN COALESCE(bid_3,0) > 0 THEN 1 ELSE 0 END +
       CASE WHEN COALESCE(bid_4,0) > 0 THEN 1 ELSE 0 END +
       CASE WHEN COALESCE(bid_5,0) > 0 THEN 1 ELSE 0 END), 0)
    ELSE COALESCE(price_without_discount, recommended_price)
  END AS effective_price,
  upload_batch_id
FROM pricing_observations;

-- --------------------------------------------------------
-- Vista 2: promedio semanal por (ciudad, semana, categoría,
-- zona, competidor, bracket)
-- Es el target principal del dashboard en modo semanal
-- --------------------------------------------------------
CREATE OR REPLACE VIEW v_bracket_weekly_avg AS
SELECT
  city,
  year,
  week,
  category,
  COALESCE(zone, 'All') AS zone,
  competition_name,
  distance_bracket,
  surge,
  COUNT(*)                AS observation_count,
  AVG(effective_price)    AS avg_price,
  MIN(observed_date)      AS week_start_date
FROM v_effective_price
WHERE effective_price IS NOT NULL
  AND effective_price > 0
GROUP BY city, year, week, category, zone, competition_name, distance_bracket, surge;

-- --------------------------------------------------------
-- Vista 3: promedio diario por (ciudad, fecha, categoría,
-- zona, competidor, bracket)
-- Para el modo "Daily" del dashboard
-- --------------------------------------------------------
CREATE OR REPLACE VIEW v_bracket_daily_avg AS
SELECT
  city,
  observed_date,
  EXTRACT(isodow FROM observed_date)::int AS day_of_week,
  category,
  COALESCE(zone, 'All') AS zone,
  competition_name,
  distance_bracket,
  surge,
  COUNT(*)                AS observation_count,
  AVG(effective_price)    AS avg_price
FROM v_effective_price
WHERE effective_price IS NOT NULL
  AND effective_price > 0
GROUP BY city, observed_date, category, zone, competition_name, distance_bracket, surge;
