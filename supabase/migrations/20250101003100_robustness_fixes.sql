-- ============================================================
-- MIGRACIÓN 31: Endurecimiento del pipeline de datos
-- ============================================================
-- Objetivos para hacer el dashboard 100% funcional y escalable
-- a Colombia, Nepal, Bolivia:
--
-- 1. Trigger: usar ISO year para que el `year` guardado coincida con
--    el que el cliente calcula vía Thursday-based ISO week. Evita
--    desincronización en las fechas de frontera diciembre/enero.
--
-- 2. v_effective_price: agregar price_with_discount como último fallback
--    para que observaciones que solo tienen precio post-descuento
--    aparezcan en el chart (en vez de quedar excluidas por NULL).
--
-- 3. Backfill: recalcular `year` en filas existentes que estén en la
--    frontera (semanas 52/53 de diciembre y semanas 1 de enero).
-- ============================================================

BEGIN;

-- ── 1. Trigger: year = ISO year ─────────────────────────────

CREATE OR REPLACE FUNCTION trg_assign_computed_fields()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Asignar bracket a partir de distance_km y distance_thresholds
  NEW.distance_bracket := get_distance_bracket(NEW.city, NEW.category, NEW.distance_km);

  -- year e ISO week: usar ISO year para consistencia con el cliente,
  -- que computa la semana basada en el jueves de esa semana.
  IF NEW.year IS NULL THEN
    NEW.year := EXTRACT(isoyear FROM NEW.observed_date);
  END IF;
  IF NEW.week IS NULL THEN
    NEW.week := EXTRACT(week FROM NEW.observed_date)::int;
  END IF;

  -- rush_hour por defecto si no viene
  IF NEW.rush_hour IS NULL AND NEW.observed_time IS NOT NULL THEN
    NEW.rush_hour := (
      (NEW.observed_time >= '07:00' AND NEW.observed_time <= '09:00') OR
      (NEW.observed_time >= '17:00' AND NEW.observed_time <= '20:00')
    );
  END IF;

  RETURN NEW;
END;
$$;


-- ── 2. v_effective_price: fallback extendido ────────────────

DROP VIEW IF EXISTS v_bracket_weekly_avg CASCADE;
DROP VIEW IF EXISTS v_bracket_daily_avg CASCADE;
DROP VIEW IF EXISTS v_effective_price CASCADE;

CREATE VIEW v_effective_price AS
SELECT
  id,
  country,
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
  data_source,
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
    -- Para el resto: prefiere precio sin descuento; luego recommended;
    -- último fallback price_with_discount para recuperar observaciones que
    -- solo capturaron el precio post-descuento.
    ELSE COALESCE(
      NULLIF(price_without_discount, 0),
      NULLIF(recommended_price,      0),
      NULLIF(price_with_discount,    0)
    )
  END AS effective_price,
  upload_batch_id
FROM pricing_observations;


-- Vista semanal (agrega data_source en SELECT pero NO en GROUP BY
-- para que la agregación combine manual+bot; si se quiere separar,
-- se puede filtrar en el RPC via p_data_source)
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
  COUNT(*)                AS observation_count,
  AVG(effective_price)    AS avg_price,
  MIN(observed_date)      AS week_start_date
FROM v_effective_price
WHERE effective_price IS NOT NULL
  AND effective_price > 0
GROUP BY country, city, year, week, category, zone, competition_name, distance_bracket, surge;


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
  COUNT(*)                AS observation_count,
  AVG(effective_price)    AS avg_price
FROM v_effective_price
WHERE effective_price IS NOT NULL
  AND effective_price > 0
GROUP BY country, city, observed_date, category, zone, competition_name, distance_bracket, surge;


-- ── 3. Re-crear los RPCs del dashboard (dependían de las vistas) ──

CREATE OR REPLACE FUNCTION get_dashboard_data_weekly(
  p_city        text,
  p_category    text,
  p_country     text    DEFAULT 'Peru',
  p_zone        text    DEFAULT NULL,
  p_surge       boolean DEFAULT NULL,
  p_week_start  int     DEFAULT NULL,
  p_year_start  int     DEFAULT NULL,
  p_week_end    int     DEFAULT NULL,
  p_year_end    int     DEFAULT NULL
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
    week_start_date,
    ROUND(avg_price::numeric, 2) AS avg_price,
    observation_count,
    surge
  FROM v_bracket_weekly_avg
  WHERE country  = p_country
    AND city     = p_city
    AND category = p_category
    AND (p_zone  IS NULL OR zone = p_zone OR p_zone = 'All')
    AND (p_surge IS NULL OR surge = p_surge)
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
  ORDER BY competition_name, distance_bracket, year, week;
$$;

CREATE OR REPLACE FUNCTION get_dashboard_data_daily(
  p_city        text,
  p_category    text,
  p_country     text    DEFAULT 'Peru',
  p_zone        text    DEFAULT NULL,
  p_surge       boolean DEFAULT NULL,
  p_date_start  date    DEFAULT NULL,
  p_date_end    date    DEFAULT NULL
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
    ROUND(avg_price::numeric, 2) AS avg_price,
    observation_count,
    surge
  FROM v_bracket_daily_avg
  WHERE country  = p_country
    AND city     = p_city
    AND category = p_category
    AND (p_zone  IS NULL OR zone = p_zone OR p_zone = 'All')
    AND (p_surge IS NULL OR surge = p_surge)
    AND (p_date_start IS NULL OR observed_date >= p_date_start)
    AND (p_date_end   IS NULL OR observed_date <= p_date_end)
  ORDER BY competition_name, distance_bracket, observed_date;
$$;

GRANT EXECUTE ON FUNCTION get_dashboard_data_weekly(text, text, text, text, boolean, int, int, int, int) TO authenticated;
GRANT EXECUTE ON FUNCTION get_dashboard_data_daily(text, text, text, text, boolean, date, date) TO authenticated;


-- ── 4. Backfill: alinear `year` con ISO year ────────────────
-- Solo afecta filas en la frontera (dic/ene) donde ISO year difiere
-- del calendar year. Para Perú en producción actualmente eso son las
-- filas de la última semana de 2025 que deberían tener year=2026.

UPDATE pricing_observations
SET year = EXTRACT(isoyear FROM observed_date)::int
WHERE year IS DISTINCT FROM EXTRACT(isoyear FROM observed_date)::int;

COMMIT;


-- ── Verificaciones (ejecutar por separado) ──────────────────
--
-- ¿Cuántas filas se corrigieron en el backfill?
--   SELECT year, week, COUNT(*) FROM pricing_observations
--   WHERE country='Peru' AND observed_date BETWEEN '2025-12-29' AND '2026-01-04'
--   GROUP BY 1,2 ORDER BY 1,2;
--
-- ¿Cuántas filas nuevas aparecen ahora en el chart gracias al fallback
-- price_with_discount?
--   SELECT data_source,
--          COUNT(*) FILTER (WHERE effective_price IS NOT NULL) AS con_precio,
--          COUNT(*) FILTER (WHERE price_without_discount IS NULL
--                             AND recommended_price      IS NULL
--                             AND price_with_discount    IS NOT NULL) AS recuperadas
--   FROM v_effective_price
--   WHERE country='Peru'
--   GROUP BY data_source;
