-- ════════════════════════════════════════════════════════════════════════
-- Migración 105 — Materialized views para hot path del dashboard
--
-- CONTEXTO (audit auditor 04 — strategic improvement #2):
--   get_dashboard_data_weekly/daily re-agregan v_effective_price (full
--   scan de pricing_observations con ~600k rows) en CADA render del
--   dashboard. Latencia perceptible y va a empeorar con Mexico/más data.
--
--   Las views v_bracket_weekly_avg y v_bracket_daily_avg hacen el grupo
--   pesado (GROUP BY con 11 columnas + AVG/COUNT). Si las cacheamos como
--   MATERIALIZED VIEW, el dashboard pasa de ~500ms→3s (depende del filtro)
--   a ~50-100ms estable.
--
-- APPROACH CONSERVADOR DE ESTA MIG:
--   1. CREA los materialized views EN PARALELO a los views regulares.
--      v_bracket_weekly_avg sigue vivo y los RPCs actuales SIGUEN
--      usándolo. Sin riesgo de regresión.
--   2. CREA función refresh_dashboard_mv() que el operador puede llamar
--      manualmente o programar via pg_cron (no incluido — opcional).
--   3. CREA RPCs NUEVAS get_dashboard_data_weekly_fast /
--      get_dashboard_data_daily_fast que usan los MVs.
--   4. El cutover (cambiar Dashboard.jsx para llamar las _fast) se hace
--      en un commit separado cuando el operador validó perf.
--
-- REFRESH STRATEGY:
--   - REFRESH MATERIALIZED VIEW CONCURRENTLY requiere un UNIQUE INDEX.
--     Lo creamos sobre todas las cols del GROUP BY.
--   - El cliente puede llamar SELECT refresh_dashboard_mv() después de
--     un insert/update masivo (post-upload, post-bot-sync) para
--     refrescar. Toma 5-30s dependiendo del tamaño.
--   - Para refresh automático cada N minutos: agregar pg_cron job
--     (no incluido — el operador decide cadencia).
--
-- POSTGRES VERSION:
--   Asume Postgres 15+ (Supabase lo soporta). Usamos NULLS NOT DISTINCT
--   en el UNIQUE INDEX para que columnas opcionales (surge, data_source,
--   time_of_day) puedan ser NULL sin romper UNIQUE.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── A) v_bracket_weekly_avg_mv ──────────────────────────────────────────
DROP MATERIALIZED VIEW IF EXISTS v_bracket_weekly_avg_mv CASCADE;

CREATE MATERIALIZED VIEW v_bracket_weekly_avg_mv AS
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

-- UNIQUE INDEX requerido para REFRESH CONCURRENTLY. NULLS NOT DISTINCT
-- permite que columnas opcionales (surge/data_source/time_of_day) sean
-- NULL sin que el index colisione con otra fila NULL en la misma combo.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bwa_mv_unique
  ON v_bracket_weekly_avg_mv (
    country, city, year, week, category, zone,
    competition_name, distance_bracket, surge, data_source, time_of_day
  ) NULLS NOT DISTINCT;

-- Index secundario para queries del dashboard (filtros frecuentes)
CREATE INDEX IF NOT EXISTS idx_bwa_mv_dashboard
  ON v_bracket_weekly_avg_mv (country, city, category, year, week);

-- ── B) v_bracket_daily_avg_mv ───────────────────────────────────────────
DROP MATERIALIZED VIEW IF EXISTS v_bracket_daily_avg_mv CASCADE;

CREATE MATERIALIZED VIEW v_bracket_daily_avg_mv AS
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_bda_mv_unique
  ON v_bracket_daily_avg_mv (
    country, city, observed_date, category, zone,
    competition_name, distance_bracket, surge, data_source, time_of_day
  ) NULLS NOT DISTINCT;

CREATE INDEX IF NOT EXISTS idx_bda_mv_dashboard
  ON v_bracket_daily_avg_mv (country, city, category, observed_date);

-- ── C) refresh_dashboard_mv() — refresh manual programable ─────────────
-- Refresca ambas MVs CONCURRENTLY (no bloquea reads). El operador puede:
--   a) Llamarla manualmente: SELECT refresh_dashboard_mv();
--   b) Agregar pg_cron job:
--      SELECT cron.schedule('refresh-dashboard-mv', '*/10 * * * *',
--                           $$SELECT refresh_dashboard_mv()$$);
--   c) Llamarla desde el bot después de un sync batch.
--
-- SECURITY DEFINER + search_path hardening (Sprint 1 mig 100 pattern).
CREATE OR REPLACE FUNCTION refresh_dashboard_mv()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  t_start timestamptz := clock_timestamp();
  weekly_ms numeric;
  daily_ms  numeric;
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY v_bracket_weekly_avg_mv;
  weekly_ms := EXTRACT(EPOCH FROM (clock_timestamp() - t_start)) * 1000;

  t_start := clock_timestamp();
  REFRESH MATERIALIZED VIEW CONCURRENTLY v_bracket_daily_avg_mv;
  daily_ms := EXTRACT(EPOCH FROM (clock_timestamp() - t_start)) * 1000;

  RETURN jsonb_build_object(
    'weekly_ms', weekly_ms,
    'daily_ms',  daily_ms,
    'refreshed_at', now()
  );
END;
$$;

GRANT EXECUTE ON FUNCTION refresh_dashboard_mv() TO authenticated;

