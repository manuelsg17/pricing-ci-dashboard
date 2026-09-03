-- ════════════════════════════════════════════════════════════════════════
-- Migración 235 — `v_yango_rival_diff_mv` compacta (Fase 4 de la revisión
-- de arquitectura 2026-09-03)
--
-- PROBLEMA:
--   Era el objeto más grande de la base: 489 MB (306 heap + 183 índices),
--   1,45 M filas, y crecía ~300 k filas/mes. Guardaba UNA fila por
--   (observación Yango × rival) con 14 columnas: id de observación, fecha,
--   fuente, 3 precios… Sus únicos lectores son dos RPCs de Competitividad
--   (`get_competitive_band_summary` / `_breakdown`) que usan exactamente 7
--   dimensiones + `pct_diff`, y nada más. Las otras 6 columnas no las leía
--   nadie (verificado: ningún cliente, script ni función las referencia).
--
-- SOLUCIÓN (medida en prod antes de escribir esto):
--   Agrupar por las 7 dimensiones + `pct_diff` con su PRECISIÓN ORIGINAL y
--   guardar `n` = cuántas observaciones tienen ese valor. 1 451 271 filas →
--   539 220 (los precios de Yango se repiten mucho dentro de una semana), y
--   cada fila pasa de 222 B a ~90 B. Con la precisión original (no
--   redondeada) el resultado de las RPCs es IDÉNTICO bit a bit: se probó
--   que redondear a 2 decimales no reducía más filas (539 220 en ambos
--   casos) pero sí movía hasta 16 observaciones de banda en el borde —
--   por eso no se redondea.
--
--   Las RPCs vuelven a expandir (`generate_series(1, n)`) antes de agregar,
--   así los `count(*) FILTER` y `percentile_cont` quedan textualmente
--   iguales a los de mig 125/127. El costo de expandir una ventana de 8
--   semanas (~35 k filas por banda) es despreciable frente a leer 489 MB.
--
-- QUÉ NO CAMBIA: nombre de la tabla, firmas y salidas de las 2 RPCs, el
--   hook `useCompetitiveBandAnalysis.js`, el cron de refresh. Sin cambios
--   en el cliente → sin ventana de bundle viejo (§4 expandir/contraer no
--   aplica: nadie del lado del cliente lee la tabla).
-- ════════════════════════════════════════════════════════════════════════
BEGIN;

-- ── 1. Tabla nueva, poblada desde la vieja (re-agrupar, sin ir al crudo) ──
CREATE TABLE public.v_yango_rival_diff_mv_new (
  country          text    NOT NULL,
  city             text    NOT NULL,
  category         text    NOT NULL,
  distance_bracket text    NOT NULL,
  year             integer NOT NULL,
  week             integer NOT NULL,
  competitor_name  text    NOT NULL,
  pct_diff         numeric,
  n                integer NOT NULL CHECK (n > 0)
);

INSERT INTO public.v_yango_rival_diff_mv_new
  (country, city, category, distance_bracket, year, week, competitor_name, pct_diff, n)
SELECT country, city, category, distance_bracket, year, week, competitor_name, pct_diff, count(*)::int
FROM public.v_yango_rival_diff_mv
GROUP BY country, city, category, distance_bracket, year, week, competitor_name, pct_diff;

DROP TABLE public.v_yango_rival_diff_mv;
ALTER TABLE public.v_yango_rival_diff_mv_new RENAME TO v_yango_rival_diff_mv;

-- Mismo orden de columnas que filtran las RPCs (country, competitor,
-- category, ventana) para que el rango sea un index range scan.
CREATE UNIQUE INDEX ux_yango_rival_diff_mv ON public.v_yango_rival_diff_mv
  (country, competitor_name, category, year, week, city, distance_bracket, pct_diff)
  NULLS NOT DISTINCT;
CREATE INDEX idx_yango_rival_diff_window ON public.v_yango_rival_diff_mv (year, week);

-- Misma postura que la tabla vieja: RLS activo sin políticas (solo la leen
-- RPCs SECURITY DEFINER), sin grants para anon/authenticated (§3).
ALTER TABLE public.v_yango_rival_diff_mv ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.v_yango_rival_diff_mv FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.v_yango_rival_diff_mv IS
  'mig 235: Δ% Yango vs rival por (país, ciudad, categoría, bracket, semana, rival, pct_diff) con n observaciones. La rellena refresh_ci_aggregates; la leen get_competitive_band_summary/breakdown expandiendo n.';

ANALYZE public.v_yango_rival_diff_mv;

