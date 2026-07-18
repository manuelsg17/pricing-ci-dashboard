-- ════════════════════════════════════════════════════════════════════════
-- Migración 124 — Competitividad vs banda configurada (competidor + categoría)
--
-- CONTEXTO:
--   El equipo de pricing (MSI) quiere una página persistente que, para una
--   banda tipo "Yango entre 5% y 15% más barato que Uber en Economy/Comfort",
--   diga qué % de cotizaciones reales de Yango cae dentro/debajo/encima de
--   esa banda, con desglose por ciudad y distancia, y percentiles P10-P90.
--
-- LIMITACIÓN DE DATOS (comunicada al usuario en la UI de la página nueva):
--   No existe forma de emparejar una cotización de Yango con la del
--   competidor para EL MISMO viaje — no hay quote_id/route_id compartido, y
--   las filas del bot ni siquiera traen point_a/point_b/zone. "Por
--   observación individual" se implementa como: cada cotización real de
--   Yango comparada contra el precio PROMEDIO del competidor en el mismo
--   bucket (country, city, category, distance_bracket, year, week).
--
-- CONVENCIÓN DE SIGNO (misma que HeadToHeadView.jsx, no la de semaforo.js):
--   pct_diff = (yango_price - rival_avg_price) / rival_avg_price * 100
--   Negativo = Yango más barato. Banda min=-15,max=-5 = "Yango entre 5% y
--   15% más barato que el rival".
--
-- DISEÑO:
--   1) competitive_bands: config (competidor+categoría → min/max %, aplica
--      a TODAS las ciudades/brackets). RLS país-scoped (como bracket_weights)
--      + trigger de auditoría explícito (patrón exacto de mig 111
--      surge_windows) para live-sync desde el día uno.
--   2) v_yango_rival_diff_mv: grano = 1 fila por cotización Yango × rival
--      real comparado. Config-agnóstica a propósito (cruza contra TODO
--      rival real, no solo pares ya guardados) para soportar preview de
--      bandas nuevas sin esperar el refresh. Colapsa el lado rival ANTES
--      del join (mismo patrón de freeze_pricing_wa, mig 121) — evita la
--      explosión cartesiana de esa migración.
--   3) 2 RPCs (percentile_cont + count FILTER) que reciben min_pct/max_pct
--      como parámetro — permiten preview sin guardar en competitive_bands.
--   4) Cron propio 'refresh-mv-competitive-bands' — horario propio, nunca
--      combinar refreshes de varias MV en una transacción (lección mig 119).
--
-- VERIFICACIÓN: ver bloque final del archivo.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── A. Tabla de configuración ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.competitive_bands (
  id              serial PRIMARY KEY,
  country         text    NOT NULL DEFAULT 'Peru',
  competitor_name text    NOT NULL,
  category        text    NOT NULL,
  min_pct         numeric NOT NULL,
  max_pct         numeric NOT NULL,
  note            text,
  is_active       boolean NOT NULL DEFAULT true,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT competitive_bands_range_chk CHECK (min_pct < max_pct),
  CONSTRAINT competitive_bands_no_yango_chk CHECK (competitor_name NOT ILIKE 'Yango%'),
  UNIQUE (country, competitor_name, category)
);

COMMENT ON COLUMN public.competitive_bands.min_pct IS
  'Piso de pct_diff = (Yango-Rival)/Rival*100 (convención HeadToHeadView). Ej: -15 = Yango hasta 15% más barato.';
COMMENT ON COLUMN public.competitive_bands.max_pct IS
  'Techo de pct_diff. Ej: -5 = Yango no debe pasar de 5% de descuento vs el rival (o quedar más caro).';

ALTER TABLE public.competitive_bands ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS competitive_bands_select ON public.competitive_bands;
DROP POLICY IF EXISTS competitive_bands_insert ON public.competitive_bands;
DROP POLICY IF EXISTS competitive_bands_update ON public.competitive_bands;
DROP POLICY IF EXISTS competitive_bands_delete ON public.competitive_bands;

CREATE POLICY competitive_bands_select ON public.competitive_bands
  FOR SELECT TO authenticated USING (can_access_country(country));
CREATE POLICY competitive_bands_insert ON public.competitive_bands
  FOR INSERT TO authenticated WITH CHECK (can_edit());
CREATE POLICY competitive_bands_update ON public.competitive_bands
  FOR UPDATE TO authenticated USING (can_edit()) WITH CHECK (can_edit());
