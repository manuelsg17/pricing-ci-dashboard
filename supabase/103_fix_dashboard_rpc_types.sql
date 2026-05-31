-- ════════════════════════════════════════════════════════════════════════
-- Migración 103 — Fix tipo bigint en get_dashboard_data_* + cleanup dups
--
-- CONTEXTO 2026-05-31:
--   Mig 100 reescribió get_dashboard_data_weekly y daily como PL/pgSQL
--   (antes eran SQL functions). PL/pgSQL hace strict type checking en
--   RETURN QUERY contra RETURNS TABLE.
--
--   El RETURNS TABLE declara `observation_count bigint` pero el SELECT
--   hace `SUM(observation_count)` y en Postgres SUM(bigint) → numeric
--   (para evitar overflow). PL/pgSQL rechaza con:
--     42804: Returned type numeric does not match expected type bigint
--
--   Resultado: dashboard tirando 400 (Bad Request) en cada llamada a
--   get_dashboard_data_weekly y daily.
--
--   Adicionalmente, mig 100 dejó duplicates de get_dashboard_data_daily
--   (versión vieja 6-arg sin country + versión nueva 9-arg con guard).
--
-- QUÉ HACE:
--   A) Drop de TODAS las firmas de las 2 funciones (por nombre, no
--      por signature exacta — evita el mismo problema que tuvo mig 101).
--   B) Re-create con SUM(...)::bigint para satisfacer el strict type check.
--   C) Mantiene PERFORM require_country_access(p_country) al frente.
--
-- DIFERENCIA CLAVE vs mig 100:
--   ROUND(...) AS avg_price → ya devuelve numeric (OK)
--   SUM(observation_count)::bigint AS observation_count → cast explícito
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── A) Drop TODAS las versiones de ambas funciones ──────────────────────
DO $drop_all$
DECLARE
  fn record;
  v_dropped int := 0;
BEGIN
  FOR fn IN
    SELECT p.oid, p.proname,
           pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('get_dashboard_data_weekly', 'get_dashboard_data_daily')
  LOOP
    EXECUTE format('DROP FUNCTION public.%I(%s) CASCADE', fn.proname, fn.args);
    RAISE NOTICE '[mig 103] dropped: %(%)', fn.proname, fn.args;
    v_dropped := v_dropped + 1;
  END LOOP;
  RAISE NOTICE '[mig 103] total dropped: %', v_dropped;
END
$drop_all$;

-- ── B) Re-create get_dashboard_data_weekly con cast ────────────────────
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
  FROM v_bracket_weekly_avg v
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

GRANT EXECUTE ON FUNCTION get_dashboard_data_weekly(text, text, text, text, boolean, int, int, int, int, text, text[]) TO authenticated;

-- ── C) Re-create get_dashboard_data_daily con cast ─────────────────────
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
  FROM v_bracket_daily_avg v
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

GRANT EXECUTE ON FUNCTION get_dashboard_data_daily(text, text, text, text, boolean, date, date, text, text[]) TO authenticated;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
--
-- 1. Solo 1 versión de cada función (sin duplicates):
--    SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args,
--           (pg_get_functiondef(p.oid) ILIKE '%require_country_access%') AS has_guard
--    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname='public'
--      AND p.proname IN ('get_dashboard_data_weekly','get_dashboard_data_daily');
--    → Esperado: exactamente 2 filas, ambas has_guard=true.
--
-- 2. Smoke test desde SQL Editor (simula JWT):
--    SET LOCAL request.jwt.claims = '{"email": "tu_email@yango-team.com", "role": "authenticated"}';
--    SELECT * FROM get_dashboard_data_weekly('Lima', 'Economy/Comfort', 'Peru') LIMIT 1;
--    → Devuelve filas (sin error de tipo).
--
-- 3. Hard reload del dashboard → debe cargar data.
-- ════════════════════════════════════════════════════════════════════════
