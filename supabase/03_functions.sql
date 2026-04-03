-- ============================================================
-- FUNCTIONS & TRIGGERS
-- ============================================================

-- --------------------------------------------------------
-- Función: asignar bracket por distancia
-- Busca en distance_thresholds para city+category.
-- Si no hay configuración específica para category, cae a 'all'
-- --------------------------------------------------------
CREATE OR REPLACE FUNCTION get_distance_bracket(
  p_city     text,
  p_category text,
  p_distance numeric
) RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE
  r RECORD;
BEGIN
  -- Primero busca configuración específica para city+category
  FOR r IN
    SELECT bracket, max_km
    FROM distance_thresholds
    WHERE city = p_city AND category = p_category
    ORDER BY COALESCE(max_km, 999999) ASC
  LOOP
    IF r.max_km IS NULL OR p_distance <= r.max_km THEN
      RETURN r.bracket;
    END IF;
  END LOOP;

  -- Fallback a 'all' para esa ciudad
  FOR r IN
    SELECT bracket, max_km
    FROM distance_thresholds
    WHERE city = p_city AND category = 'all'
    ORDER BY COALESCE(max_km, 999999) ASC
  LOOP
    IF r.max_km IS NULL OR p_distance <= r.max_km THEN
      RETURN r.bracket;
    END IF;
  END LOOP;

  RETURN 'very_long';
END;
$$;

-- --------------------------------------------------------
-- Trigger: auto-asignar bracket y rush_hour al insertar
-- --------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_assign_computed_fields()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Asignar bracket
  NEW.distance_bracket := get_distance_bracket(NEW.city, NEW.category, NEW.distance_km);

  -- Asignar año e ISO week si no vienen
  IF NEW.year IS NULL THEN
    NEW.year := EXTRACT(year FROM NEW.observed_date);
  END IF;
  IF NEW.week IS NULL THEN
    NEW.week := EXTRACT(isoyear FROM NEW.observed_date) * 100 + EXTRACT(week FROM NEW.observed_date);
    -- Usar solo la semana ISO (1-53)
    NEW.week := EXTRACT(week FROM NEW.observed_date)::int;
  END IF;

  -- Asignar rush_hour si no viene
  IF NEW.rush_hour IS NULL AND NEW.observed_time IS NOT NULL THEN
    NEW.rush_hour := (
      (NEW.observed_time >= '07:00' AND NEW.observed_time <= '09:00') OR
      (NEW.observed_time >= '17:00' AND NEW.observed_time <= '20:00')
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS before_insert_pricing ON pricing_observations;
CREATE TRIGGER before_insert_pricing
  BEFORE INSERT OR UPDATE ON pricing_observations
  FOR EACH ROW EXECUTE FUNCTION trg_assign_computed_fields();

-- --------------------------------------------------------
-- RPC: datos para dashboard semanal
-- Devuelve filas de v_bracket_weekly_avg filtradas
-- --------------------------------------------------------
CREATE OR REPLACE FUNCTION get_dashboard_data_weekly(
  p_city       text,
  p_category   text,
  p_zone       text    DEFAULT NULL,
  p_surge      boolean DEFAULT NULL,
  p_week_start int     DEFAULT NULL,   -- semana ISO inicio (e.g. 7)
  p_year_start int     DEFAULT NULL,
  p_week_end   int     DEFAULT NULL,
  p_year_end   int     DEFAULT NULL
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
    ROUND(avg_price::numeric, 2)  AS avg_price,
    observation_count,
    surge
  FROM v_bracket_weekly_avg
  WHERE city     = p_city
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

-- --------------------------------------------------------
-- RPC: datos para dashboard diario
-- --------------------------------------------------------
CREATE OR REPLACE FUNCTION get_dashboard_data_daily(
  p_city       text,
  p_category   text,
  p_zone       text    DEFAULT NULL,
  p_surge      boolean DEFAULT NULL,
  p_date_start date    DEFAULT NULL,
  p_date_end   date    DEFAULT NULL
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
  WHERE city     = p_city
    AND category = p_category
    AND (p_zone  IS NULL OR zone = p_zone OR p_zone = 'All')
    AND (p_surge IS NULL OR surge = p_surge)
    AND (p_date_start IS NULL OR observed_date >= p_date_start)
    AND (p_date_end   IS NULL OR observed_date <= p_date_end)
  ORDER BY competition_name, distance_bracket, observed_date;
$$;

-- --------------------------------------------------------
-- RPC: listar zonas disponibles para city+category
-- --------------------------------------------------------
CREATE OR REPLACE FUNCTION get_available_zones(
  p_city     text,
  p_category text
) RETURNS TABLE (zone text)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT DISTINCT COALESCE(po.zone, 'All') AS zone
  FROM pricing_observations po
  WHERE po.city = p_city AND po.category = p_category
  ORDER BY 1;
$$;