-- ── 2. refresh_ci_aggregates: la sección rival escribe el grano nuevo ────
-- Cuerpo idéntico a mig 234 salvo el INSERT final (marcado "mig 235").
CREATE OR REPLACE FUNCTION public.refresh_ci_aggregates(p_days integer DEFAULT 14)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '900s'
AS $function$
DECLARE
  v_week_start date := date_trunc('week', current_date - GREATEST(p_days, 1))::date;
  v_floor      date := public.pricing_aggregates_floor();
  v_max_date   date;
  t_start      timestamptz := clock_timestamp();
  v_weekly bigint; v_daily bigint; v_rival bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('refresh_ci_aggregates'));

  v_week_start := GREATEST(v_week_start, COALESCE(v_floor, v_week_start));

  SELECT GREATEST(current_date, COALESCE(max(observed_date), current_date))
    INTO v_max_date FROM pricing_observations;

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

  DELETE FROM v_yango_rival_diff_mv t
  WHERE (t.year, t.week) IN (
    SELECT DISTINCT EXTRACT(isoyear FROM d)::int, EXTRACT(week FROM d)::int
    FROM generate_series(v_week_start::timestamp, v_max_date::timestamp, interval '1 day') d
  );
  -- mig 235: grano compacto — una fila por valor distinto de pct_diff, con n.
  INSERT INTO v_yango_rival_diff_mv (
    country, city, category, distance_bracket, year, week, competitor_name, pct_diff, n)
  WITH rival_ref AS (
    SELECT v.country, v.city, v.category, v.distance_bracket, v.year, v.week,
           v.competition_name AS rival_name,
           sum(v.avg_price * v.observation_count::numeric)
             / NULLIF(sum(v.observation_count), 0::numeric) AS rival_avg_price
    FROM v_bracket_weekly_avg_mv v
    WHERE v.week_start_date >= v_week_start
      AND v.competition_name !~~* 'Yango%' AND v.category <> 'Corp'
      AND v.competition_name IS NOT NULL AND v.distance_bracket IS NOT NULL
    GROUP BY v.country, v.city, v.category, v.distance_bracket, v.year, v.week, v.competition_name
  ), yango_obs AS (
    SELECT e.country, e.city, e.category, e.distance_bracket, e.year, e.week,
           e.effective_price AS yango_price
    FROM v_effective_price e
    WHERE e.observed_date >= v_week_start
      AND e.competition_name = 'Yango' AND e.category <> 'Corp'
      AND e.effective_price IS NOT NULL AND e.effective_price > 0
      AND e.distance_bracket = ANY (ARRAY['very_short','short','median','average','long','very_long'])
  )
  SELECT y.country, y.city, y.category, y.distance_bracket, y.year, y.week, r.rival_name,
         round(((y.yango_price - r.rival_avg_price) / NULLIF(r.rival_avg_price, 0)) * 100, 6) AS pct_diff,
         count(*)::int
  FROM yango_obs y
  JOIN rival_ref r ON r.country = y.country AND r.city = y.city AND r.category = y.category
                  AND r.distance_bracket = y.distance_bracket AND r.year = y.year AND r.week = y.week
  GROUP BY y.country, y.city, y.category, y.distance_bracket, y.year, y.week, r.rival_name,
           round(((y.yango_price - r.rival_avg_price) / NULLIF(r.rival_avg_price, 0)) * 100, 6);
  GET DIAGNOSTICS v_rival = ROW_COUNT;

  RETURN jsonb_build_object(
    'window_days', GREATEST(p_days, 1), 'week_start', v_week_start, 'floor', v_floor,
    'weekly_rows', v_weekly, 'daily_rows', v_daily, 'rival_rows', v_rival,
    'total_ms', round(EXTRACT(EPOCH FROM (clock_timestamp() - t_start)) * 1000),
    'refreshed_at', now()
  );
END;
$function$;

-- ── 3. Las RPCs expanden n y agregan EXACTAMENTE como antes (mig 125/127) ─
CREATE OR REPLACE FUNCTION public.get_competitive_band_summary(
  p_country text, p_competitor_name text, p_category text, p_min_pct numeric, p_max_pct numeric,
  p_year_start integer DEFAULT NULL, p_week_start integer DEFAULT NULL,
  p_year_end integer DEFAULT NULL, p_week_end integer DEFAULT NULL,
  p_city text DEFAULT NULL, p_distance_bracket text DEFAULT NULL)
