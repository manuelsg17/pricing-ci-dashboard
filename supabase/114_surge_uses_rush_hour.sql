-- ════════════════════════════════════════════════════════════════════════
-- Migración 114 — El filtro SURGE del dashboard pasa a usar RUSH HOUR
--
-- CONTEXTO:
--   El analista quiere que el filtro SURGE muestre SOLO la data cuya hora local
--   cae en sus ventanas de Rush Hour (Config → Horarios → Rush Hour; hoy
--   07:00-09:00 y 17:00-20:00), y SURGE=No el resto. La pestaña "Franjas con
--   surge" (surge_windows, mig 111) queda obsoleta.
--
--   pricing_observations.rush_hour YA está pre-calculado por fila (trigger
--   trg_assign_computed_fields, respeta ventanas por ciudad). Verificado:
--   rush_hour=true ⟺ observed_time en [07-09]∪[17-20], 0 filas en el hueco.
--
-- APPROACH:
--   Exponer `rush_hour` como dimensión en las MVs/vistas del dashboard y
--   filtrarlo en los RPC `_fast`. El filtro SURGE del front pasa p_rush_hour
--   (Sí=true, No=false, Ambos=null). El flag `surge` del bot se conserva (lo
--   usa el drill-down), solo deja de manejar el filtro.
--
--   · Vistas regulares: CREATE OR REPLACE con rush_hour AL FINAL (requisito de
--     CREATE OR REPLACE VIEW) + rush_hour en el GROUP BY. Los RPC regulares
--     re-agregan, así que el total no cambia (suma sobre rush_hour).
--   · MVs: DROP+CREATE (no admiten CREATE OR REPLACE) con rush_hour + índice
--     único que lo incluye. WITH NO DATA y REFRESH al final (evita timeout en
--     el DDL; el primer populate es no-concurrente).
--   · RPC `_fast`: DROP+CREATE con nuevo parámetro p_rush_hour (un parámetro
--     nuevo crea otra firma → se dropea la vieja para no dejar overload).
--
-- PARIDAD: sumar sobre rush_hour reproduce exactamente los totales previos.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Vistas regulares (rush_hour al final + en GROUP BY) ───────────────
CREATE OR REPLACE VIEW v_bracket_weekly_avg AS
SELECT
  country, city, year, week, category,
  COALESCE(zone, 'All'::text) AS zone,
  competition_name, distance_bracket, surge, data_source, time_of_day,
  count(*)             AS observation_count,
  avg(effective_price) AS avg_price,
  min(observed_date)   AS week_start_date,
  rush_hour
FROM v_effective_price
WHERE effective_price IS NOT NULL AND effective_price > 0::numeric
GROUP BY country, city, year, week, category, zone, competition_name,
         distance_bracket, surge, data_source, time_of_day, rush_hour;

CREATE OR REPLACE VIEW v_bracket_daily_avg AS
SELECT
  country, city, observed_date,
  EXTRACT(isodow FROM observed_date)::integer AS day_of_week,
  category, COALESCE(zone, 'All'::text) AS zone,
  competition_name, distance_bracket, surge, data_source, time_of_day,
  count(*)             AS observation_count,
  avg(effective_price) AS avg_price,
  rush_hour
FROM v_effective_price
WHERE effective_price IS NOT NULL AND effective_price > 0::numeric
GROUP BY country, city, observed_date, category, zone, competition_name,
         distance_bracket, surge, data_source, time_of_day, rush_hour;

-- ── 2. MV semanal (DROP+CREATE con rush_hour) ───────────────────────────
DROP MATERIALIZED VIEW IF EXISTS v_bracket_weekly_avg_mv;
CREATE MATERIALIZED VIEW v_bracket_weekly_avg_mv AS
SELECT
  country, city, year, week, category,
  COALESCE(zone, 'All'::text) AS zone,
  competition_name, distance_bracket, surge, data_source, time_of_day, rush_hour,
  count(*)             AS observation_count,
  avg(effective_price) AS avg_price,
  min(observed_date)   AS week_start_date
FROM v_effective_price
WHERE effective_price IS NOT NULL AND effective_price > 0::numeric
GROUP BY country, city, year, week, category, zone, competition_name,
         distance_bracket, surge, data_source, time_of_day, rush_hour
WITH NO DATA;

CREATE UNIQUE INDEX idx_bwa_mv_unique ON v_bracket_weekly_avg_mv
  (country, city, year, week, category, zone, competition_name,
   distance_bracket, surge, data_source, time_of_day, rush_hour) NULLS NOT DISTINCT;
CREATE INDEX idx_bwa_mv_dashboard ON v_bracket_weekly_avg_mv
  (country, city, category, year, week);

-- ── 3. MV diaria (DROP+CREATE con rush_hour) ────────────────────────────
DROP MATERIALIZED VIEW IF EXISTS v_bracket_daily_avg_mv;
CREATE MATERIALIZED VIEW v_bracket_daily_avg_mv AS
SELECT
  country, city, observed_date,
  EXTRACT(isodow FROM observed_date)::integer AS day_of_week,
  category, COALESCE(zone, 'All'::text) AS zone,
  competition_name, distance_bracket, surge, data_source, time_of_day, rush_hour,
  count(*)             AS observation_count,
  avg(effective_price) AS avg_price
FROM v_effective_price
WHERE effective_price IS NOT NULL AND effective_price > 0::numeric
GROUP BY country, city, observed_date, category, zone, competition_name,
         distance_bracket, surge, data_source, time_of_day, rush_hour
WITH NO DATA;