-- ── D) RPCs NUEVAS get_dashboard_data_*_fast — usan MVs ────────────────
-- Mismo signature que las versiones regulares (mig 103) — el cutover es
-- cambiar el nombre que invoca Dashboard.jsx. Por ahora coexisten.

CREATE OR REPLACE FUNCTION get_dashboard_data_weekly_fast(
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
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM require_country_access(p_country);
  RETURN QUERY
  SELECT
    v.competition_name,
    v.distance_bracket,
    v.week,
    v.year,
    MIN(v.week_start_date)                                                                            AS week_start_date,
    ROUND((SUM(v.avg_price * v.observation_count) / NULLIF(SUM(v.observation_count), 0))::numeric, 2) AS avg_price,
    SUM(v.observation_count)::bigint                                                                  AS observation_count,
    v.surge
  FROM v_bracket_weekly_avg_mv v   -- ← MV en lugar de view regular
  WHERE v.country  = p_country
    AND v.city     = p_city
    AND v.category = p_category
    AND (p_zone        IS NULL OR v.zone = p_zone OR p_zone = 'All')
    AND (p_surge       IS NULL OR v.surge = p_surge)
    AND (p_data_source IS NULL OR v.data_source = p_data_source)
    AND (p_time_of_day IS NULL OR v.time_of_day = ANY(p_time_of_day))
    AND (
      p_year_start IS NULL OR
      (v.year > p_year_start) OR
      (v.year = p_year_start AND v.week >= p_week_start)
    )
    AND (
      p_year_end IS NULL OR
      (v.year < p_year_end) OR
      (v.year = p_year_end AND v.week <= p_week_end)
    )
  GROUP BY v.competition_name, v.distance_bracket, v.week, v.year, v.surge
  ORDER BY v.competition_name, v.distance_bracket, v.year, v.week;
END;
$$;

GRANT EXECUTE ON FUNCTION get_dashboard_data_weekly_fast(text, text, text, text, boolean, int, int, int, int, text, text[]) TO authenticated;

CREATE OR REPLACE FUNCTION get_dashboard_data_daily_fast(
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
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM require_country_access(p_country);
  RETURN QUERY
  SELECT
    v.competition_name,
    v.distance_bracket,
    v.observed_date,
    ROUND((SUM(v.avg_price * v.observation_count) / NULLIF(SUM(v.observation_count), 0))::numeric, 2) AS avg_price,
    SUM(v.observation_count)::bigint                                                                  AS observation_count,
    v.surge
  FROM v_bracket_daily_avg_mv v   -- ← MV en lugar de view regular
  WHERE v.country  = p_country
    AND v.city     = p_city
    AND v.category = p_category
    AND (p_zone        IS NULL OR v.zone = p_zone OR p_zone = 'All')
    AND (p_surge       IS NULL OR v.surge = p_surge)
    AND (p_data_source IS NULL OR v.data_source = p_data_source)
    AND (p_time_of_day IS NULL OR v.time_of_day = ANY(p_time_of_day))
    AND (p_date_start  IS NULL OR v.observed_date >= p_date_start)
    AND (p_date_end    IS NULL OR v.observed_date <= p_date_end)
  GROUP BY v.competition_name, v.distance_bracket, v.observed_date, v.surge
  ORDER BY v.competition_name, v.distance_bracket, v.observed_date;
END;
$$;

GRANT EXECUTE ON FUNCTION get_dashboard_data_daily_fast(text, text, text, text, boolean, date, date, text, text[]) TO authenticated;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- POST-MIG: refresh inicial para poblar las MVs con la data actual.
-- (Fuera del BEGIN/COMMIT porque REFRESH puede tardar minutos en DB grande.)
-- Si tomas > 30s, considera correr esto OFF-PEAK.
-- ════════════════════════════════════════════════════════════════════════
REFRESH MATERIALIZED VIEW v_bracket_weekly_avg_mv;
REFRESH MATERIALIZED VIEW v_bracket_daily_avg_mv;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
--
-- 1. Comparar perf antes/después:
--    EXPLAIN ANALYZE SELECT * FROM get_dashboard_data_weekly(
--      'Lima', 'Economy/Comfort', 'Peru');
--    EXPLAIN ANALYZE SELECT * FROM get_dashboard_data_weekly_fast(
--      'Lima', 'Economy/Comfort', 'Peru');
--    → la _fast debería ser 5-10× más rápida.
--
-- 2. Validar resultados idénticos:
--    SELECT a.competition_name, a.week, a.avg_price AS slow,
--           b.avg_price AS fast,
--           ROUND(ABS(a.avg_price - b.avg_price)::numeric, 4) AS diff
--    FROM get_dashboard_data_weekly('Lima','Economy/Comfort','Peru') a
--    JOIN get_dashboard_data_weekly_fast('Lima','Economy/Comfort','Peru') b
--      ON a.competition_name=b.competition_name AND a.week=b.week
--    WHERE ROUND(ABS(a.avg_price - b.avg_price)::numeric, 4) > 0;
--    → Esperado: 0 filas (resultados idénticos).
--
-- 3. Refresh manual:
--    SELECT refresh_dashboard_mv();
--    → devuelve { weekly_ms, daily_ms, refreshed_at }.
--
-- CUTOVER (commit separado cuando estés listo):
--   En src/hooks/usePricingData.js cambiar las llamadas:
--     'get_dashboard_data_weekly' → 'get_dashboard_data_weekly_fast'
--     'get_dashboard_data_daily'  → 'get_dashboard_data_daily_fast'
--   Y agregar refresh post-upload en Upload.jsx o trigger DB.
-- ════════════════════════════════════════════════════════════════════════
