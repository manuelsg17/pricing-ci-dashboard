-- ════════════════════════════════════════════════════════════════════════
-- Migración 226 — v_bracket_weekly_avg_mv: week_start_date por CALENDARIO
-- (no por data) + columna last_observed_date para indicador de frescura.
--
-- PROBLEMA 1 (week_start_date fragmentado) — explicado simple:
--   Cada fila de v_bracket_weekly_avg_mv no es "una semana", es "una semana
--   PARA una combinación específica de competidor+bracket+surge+fuente+
--   franja horaria". Cuando la tabla calculaba week_start_date como
--   MIN(observed_date), cada una de esas combinaciones se quedaba con SU
--   PROPIO primer día de dato dentro de la semana — no el lunes real de la
--   semana ISO. Si el bot mandó el dato de "InDrive corto" el lunes pero el
--   de "Uber largo" recién el miércoles, la MISMA semana calendario terminó
--   con dos week_start_date distintos (lunes y miércoles) en la misma tabla.
--   Verificado en producción (2026-08-29): Bogotá semana 20-2026 tiene 7
--   fechas de inicio DISTINTAS para una sola semana ISO — una por cada día
--   en que llegó el primer dato de alguna combinación.
--   IMPACTO REAL HOY: ninguno visible — el frontend arma sus columnas por
--   (year, week) directamente y nunca lee week_start_date (verificado por
--   grep en src/). Pero cualquiera que consulte la tabla directo (como
--   hicimos varias veces esta sesión) recibe una fecha que no significa
--   "el lunes de esa semana", sino "cuándo llegó el primer dato de ESE
--   grupo" — confuso y con potencial de armar mal un reporte futuro.
--   FIX: derivar week_start_date del CALENDARIO ISO (year, week) → siempre
--   el mismo lunes, sin importar cuántas combinaciones tenga la semana.
--
-- PROBLEMA 2 (nada nuevo, feature) — indicador de frescura por celda:
--   Hoy la única señal de "esto no es dato en vivo" es el candado 🔒 de
--   pricing_wa_frozen (una semana CONGELADA a propósito). No hay forma de
--   ver si la columna actual del dashboard tiene dato de HOY o si el bot
--   viene atrasado y la última observación real es de hace varios días.
--   Se agrega last_observed_date (MAX(observed_date) del mismo grupo) para
--   que el frontend pueda avisar "esta columna no tiene dato reciente".
--
-- ALCANCE: solo v_bracket_weekly_avg_mv (semanal). v_bracket_daily_avg_mv
-- no lo necesita — cada fila YA es un día exacto (observed_date), no hay
-- ambigüedad que resolver ahí.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Nueva columna ─────────────────────────────────────────────────────
ALTER TABLE public.v_bracket_weekly_avg_mv
  ADD COLUMN IF NOT EXISTS last_observed_date date;

