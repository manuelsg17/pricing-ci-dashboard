-- ════════════════════════════════════════════════════════════════════════
-- Migración 234 — Política de retención de `pricing_observations`
--
-- PROBLEMA (revisión de arquitectura 2026-09-03, punto #6):
--   La tabla crece ~35 %/mes (abr 115 MB → ago 380 MB, 2.2M filas) y no
--   había ninguna política: cada partición mensual se queda adjunta para
--   siempre. Eso encarece el planner (18+ particiones en cada consulta
--   por `observed_date`), el `refresh_ci_aggregates(4000)` semanal y el
--   backup, para datos crudos que nadie lee más allá de ~un año — el
--   dashboard vive de los agregados semanales/diarios, no del crudo.
--
-- POLÍTICA:
--   Quedan adjuntos los últimos 18 meses. Lo anterior se DESPRENDE y se
--   mueve al esquema `archive` (mismo nombre de tabla). No se borra nada:
--   los datos siguen en disco, consultables por SQL directo, y borrarlos
--   es una decisión aparte que se toma con autorización explícita (§8).
--   `archive` no está expuesto por PostgREST y no tiene grants para
--   anon/authenticated.
--
-- INVARIANTE NUEVO — el piso de `refresh_ci_aggregates`:
--   Los agregados (`v_bracket_weekly_avg_mv`, `v_bracket_daily_avg_mv`,
--   `v_yango_rival_diff_mv`) se reconstruyen con DELETE + INSERT desde
--   `v_week_start`. Si esa ventana llegara por debajo de la partición más
--   vieja adjunta, el DELETE borraría el histórico y el INSERT no lo
--   repondría (el crudo ya no está). Por eso la ventana se acota al primer
--   lunes ≥ la partición más vieja adjunta: las semanas archivadas quedan
--   CONGELADAS en los agregados, nunca se tocan. Es lo que mantiene el
--   histórico del dashboard intacto después de archivar.
--
-- HOY (2026-09-03) NO ARCHIVA NADA: la partición más vieja es 2025_07
-- (14 meses). La primera que cae es 2025_07, el 2027-02-02.
-- ════════════════════════════════════════════════════════════════════════
BEGIN;

-- ── 1. Esquema de archivo, cerrado ───────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS archive;
REVOKE ALL ON SCHEMA archive FROM PUBLIC, anon, authenticated;
COMMENT ON SCHEMA archive IS
  'mig 234: particiones de pricing_observations desprendidas (>18 meses). No expuesto por la Data API.';

-- ── 2. Piso de los agregados: primer lunes >= partición más vieja adjunta
CREATE OR REPLACE FUNCTION public.pricing_aggregates_floor()
RETURNS date
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT date_trunc('week', min(lower_bound) + interval '6 days')::date
  FROM (
    SELECT (regexp_match(pg_get_expr(c.relpartbound, c.oid),
                         'FROM \(''(\d{4}-\d{2}-\d{2})''\)'))[1]::date AS lower_bound
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'public.pricing_observations'::regclass
      AND c.relname <> 'pricing_observations_default'
  ) p;
$$;
COMMENT ON FUNCTION public.pricing_aggregates_floor() IS
  'mig 234: refresh_ci_aggregates nunca reconstruye por debajo de esta fecha (semanas archivadas quedan congeladas).';

-- ── 3. refresh_ci_aggregates con el piso ─────────────────────────────────
-- Cuerpo idéntico a mig 226 salvo las 2 líneas marcadas "mig 234".
CREATE OR REPLACE FUNCTION public.refresh_ci_aggregates(p_days integer DEFAULT 14)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '900s'
AS $function$
DECLARE
  v_week_start date := date_trunc('week', current_date - GREATEST(p_days, 1))::date;
  v_floor      date := public.pricing_aggregates_floor();                       -- mig 234
  v_max_date   date;
  t_start      timestamptz := clock_timestamp();
  v_weekly bigint; v_daily bigint; v_rival bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('refresh_ci_aggregates'));

  v_week_start := GREATEST(v_week_start, COALESCE(v_floor, v_week_start));    -- mig 234

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
    'window_days', GREATEST(p_days, 1), 'week_start', v_week_start, 'floor', v_floor,  -- mig 234
    'weekly_rows', v_weekly, 'daily_rows', v_daily, 'rival_rows', v_rival,
    'total_ms', round(EXTRACT(EPOCH FROM (clock_timestamp() - t_start)) * 1000),
    'refreshed_at', now()
  );
END;
$function$;

-- ── 4. El archivador ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.archive_old_pricing_partitions(p_keep_months integer DEFAULT 18)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_cutoff   date := (date_trunc('month', current_date) - make_interval(months => p_keep_months))::date;
  r          record;
  v_archived text[] := '{}';
BEGIN
  -- Freno de seguridad: nunca menos de 12 meses adjuntos, ni por error de tipeo.
  IF p_keep_months < 12 THEN
    RAISE EXCEPTION 'archive_old_pricing_partitions: p_keep_months=% (mínimo 12)', p_keep_months;
  END IF;

  FOR r IN
    SELECT c.relname,
           (regexp_match(pg_get_expr(c.relpartbound, c.oid),
                         'TO \(''(\d{4}-\d{2}-\d{2})''\)'))[1]::date AS upper_bound
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'public.pricing_observations'::regclass
      AND c.relname <> 'pricing_observations_default'
    ORDER BY 2
  LOOP
    -- Se archiva una partición solo cuando TODO su rango es anterior al corte.
    IF r.upper_bound IS NOT NULL AND r.upper_bound <= v_cutoff THEN
      EXECUTE format('ALTER TABLE public.pricing_observations DETACH PARTITION public.%I', r.relname);
      EXECUTE format('ALTER TABLE public.%I SET SCHEMA archive', r.relname);
      v_archived := v_archived || r.relname;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'keep_months', p_keep_months, 'cutoff', v_cutoff,
    'archived', to_jsonb(v_archived), 'new_floor', public.pricing_aggregates_floor(),
    'at', now());
END;
$$;
REVOKE ALL ON FUNCTION public.archive_old_pricing_partitions(integer) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.archive_old_pricing_partitions(integer) IS
  'mig 234: desprende particiones con más de p_keep_months meses y las mueve a archive.* (no borra). Corre por pg_cron el día 2 de cada mes.';

-- ── 5. Cron mensual: día 2, 03:30 UTC (después del reconcile full del domingo,
--       y antes del ensure-next-partition del lunes; el orden no importa
--       gracias al piso, pero así ninguno compite por el lock).
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'archive-old-pricing-partitions';
SELECT cron.schedule(
  'archive-old-pricing-partitions',
  '30 3 2 * *',
  $$SELECT public.archive_old_pricing_partitions(18)$$
);

COMMIT;

-- ── Verificación ─────────────────────────────────────────────────────────
--   SELECT public.pricing_aggregates_floor();          -- 2025-07-07 (primer lunes ≥ 2025-07-01)
--   SELECT public.archive_old_pricing_partitions(18);  -- archived = [] hoy
--   SELECT public.refresh_ci_aggregates(4000)->>'week_start';  -- = floor, ya no 2015