CREATE UNIQUE INDEX idx_bda_mv_unique ON v_bracket_daily_avg_mv
  (country, city, observed_date, category, zone, competition_name,
   distance_bracket, surge, data_source, time_of_day, rush_hour) NULLS NOT DISTINCT;
CREATE INDEX idx_bda_mv_dashboard ON v_bracket_daily_avg_mv
  (country, city, category, observed_date);

-- ── 4. RPC _fast: nuevo parámetro p_rush_hour ───────────────────────────
DROP FUNCTION IF EXISTS get_dashboard_data_weekly_fast(
  text, text, text, text, boolean, integer, integer, integer, integer, text, text[]);
CREATE FUNCTION get_dashboard_data_weekly_fast(
  p_city text, p_category text, p_country text,
  p_zone text DEFAULT NULL, p_surge boolean DEFAULT NULL,
  p_week_start integer DEFAULT NULL, p_year_start integer DEFAULT NULL,
  p_week_end integer DEFAULT NULL, p_year_end integer DEFAULT NULL,
  p_data_source text DEFAULT NULL, p_time_of_day text[] DEFAULT NULL,
  p_rush_hour boolean DEFAULT NULL
)
RETURNS TABLE(competition_name text, distance_bracket text, week integer,
  year integer, week_start_date date, avg_price numeric,
  observation_count bigint, surge boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM require_country_access(p_country);
  RETURN QUERY
  SELECT
    v.competition_name,
    v.distance_bracket,
    v.week,
    v.year,
    MIN(v.week_start_date) AS week_start_date,
    ROUND((SUM(v.avg_price * v.observation_count) / NULLIF(SUM(v.observation_count), 0))::numeric, 2) AS avg_price,
    SUM(v.observation_count)::bigint AS observation_count,
    v.surge
  FROM v_bracket_weekly_avg_mv v
  WHERE v.country  = p_country
    AND v.city     = p_city
    AND v.category = p_category
    AND (p_zone        IS NULL OR v.zone = p_zone OR p_zone = 'All')
    AND (p_surge       IS NULL OR v.surge = p_surge)
    AND (p_data_source IS NULL OR v.data_source = p_data_source)
    AND (p_time_of_day IS NULL OR v.time_of_day = ANY(p_time_of_day))
    AND (p_rush_hour   IS NULL OR v.rush_hour = p_rush_hour)
    AND (p_year_start IS NULL OR (v.year > p_year_start) OR (v.year = p_year_start AND v.week >= p_week_start))
    AND (p_year_end   IS NULL OR (v.year < p_year_end)   OR (v.year = p_year_end   AND v.week <= p_week_end))
  GROUP BY v.competition_name, v.distance_bracket, v.week, v.year, v.surge
  ORDER BY v.competition_name, v.distance_bracket, v.year, v.week;
END;
$function$;

DROP FUNCTION IF EXISTS get_dashboard_data_daily_fast(
  text, text, text, text, boolean, date, date, text, text[]);
CREATE FUNCTION get_dashboard_data_daily_fast(
  p_city text, p_category text, p_country text,
  p_zone text DEFAULT NULL, p_surge boolean DEFAULT NULL,
  p_date_start date DEFAULT NULL, p_date_end date DEFAULT NULL,
  p_data_source text DEFAULT NULL, p_time_of_day text[] DEFAULT NULL,
  p_rush_hour boolean DEFAULT NULL
)
RETURNS TABLE(competition_name text, distance_bracket text, observed_date date,
  avg_price numeric, observation_count bigint, surge boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM require_country_access(p_country);
  RETURN QUERY
  SELECT
    v.competition_name,
    v.distance_bracket,
    v.observed_date,
    ROUND((SUM(v.avg_price * v.observation_count) / NULLIF(SUM(v.observation_count), 0))::numeric, 2) AS avg_price,
    SUM(v.observation_count)::bigint AS observation_count,
    v.surge
  FROM v_bracket_daily_avg_mv v
  WHERE v.country  = p_country
    AND v.city     = p_city
    AND v.category = p_category
    AND (p_zone        IS NULL OR v.zone = p_zone OR p_zone = 'All')
    AND (p_surge       IS NULL OR v.surge = p_surge)
    AND (p_data_source IS NULL OR v.data_source = p_data_source)
    AND (p_time_of_day IS NULL OR v.time_of_day = ANY(p_time_of_day))
    AND (p_rush_hour   IS NULL OR v.rush_hour = p_rush_hour)
    AND (p_date_start  IS NULL OR v.observed_date >= p_date_start)
    AND (p_date_end    IS NULL OR v.observed_date <= p_date_end)
  GROUP BY v.competition_name, v.distance_bracket, v.observed_date, v.surge
  ORDER BY v.competition_name, v.distance_bracket, v.observed_date;
END;
$function$;

COMMIT;

-- ── 5. Populate (fuera de la txn DDL; primer refresh no-concurrente) ─────
REFRESH MATERIALIZED VIEW v_bracket_weekly_avg_mv;
REFRESH MATERIALIZED VIEW v_bracket_daily_avg_mv;

-- ── 6. Headroom de timeout para el refresh horario ──────────────────────
-- Las MVs crecieron ~20-30% al sumar rush_hour. refresh_dashboard_mv() corre
-- 3 REFRESH CONCURRENTLY en serie desde el cron (mig 106) como postgres, que
-- hereda statement_timeout=120s (el comentario de mig 106 sobre "sin ese cap"
-- era incorrecto) y ya rozaba el límite. Le damos aire: 600s.
ALTER FUNCTION public.refresh_dashboard_mv() SET statement_timeout = '600s';