-- ── 2. refresh_ci_aggregates(): week_start_date por calendario ISO +
--       last_observed_date = MAX(observed_date) del grupo ──────────────────
-- to_date('IYYYIWID') interpreta (año ISO, semana ISO, día ISO 1=lunes) y
-- siempre da el lunes real de esa semana — es función pura de (year, week),
-- no depende de qué combinación de columnas tenga o no dato ese día.
-- Verificado: to_date('2026'||'32'||'1','IYYYIWID') = 2026-08-03 (lunes).
CREATE OR REPLACE FUNCTION public.refresh_ci_aggregates(p_days integer DEFAULT 14)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '900s'
AS $function$
DECLARE
  v_week_start date := date_trunc('week', current_date - GREATEST(p_days, 1))::date;
  v_max_date   date;
  t_start      timestamptz := clock_timestamp();
  v_weekly bigint; v_daily bigint; v_rival bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('refresh_ci_aggregates'));

  SELECT GREATEST(current_date, COALESCE(max(observed_date), current_date))
    INTO v_max_date FROM pricing_observations;

  -- ── Semanal ──
  DELETE FROM v_bracket_weekly_avg_mv t
  WHERE (t.year, t.week) IN (
    SELECT DISTINCT EXTRACT(isoyear FROM d)::int, EXTRACT(week FROM d)::int
    FROM generate_series(v_week_start::timestamp, v_max_date::timestamp, interval '1 day') d
  );
  INSERT INTO v_bracket_weekly_avg_mv (
    country, city, year, week, category, zone, competition_name, distance_bracket,
    surge, data_source, time_of_day, rush_hour, observation_count, avg_price,
    week_start_date, last_observed_date)
  SELECT e.country, e.city, e.year, e.week, e.category, COALESCE(e.zone, 'All'),
         e.competition_name, e.distance_bracket, e.surge, e.data_source, e.time_of_day, e.rush_hour,
         count(*), avg(e.effective_price),
         to_date(e.year::text || lpad(e.week::text, 2, '0') || '1', 'IYYYIWID'),
         max(e.observed_date)
  FROM v_effective_price e
  WHERE e.effective_price IS NOT NULL AND e.effective_price > 0
    AND e.observed_date >= v_week_start
  GROUP BY e.country, e.city, e.year, e.week, e.category, COALESCE(e.zone, 'All'),
           e.competition_name, e.distance_bracket, e.surge, e.data_source, e.time_of_day, e.rush_hour;
  GET DIAGNOSTICS v_weekly = ROW_COUNT;

  -- ── Diario (sin cambios respecto a mig 163) ──
  DELETE FROM v_bracket_daily_avg_mv t WHERE t.observed_date >= v_week_start;
  INSERT INTO v_bracket_daily_avg_mv (
    country, city, observed_date, day_of_week, category, zone, competition_name,
    distance_bracket, surge, data_source, time_of_day, rush_hour, observation_count, avg_price)
  SELECT e.country, e.city, e.observed_date, EXTRACT(isodow FROM e.observed_date)::int,
         e.category, COALESCE(e.zone, 'All'), e.competition_name, e.distance_bracket,
         e.surge, e.data_source, e.time_of_day, e.rush_hour,
         count(*), avg(e.effective_price)
  FROM v_effective_price e
  WHERE e.effective_price IS NOT NULL AND e.effective_price > 0
    AND e.observed_date >= v_week_start
  GROUP BY e.country, e.city, e.observed_date, e.category, COALESCE(e.zone, 'All'),
           e.competition_name, e.distance_bracket, e.surge, e.data_source, e.time_of_day, e.rush_hour;
  GET DIAGNOSTICS v_daily = ROW_COUNT;

  -- ── Yango vs rivales (sin cambios respecto a mig 163) ──
  DELETE FROM v_yango_rival_diff_mv t
  WHERE (t.year, t.week) IN (
    SELECT DISTINCT EXTRACT(isoyear FROM d)::int, EXTRACT(week FROM d)::int
    FROM generate_series(v_week_start::timestamp, v_max_date::timestamp, interval '1 day') d
  );
  INSERT INTO v_yango_rival_diff_mv (
    yango_observation_id, country, city, category, distance_bracket, year, week,
    observed_date, data_source, competitor_name, yango_price, rival_avg_price,
    rival_obs_count, pct_diff)
  WITH rival_ref AS (
    SELECT v.country, v.city, v.category, v.distance_bracket, v.year, v.week,
           v.competition_name AS rival_name,
           sum(v.avg_price * v.observation_count::numeric)
             / NULLIF(sum(v.observation_count), 0::numeric) AS rival_avg_price,
           sum(v.observation_count)::bigint AS rival_obs_count
    FROM v_bracket_weekly_avg_mv v
    WHERE v.week_start_date >= v_week_start
      AND v.competition_name !~~* 'Yango%' AND v.category <> 'Corp'
      AND v.competition_name IS NOT NULL AND v.distance_bracket IS NOT NULL
    GROUP BY v.country, v.city, v.category, v.distance_bracket, v.year, v.week, v.competition_name
  ), yango_obs AS (
    SELECT e.id AS yango_observation_id, e.country, e.city, e.category, e.distance_bracket,
           e.year, e.week, e.observed_date, e.data_source, e.effective_price AS yango_price
    FROM v_effective_price e
    WHERE e.observed_date >= v_week_start
      AND e.competition_name = 'Yango' AND e.category <> 'Corp'
      AND e.effective_price IS NOT NULL AND e.effective_price > 0
      AND e.distance_bracket = ANY (ARRAY['very_short','short','median','average','long','very_long'])
  )
  SELECT y.yango_observation_id, y.country, y.city, y.category, y.distance_bracket,
         y.year, y.week, y.observed_date, y.data_source, r.rival_name,
         y.yango_price, round(r.rival_avg_price, 2), r.rival_obs_count,
         round(((y.yango_price - r.rival_avg_price) / NULLIF(r.rival_avg_price, 0)) * 100, 6)
  FROM yango_obs y
  JOIN rival_ref r ON r.country = y.country AND r.city = y.city AND r.category = y.category
                  AND r.distance_bracket = y.distance_bracket AND r.year = y.year AND r.week = y.week;
  GET DIAGNOSTICS v_rival = ROW_COUNT;

  RETURN jsonb_build_object(
    'window_days', GREATEST(p_days, 1), 'week_start', v_week_start,
    'weekly_rows', v_weekly, 'daily_rows', v_daily, 'rival_rows', v_rival,
    'total_ms', round(EXTRACT(EPOCH FROM (clock_timestamp() - t_start)) * 1000),
    'refreshed_at', now()
  );
END;
$function$;

-- ── 3. RPC _fast: expone last_observed_date. RETURNS TABLE cambia →
--       DROP + CREATE explícito (CREATE OR REPLACE no puede cambiar el
--       tipo de retorno; ver regla de RPCs en CLAUDE.md §3). ────────────
DROP FUNCTION IF EXISTS get_dashboard_data_weekly_fast(
  text, text, text, text, boolean, integer, integer, integer, integer, text, text[], boolean);

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
  observation_count bigint, surge boolean, last_observed_date date)
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
    v.surge,
    MAX(v.last_observed_date) AS last_observed_date
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

GRANT EXECUTE ON FUNCTION get_dashboard_data_weekly_fast(
  text, text, text, text, boolean, integer, integer, integer, integer, text, text[], boolean) TO authenticated;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- POST-MIG: backfill de TODA la historia (fuera de la transacción — puede
-- tardar; misma operación que ya corre sola los domingos vía
-- refresh-ci-reconcile-full, mig 163). Recalcula week_start_date por
-- calendario y puebla last_observed_date para las filas existentes.
-- ════════════════════════════════════════════════════════════════════════
SELECT public.refresh_ci_aggregates(4000);

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
--   1. Ya no hay fragmentación:
--      SELECT country, city, year, week, count(DISTINCT week_start_date)
--      FROM v_bracket_weekly_avg_mv GROUP BY 1,2,3,4 HAVING count(DISTINCT week_start_date) > 1;
--      → Esperado: 0 filas.
--   2. last_observed_date poblado:
--      SELECT count(*) FROM v_bracket_weekly_avg_mv WHERE last_observed_date IS NULL;
--      → Esperado: 0.
--   3. week_start_date siempre lunes:
--      SELECT count(*) FROM v_bracket_weekly_avg_mv WHERE EXTRACT(isodow FROM week_start_date) <> 1;
--      → Esperado: 0.
-- ════════════════════════════════════════════════════════════════════════
