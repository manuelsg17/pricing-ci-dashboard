-- ============================================================
-- MIGRACIÓN 28: RPCs y vistas con aislamiento por país
-- ============================================================
-- 1. Vistas: agregar columna `country` (pass-through desde pricing_observations)
-- 2. RPCs: agregar p_country text DEFAULT 'Peru' a todas las funciones
--          que leen/escriben pricing_observations.
-- ============================================================


-- ── 1. Vistas ───────────────────────────────────────────────

-- Nota: Postgres no permite cambiar nombres/orden de columnas en OR REPLACE.
-- Eliminamos cascada para recrearlas con la nueva estructura.
DROP VIEW IF EXISTS v_bracket_weekly_avg CASCADE;
DROP VIEW IF EXISTS v_bracket_daily_avg CASCADE;
DROP VIEW IF EXISTS v_effective_price CASCADE;

-- Vista base: precio efectivo por observación (agrega country)
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

-- Vista semanal: agrega country en SELECT y GROUP BY
CREATE OR REPLACE VIEW v_bracket_weekly_avg AS
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

-- Vista diaria: agrega country en SELECT y GROUP BY
CREATE OR REPLACE VIEW v_bracket_daily_avg AS
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


-- ── 2. RPCs de lectura del dashboard ────────────────────────

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

CREATE OR REPLACE FUNCTION get_available_zones(
  p_city     text,
  p_category text,
  p_country  text DEFAULT 'Peru'
) RETURNS TABLE (zone text)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT DISTINCT COALESCE(po.zone, 'All') AS zone
  FROM pricing_observations po
  WHERE po.country  = p_country
    AND po.city     = p_city
    AND po.category = p_category
  ORDER BY 1;
$$;


-- ── 3. RPCs de InDrive ───────────────────────────────────────

CREATE OR REPLACE FUNCTION get_indrive_summary(
  outlier_threshold numeric DEFAULT 100,
  p_country         text    DEFAULT 'Peru'
)
RETURNS TABLE (
  city            text,
  category        text,
  obs_with_bids   bigint,
  outlier_recs    bigint,
  avg_rec         numeric,
  min_rec         numeric,
  max_rec         numeric,
  avg_bid         numeric
)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  WITH bid_proxy AS (
    SELECT
      city,
      category,
      recommended_price,
      CASE
        WHEN COALESCE(bid_1,0) > 0 OR COALESCE(bid_2,0) > 0 OR COALESCE(bid_3,0) > 0
          OR COALESCE(bid_4,0) > 0 OR COALESCE(bid_5,0) > 0
        THEN (
          SELECT AVG(v) FROM UNNEST(ARRAY[
            NULLIF(bid_1,0), NULLIF(bid_2,0), NULLIF(bid_3,0),
            NULLIF(bid_4,0), NULLIF(bid_5,0)
          ]) t(v) WHERE v IS NOT NULL
        )
        WHEN price_without_discount > 0 THEN price_without_discount
        WHEN minimal_bid > 0 THEN minimal_bid
        ELSE NULL
      END AS bid_avg
    FROM pricing_observations
    WHERE competition_name = 'InDrive'
      AND data_source = 'manual'
      AND country = p_country
  ),
  with_bids AS (
    SELECT * FROM bid_proxy WHERE bid_avg IS NOT NULL
  )
  SELECT
    city,
    category,
    COUNT(*)                                                              AS obs_with_bids,
    COUNT(*) FILTER (WHERE recommended_price > outlier_threshold)        AS outlier_recs,
    ROUND(AVG(recommended_price) FILTER (WHERE recommended_price > 0
      AND recommended_price <= outlier_threshold), 2)                    AS avg_rec,
    ROUND(MIN(recommended_price) FILTER (WHERE recommended_price > 0
      AND recommended_price <= outlier_threshold), 2)                    AS min_rec,
    ROUND(MAX(recommended_price) FILTER (WHERE recommended_price > 0
      AND recommended_price <= outlier_threshold), 2)                    AS max_rec,
    ROUND(AVG(bid_avg), 2)                                               AS avg_bid
  FROM with_bids
  GROUP BY city, category
  ORDER BY city, category
$$;

CREATE OR REPLACE FUNCTION get_indrive_weekly(
  outlier_threshold numeric DEFAULT 100,
  p_country         text    DEFAULT 'Peru'
)
RETURNS TABLE (
  city      text,
  category  text,
  week      text,
  obs       bigint,
  avg_rec   numeric,
  avg_bid   numeric
)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  WITH bid_proxy AS (
    SELECT
      city,
      category,
      observed_date,
      TO_CHAR(
        DATE_TRUNC('week', observed_date::date + INTERVAL '1 day') - INTERVAL '1 day',
        'IYYY"-W"IW'
      ) AS iso_week,
      recommended_price,
      CASE
        WHEN COALESCE(bid_1,0) > 0 OR COALESCE(bid_2,0) > 0 OR COALESCE(bid_3,0) > 0
          OR COALESCE(bid_4,0) > 0 OR COALESCE(bid_5,0) > 0
        THEN (
          SELECT AVG(v) FROM UNNEST(ARRAY[
            NULLIF(bid_1,0), NULLIF(bid_2,0), NULLIF(bid_3,0),
            NULLIF(bid_4,0), NULLIF(bid_5,0)
          ]) t(v) WHERE v IS NOT NULL
        )
        WHEN price_without_discount > 0 THEN price_without_discount
        WHEN minimal_bid > 0 THEN minimal_bid
        ELSE NULL
      END AS bid_avg
    FROM pricing_observations
    WHERE competition_name = 'InDrive'
      AND data_source = 'manual'
      AND country = p_country
  ),
  with_bids AS (
    SELECT * FROM bid_proxy WHERE bid_avg IS NOT NULL
  )
  SELECT
    city,
    category,
    iso_week                                                             AS week,
    COUNT(*)                                                             AS obs,
    ROUND(AVG(recommended_price) FILTER (WHERE recommended_price > 0
      AND recommended_price <= outlier_threshold), 2)                   AS avg_rec,
    ROUND(AVG(bid_avg), 2)                                              AS avg_bid
  FROM with_bids
  GROUP BY city, category, iso_week
  ORDER BY city, category, iso_week DESC