RETURNS TABLE(total_observations bigint, below_count bigint, within_count bigint, above_count bigint,
              below_pct numeric, within_pct numeric, above_pct numeric, avg_pct_diff numeric,
              p10 numeric, p25 numeric, p50 numeric, p75 numeric, p90 numeric)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM require_country_access(p_country);
  IF p_min_pct > p_max_pct THEN
    RAISE EXCEPTION 'invalid_range: min_pct (%) no puede ser mayor que max_pct (%)', p_min_pct, p_max_pct
      USING HINT = 'El piso de la banda debe ser menor o igual al techo.';
  END IF;
  RETURN QUERY
  WITH v AS (
    SELECT m.pct_diff
    FROM v_yango_rival_diff_mv m
    CROSS JOIN LATERAL generate_series(1, m.n) g
    WHERE m.country = p_country
      AND m.competitor_name = p_competitor_name
      AND m.category = p_category
      AND (p_city IS NULL OR m.city = p_city)
      AND (p_distance_bracket IS NULL OR m.distance_bracket = p_distance_bracket)
      AND (p_year_start IS NULL OR (m.year > p_year_start) OR (m.year = p_year_start AND m.week >= p_week_start))
      AND (p_year_end   IS NULL OR (m.year < p_year_end)   OR (m.year = p_year_end   AND m.week <= p_week_end))
  )
  SELECT
    count(*)::bigint,
    count(*) FILTER (WHERE v.pct_diff < p_min_pct)::bigint,
    count(*) FILTER (WHERE v.pct_diff BETWEEN p_min_pct AND p_max_pct)::bigint,
    count(*) FILTER (WHERE v.pct_diff > p_max_pct)::bigint,
    ROUND(100.0 * count(*) FILTER (WHERE v.pct_diff < p_min_pct) / NULLIF(count(*), 0), 1),
    ROUND(100.0 * count(*) FILTER (WHERE v.pct_diff BETWEEN p_min_pct AND p_max_pct) / NULLIF(count(*), 0), 1),
    ROUND(100.0 * count(*) FILTER (WHERE v.pct_diff > p_max_pct) / NULLIF(count(*), 0), 1),
    ROUND(avg(v.pct_diff)::numeric, 2),
    ROUND(percentile_cont(0.10) WITHIN GROUP (ORDER BY v.pct_diff)::numeric, 2),
    ROUND(percentile_cont(0.25) WITHIN GROUP (ORDER BY v.pct_diff)::numeric, 2),
    ROUND(percentile_cont(0.50) WITHIN GROUP (ORDER BY v.pct_diff)::numeric, 2),
    ROUND(percentile_cont(0.75) WITHIN GROUP (ORDER BY v.pct_diff)::numeric, 2),
    ROUND(percentile_cont(0.90) WITHIN GROUP (ORDER BY v.pct_diff)::numeric, 2)
  FROM v;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_competitive_band_breakdown(
  p_country text, p_competitor_name text, p_category text, p_min_pct numeric, p_max_pct numeric,
  p_year_start integer DEFAULT NULL, p_week_start integer DEFAULT NULL,
  p_year_end integer DEFAULT NULL, p_week_end integer DEFAULT NULL)
RETURNS TABLE(city text, distance_bracket text, total_observations bigint, below_count bigint,
              within_count bigint, above_count bigint, within_pct numeric, avg_pct_diff numeric, p50 numeric)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM require_country_access(p_country);
  IF p_min_pct > p_max_pct THEN
    RAISE EXCEPTION 'invalid_range: min_pct (%) no puede ser mayor que max_pct (%)', p_min_pct, p_max_pct
      USING HINT = 'El piso de la banda debe ser menor o igual al techo.';
  END IF;
  RETURN QUERY
  WITH v AS (
    SELECT m.city, m.distance_bracket, m.pct_diff
    FROM v_yango_rival_diff_mv m
    CROSS JOIN LATERAL generate_series(1, m.n) g
    WHERE m.country = p_country
      AND m.competitor_name = p_competitor_name
      AND m.category = p_category
      AND (p_year_start IS NULL OR (m.year > p_year_start) OR (m.year = p_year_start AND m.week >= p_week_start))
      AND (p_year_end   IS NULL OR (m.year < p_year_end)   OR (m.year = p_year_end   AND m.week <= p_week_end))
  )
  SELECT
    v.city, v.distance_bracket,
    count(*)::bigint,
    count(*) FILTER (WHERE v.pct_diff < p_min_pct)::bigint,
    count(*) FILTER (WHERE v.pct_diff BETWEEN p_min_pct AND p_max_pct)::bigint,
    count(*) FILTER (WHERE v.pct_diff > p_max_pct)::bigint,
    ROUND(100.0 * count(*) FILTER (WHERE v.pct_diff BETWEEN p_min_pct AND p_max_pct) / NULLIF(count(*), 0), 1),
    ROUND(avg(v.pct_diff)::numeric, 2),
    ROUND(percentile_cont(0.50) WITHIN GROUP (ORDER BY v.pct_diff)::numeric, 2)
  FROM v
  GROUP BY v.city, v.distance_bracket
  ORDER BY v.city, v.distance_bracket;
END;
$function$;

COMMIT;

-- ── Verificación en prod (inmediatamente después, ANTES del próximo refresh
--    horario, para que no entren observaciones nuevas): los md5 de las 3
--    salidas (summary 8 sem, summary histórico, breakdown 8 sem) para las 6
--    bandas activas deben ser IGUALES a los tomados antes:
--      s8  = 10e11c1efb9e4dee8208257280aeba2d
--      sall= d37b4dcfbed315505455957889302b1a
--      b8  = 26bf9598f622985c1aaf5777557897fc   (270 filas, 463 197 obs)
--    Después: SELECT public.refresh_ci_aggregates(14) → rival_rows > 0,
--    pg_total_relation_size('v_yango_rival_diff_mv') ≪ 489 MB.
