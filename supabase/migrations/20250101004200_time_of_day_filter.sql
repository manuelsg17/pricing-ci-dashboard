-- ============================================================
-- MIGRACIÓN 42: Filtro de franja horaria (time_of_day)
-- ============================================================
--
-- QUÉ AGREGA:
--   • Columna `time_of_day` en pricing_observations con 5 franjas:
--       'early_morning'  → 00:00–05:59  (Madrugada)
--       'morning'        → 06:00–11:59  (Mañana)
--       'midday'         → 12:00–13:59  (Mediodía)
--       'afternoon'      → 14:00–17:59  (Tarde)
--       'evening'        → 18:00–23:59  (Noche)
--   • El trigger la asigna automáticamente al insertar si observed_time está disponible.
--   • Backfill de todos los registros existentes.
--   • Las vistas v_bracket_weekly_avg y v_bracket_daily_avg incluyen time_of_day
--     en el GROUP BY para permitir filtraje granular.
--   • get_dashboard_data_weekly y get_dashboard_data_daily aceptan
--     p_time_of_day text[] (NULL = todas las franjas).
-- ============================================================

BEGIN;

-- ── 1. Nueva columna ──────────────────────────────────────────

ALTER TABLE pricing_observations
  ADD COLUMN IF NOT EXISTS time_of_day text;

-- ── 2. Función helper (immutable, reutilizable en trigger) ─────

CREATE OR REPLACE FUNCTION get_time_of_day(t time)
RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN t >= '18:00' THEN 'evening'
    WHEN t >= '14:00' THEN 'afternoon'
    WHEN t >= '12:00' THEN 'midday'
    WHEN t >= '06:00' THEN 'morning'
    ELSE                    'early_morning'
  END;
$$;

-- ── 3. Actualizar trigger para asignar time_of_day ─────────────

CREATE OR REPLACE FUNCTION trg_assign_computed_fields()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Bracket (solo si no viene ya asignado)
  IF NEW.distance_bracket IS NULL AND NEW.distance_km IS NOT NULL THEN
    NEW.distance_bracket := get_distance_bracket(NEW.city, NEW.category, NEW.distance_km);
  END IF;

  -- Año e ISO week
  IF NEW.year IS NULL THEN
    NEW.year := EXTRACT(year FROM NEW.observed_date);
  END IF;
  IF NEW.week IS NULL THEN
    NEW.week := EXTRACT(week FROM NEW.observed_date)::int;
  END IF;

  -- Rush hour (no sobreescribir si ya viene del bot)
  IF NEW.rush_hour IS NULL AND NEW.observed_time IS NOT NULL THEN
    NEW.rush_hour := (
      (NEW.observed_time >= '07:00' AND NEW.observed_time <= '09:00') OR
      (NEW.observed_time >= '17:00' AND NEW.observed_time <= '20:00')
    );
  END IF;

  -- Time of day (5 franjas horarias)
  IF NEW.time_of_day IS NULL AND NEW.observed_time IS NOT NULL THEN
    NEW.time_of_day := get_time_of_day(NEW.observed_time::time);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS before_insert_pricing ON pricing_observations;
CREATE TRIGGER before_insert_pricing
  BEFORE INSERT OR UPDATE ON pricing_observations
  FOR EACH ROW EXECUTE FUNCTION trg_assign_computed_fields();

-- ── 4. Backfill datos existentes ──────────────────────────────

UPDATE pricing_observations
SET time_of_day = get_time_of_day(observed_time::time)
WHERE time_of_day IS NULL
  AND observed_time IS NOT NULL;

-- ── 5. Recrear vistas con time_of_day en GROUP BY ─────────────

DROP VIEW IF EXISTS v_bracket_weekly_avg CASCADE;
DROP VIEW IF EXISTS v_bracket_daily_avg  CASCADE;

-- v_effective_price: agregar time_of_day (mantener el resto igual)
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
  END AS effective_price
FROM pricing_observations;


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


-- ── 6. RPCs actualizadas con p_time_of_day ────────────────────

CREATE OR REPLACE FUNCTION get_dashboard_data_weekly(
  p_city        text,
  p_category    text,
  p_country     text     DEFAULT 'Peru',
  p_zone        text     DEFAULT NULL,
  p_surge       boolean  DEFAULT NULL,
  p_week_start  int      DEFAULT NULL,
  p_year_start  int      DEFAULT NULL,
  p_week_end    int      DEFAULT NULL,
  p_year_end    int      DEFAULT NULL,
  p_data_source text     DEFAULT NULL,
  p_time_of_day text[]   DEFAULT NULL   -- NULL = todas las franjas
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
    MIN(week_start_date)                                                           AS week_start_date,
    ROUND((SUM(avg_price * observation_count) / NULLIF(SUM(observation_count), 0))::numeric, 2) AS avg_price,
    SUM(observation_count)                                                         AS observation_count,
    surge
  FROM v_bracket_weekly_avg
  WHERE country  = p_country
    AND city     = p_city
    AND category = p_category
    AND (p_zone        IS NULL OR zone = p_zone OR p_zone = 'All')
    AND (p_surge       IS NULL OR surge = p_surge)
    AND (p_data_source IS NULL OR data_source = p_data_source)
    -- Franja horaria: NULL = todas; si se pasa lista solo incluye esas franjas
    -- (excluye filas sin time_of_day cuando el filtro está activo)
    AND (
      p_time_of_day IS NULL
      OR (time_of_day IS NOT NULL AND time_of_day = ANY(p_time_of_day))
    )
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
  p_country     text     DEFAULT 'Peru',
  p_zone        text     DEFAULT NULL,
  p_surge       boolean  DEFAULT NULL,
  p_date_start  date     DEFAULT NULL,
  p_date_end    date     DEFAULT NULL,
  p_data_source text     DEFAULT NULL,
  p_time_of_day text[]   DEFAULT NULL
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
    AND (
      p_time_of_day IS NULL
      OR (time_of_day IS NOT NULL AND time_of_day = ANY(p_time_of_day))
    )
    AND (p_date_start IS NULL OR observed_date >= p_date_start)
    AND (p_date_end   IS NULL OR observed_date <= p_date_end)
  GROUP BY competition_name, distance_bracket, observed_date, surge
  ORDER BY competition_name, distance_bracket, observed_date;
$$;

-- Mantener permisos
GRANT EXECUTE ON FUNCTION get_dashboard_data_weekly(text, text, text, text, boolean, int, int, int, int, text, text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION get_dashboard_data_daily(text, text, text, text, boolean, date, date, text, text[])            TO authenticated;

-- ── 7. Índice para consultas por franja horaria ───────────────

CREATE INDEX IF NOT EXISTS idx_po_time_of_day
  ON pricing_observations(country, city, category, time_of_day);

COMMIT;