$$;

CREATE OR REPLACE FUNCTION get_indrive_counts(
  p_country text DEFAULT 'Peru'
)
RETURNS TABLE (total_rows bigint, rows_with_bids bigint)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT
    COUNT(*) AS total_rows,
    COUNT(*) FILTER (
      WHERE COALESCE(bid_1,0) > 0 OR COALESCE(bid_2,0) > 0 OR COALESCE(bid_3,0) > 0
         OR COALESCE(bid_4,0) > 0 OR COALESCE(bid_5,0) > 0
         OR COALESCE(price_without_discount,0) > 0
         OR COALESCE(minimal_bid,0) > 0
    ) AS rows_with_bids
  FROM pricing_observations
  WHERE competition_name = 'InDrive'
    AND data_source = 'manual'
    AND country = p_country
$$;


-- ── 4. apply_indrive_bot_prices ──────────────────────────────

CREATE OR REPLACE FUNCTION apply_indrive_bot_prices(
  p_city     text    DEFAULT NULL,
  p_category text    DEFAULT NULL,
  p_country  text    DEFAULT 'Peru'
)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  updated_count integer;
BEGIN
  UPDATE pricing_observations po
  SET price_without_discount = ROUND(
    po.recommended_price * (1 + ic.adjustment_pct / 100.0),
    2
  )
  FROM indrive_config ic
  WHERE po.competition_name  = 'InDrive'
    AND po.data_source        = 'bot'
    AND po.recommended_price IS NOT NULL
    AND po.recommended_price  > 0
    AND po.country            = p_country
    AND po.city               = ic.city
    AND po.category           = ic.category
    AND ic.country            = p_country
    AND (p_city     IS NULL OR po.city     = p_city)
    AND (p_category IS NULL OR po.category = p_category);

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$;

GRANT EXECUTE ON FUNCTION apply_indrive_bot_prices(text, text, text) TO authenticated;

-- Trigger: al guardar ajuste en indrive_config, recalcular solo ese país/ciudad/categoría
CREATE OR REPLACE FUNCTION trg_apply_indrive_prices_on_config()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  UPDATE pricing_observations
  SET price_without_discount = ROUND(
    recommended_price * (1 + NEW.adjustment_pct / 100.0),
    2
  )
  WHERE competition_name  = 'InDrive'
    AND data_source        = 'bot'
    AND recommended_price IS NOT NULL
    AND recommended_price  > 0
    AND country            = NEW.country
    AND city               = NEW.city
    AND category           = NEW.category;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_indrive_config_change ON indrive_config;
CREATE TRIGGER trg_indrive_config_change
  AFTER INSERT OR UPDATE ON indrive_config
  FOR EACH ROW
  EXECUTE FUNCTION trg_apply_indrive_prices_on_config();


-- ── 5. upsert_pricing_batch ──────────────────────────────────

CREATE OR REPLACE FUNCTION upsert_pricing_batch(
  p_rows        jsonb,
  p_city_ranges jsonb,   -- [{city, min_date, max_date}]
  p_batch_id    uuid,
  p_filename    text,
  p_row_count   int,
  p_country     text DEFAULT 'Peru'
) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_range jsonb;
BEGIN
  -- Paso 1: Borrar filas existentes del mismo país+ciudad+rango de fechas
  FOR v_range IN SELECT * FROM jsonb_array_elements(p_city_ranges) LOOP
    DELETE FROM pricing_observations
    WHERE country      = p_country
      AND city         = v_range->>'city'
      AND data_source  = 'manual'
      AND observed_date BETWEEN (v_range->>'min_date')::date
                             AND (v_range->>'max_date')::date;
  END LOOP;

  -- Paso 2: Insertar todas las filas nuevas
  INSERT INTO pricing_observations
  SELECT * FROM jsonb_populate_recordset(null::pricing_observations, p_rows);

  -- Paso 3: Registrar el batch de upload
  INSERT INTO upload_batches (id, filename, row_count, city, country)
  VALUES (p_batch_id, p_filename, p_row_count, 'multi', p_country)
  ON CONFLICT (id) DO NOTHING;

  RETURN p_row_count;
END;
$$;

GRANT EXECUTE ON FUNCTION upsert_pricing_batch(jsonb, jsonb, uuid, text, int, text) TO authenticated;

-- ── Permisos actualizados ────────────────────────────────────
GRANT EXECUTE ON FUNCTION get_dashboard_data_weekly(text, text, text, text, boolean, int, int, int, int) TO authenticated;
GRANT EXECUTE ON FUNCTION get_dashboard_data_daily(text, text, text, text, boolean, date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION get_available_zones(text, text, text)    TO authenticated;
GRANT EXECUTE ON FUNCTION get_indrive_summary(numeric, text)       TO authenticated;
GRANT EXECUTE ON FUNCTION get_indrive_weekly(numeric, text)        TO authenticated;
GRANT EXECUTE ON FUNCTION get_indrive_counts(text)                 TO authenticated;