CREATE POLICY competitive_bands_delete ON public.competitive_bands
  FOR DELETE TO authenticated USING (can_edit());

DROP TRIGGER IF EXISTS trg_audit_competitive_bands ON public.competitive_bands;
CREATE TRIGGER trg_audit_competitive_bands
  AFTER INSERT OR UPDATE OR DELETE ON public.competitive_bands
  FOR EACH ROW EXECUTE FUNCTION log_changes();

-- ── B. MV de detalle: v_yango_rival_diff_mv ─────────────────────────────
DROP MATERIALIZED VIEW IF EXISTS public.v_yango_rival_diff_mv;

CREATE MATERIALIZED VIEW public.v_yango_rival_diff_mv AS
WITH rival_ref AS (
  -- Colapsa el lado del rival ANTES del join (patrón freeze_pricing_wa,
  -- mig 121): v_bracket_weekly_avg_mv tiene múltiples filas por bucket
  -- (zone/surge/data_source/time_of_day/rush_hour) — sin este colapso el
  -- join explota y distorsiona el promedio.
  SELECT
    v.country, v.city, v.category, v.distance_bracket, v.year, v.week,
    v.competition_name AS rival_name,
    SUM(v.avg_price * v.observation_count) / NULLIF(SUM(v.observation_count), 0) AS rival_avg_price,
    SUM(v.observation_count)::bigint AS rival_obs_count
  FROM v_bracket_weekly_avg_mv v
  WHERE v.competition_name NOT ILIKE 'Yango%'
    AND v.category <> 'Corp'
    AND v.competition_name IS NOT NULL
    AND v.distance_bracket IS NOT NULL
  GROUP BY v.country, v.city, v.category, v.distance_bracket, v.year, v.week, v.competition_name
),
yango_obs AS (
  -- Grano individual: cada fila es UNA cotización real de Yango, vía
  -- v_effective_price (nunca precio crudo). competition_name='Yango' exacto
  -- excluye Corp (usa 'YangoEconomy') y las sub-marcas propias.
  SELECT
    e.id AS yango_observation_id,
    e.country, e.city, e.category, e.distance_bracket, e.year, e.week,
    e.observed_date, e.data_source,
    e.effective_price AS yango_price
  FROM v_effective_price e
  WHERE e.competition_name = 'Yango'
    AND e.category <> 'Corp'
    AND e.effective_price IS NOT NULL
    AND e.effective_price > 0
    AND e.distance_bracket = ANY (ARRAY['very_short','short','median','average','long','very_long'])
)
SELECT
  y.yango_observation_id,
  y.country, y.city, y.category, y.distance_bracket, y.year, y.week,
  y.observed_date, y.data_source,
  r.rival_name AS competitor_name,
  y.yango_price,
  ROUND(r.rival_avg_price::numeric, 2) AS rival_avg_price,
  r.rival_obs_count,
  ROUND((((y.yango_price - r.rival_avg_price) / NULLIF(r.rival_avg_price, 0)) * 100)::numeric, 6) AS pct_diff
FROM yango_obs y
JOIN rival_ref r
  ON r.country = y.country AND r.city = y.city AND r.category = y.category
 AND r.distance_bracket = y.distance_bracket AND r.year = y.year AND r.week = y.week
WITH NO DATA;

CREATE UNIQUE INDEX ux_yango_rival_diff_mv
  ON public.v_yango_rival_diff_mv (yango_observation_id, competitor_name);

CREATE INDEX idx_yango_rival_diff_lookup
  ON public.v_yango_rival_diff_mv (country, competitor_name, category, year, week);

-- ── C. RPCs ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_competitive_band_summary(
  p_country          text,
  p_competitor_name  text,
  p_category         text,
  p_min_pct          numeric,
  p_max_pct          numeric,
  p_year_start       int  DEFAULT NULL,
  p_week_start       int  DEFAULT NULL,
  p_year_end         int  DEFAULT NULL,
  p_week_end         int  DEFAULT NULL,
  p_city             text DEFAULT NULL,
  p_distance_bracket text DEFAULT NULL
)
RETURNS TABLE (
  total_observations bigint,
  below_count        bigint,
  within_count       bigint,
  above_count        bigint,
  below_pct          numeric,
  within_pct         numeric,
  above_pct          numeric,
  avg_pct_diff       numeric,
  p10 numeric, p25 numeric, p50 numeric, p75 numeric, p90 numeric
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM require_country_access(p_country);
  RETURN QUERY
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
  FROM v_yango_rival_diff_mv v
  WHERE v.country = p_country
    AND v.competitor_name = p_competitor_name
    AND v.category = p_category
    AND (p_city IS NULL OR v.city = p_city)
    AND (p_distance_bracket IS NULL OR v.distance_bracket = p_distance_bracket)
    AND (p_year_start IS NULL OR (v.year > p_year_start) OR (v.year = p_year_start AND v.week >= p_week_start))
    AND (p_year_end   IS NULL OR (v.year < p_year_end)   OR (v.year = p_year_end   AND v.week <= p_week_end));
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_competitive_band_summary(
  text, text, text, numeric, numeric, int, int, int, int, text, text
) TO authenticated;

CREATE OR REPLACE FUNCTION public.get_competitive_band_breakdown(
  p_country         text,
  p_competitor_name text,
  p_category        text,
  p_min_pct         numeric,
  p_max_pct         numeric,
  p_year_start      int DEFAULT NULL,
  p_week_start      int DEFAULT NULL,
  p_year_end        int DEFAULT NULL,
  p_week_end        int DEFAULT NULL
)
RETURNS TABLE (
  city               text,
  distance_bracket   text,
  total_observations bigint,
  below_count        bigint,
  within_count       bigint,
  above_count        bigint,
  within_pct         numeric,
  avg_pct_diff       numeric,
  p50                numeric
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM require_country_access(p_country);
  RETURN QUERY
  SELECT
    v.city, v.distance_bracket,
    count(*)::bigint,
    count(*) FILTER (WHERE v.pct_diff < p_min_pct)::bigint,
    count(*) FILTER (WHERE v.pct_diff BETWEEN p_min_pct AND p_max_pct)::bigint,
    count(*) FILTER (WHERE v.pct_diff > p_max_pct)::bigint,
    ROUND(100.0 * count(*) FILTER (WHERE v.pct_diff BETWEEN p_min_pct AND p_max_pct) / NULLIF(count(*), 0), 1),
    ROUND(avg(v.pct_diff)::numeric, 2),
    ROUND(percentile_cont(0.50) WITHIN GROUP (ORDER BY v.pct_diff)::numeric, 2)
  FROM v_yango_rival_diff_mv v
  WHERE v.country = p_country
    AND v.competitor_name = p_competitor_name
    AND v.category = p_category
    AND (p_year_start IS NULL OR (v.year > p_year_start) OR (v.year = p_year_start AND v.week >= p_week_start))
    AND (p_year_end   IS NULL OR (v.year < p_year_end)   OR (v.year = p_year_end   AND v.week <= p_week_end))
  GROUP BY v.city, v.distance_bracket
  ORDER BY v.city, v.distance_bracket;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_competitive_band_breakdown(
  text, text, text, numeric, numeric, int, int, int, int
) TO authenticated;

COMMIT;

-- ── D. Primer populate (fuera de la txn DDL, no-concurrente — patrón mig 114/119) ─
REFRESH MATERIALIZED VIEW public.v_yango_rival_diff_mv;

-- ── E. Cron propio, horario sin solape con los jobs activos hoy ─────────
-- Activos hoy (verificado en vivo): refresh-mv-weekly(*/15), refresh-mv-daily
-- (:07), refresh-mv-botvsmanual(:09), reconcile-indrive-bot-prices(*/10).
-- :20 no choca con ninguno y da margen tras el refresh de :15 de la weekly
-- (de la que depende esta MV). Hereda el statement_timeout=600s del rol
-- postgres (mig 119).
SELECT cron.schedule(
  'refresh-mv-competitive-bands',
  '20 * * * *',
  $$REFRESH MATERIALIZED VIEW CONCURRENTLY public.v_yango_rival_diff_mv$$
);

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN POST-APLICACIÓN:
--   1. SELECT count(*) FROM v_yango_rival_diff_mv;
--   2. SELECT * FROM get_competitive_band_summary('Peru','Uber','Economy/Comfort',-15,-5);
--      → below_count+within_count+above_count debe sumar exactamente total_observations,
--        y p10<=p25<=p50<=p75<=p90.
--   3. Spot-check manual de un bucket real (ver plan de la migración).
-- ════════════════════════════════════════════════════════════════════════
