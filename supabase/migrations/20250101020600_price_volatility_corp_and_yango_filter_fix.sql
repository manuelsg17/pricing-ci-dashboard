-- ════════════════════════════════════════════════════════════════════════
-- Migración 127 — Fixes de revisión adversarial de mig 126
--
-- HALLAZGO 1 (activo hoy, verificado en vivo): category='Corp' devolvía
--   rivales SIN la fila de Yango. Corp mezcla 6 sub-marcas Yango (mig 71:
--   Corp NUNCA guarda competition_name='Yango' exacto, solo 'YangoEconomy'/
--   'YangoComfort'/etc.) — el filtro de 126 excluye esas sub-marcas por
--   diseño (para no confundirlas con rivales reales), así que para Corp el
--   resultado queda sin Yango, silenciosamente, sin error. Mismo guard que
--   ya usa mig 124 (`v_yango_rival_diff_mv`, `category <> 'Corp'`): se
--   agrega acá también, a nivel RPC (no solo en el frontend, que hoy es la
--   única protección — la RPC es GRANT EXECUTE TO authenticated y debe ser
--   correcta por sí sola).
--
-- HALLAZGO 2 (latente, no activo hoy): el filtro "Yango canónico + rivales"
--   comparaba con `=` (case-sensitive) para incluir 'Yango' pero con
--   `NOT ILIKE` (case-insensitive) para excluir sub-marcas — no son
--   complementarios. Un valor con espacio/typo que no matchee NINGUNO de
--   los dos lados se perdería en silencio. Este repo tiene historial real
--   de exactamente esta clase de bug (migs 68/70/71/96/97 normalizando
--   competition_name) — se normaliza el lado de inclusión también
--   (`lower(btrim(...))='yango'`) para no depender de que la data ya
--   esté limpia.
--
-- VERIFICACIÓN:
--   SELECT * FROM get_price_volatility_by_category('Peru','Corp');
--   → antes: sin fila 'Yango'. Después: debe seguir sin datos de Yango
--     (Corp de verdad no tiene Yango exacto) — el punto es que YA NO
--     silencia el problema si en el futuro category='Corp' sí trajera
--     Yango real (ver frontend, que igual no ofrece Corp como opción).
--   SELECT * FROM get_price_volatility_by_category('Peru','Economy/Comfort');
--   → debe seguir devolviendo exactamente lo mismo que antes (Yango +
--     Uber/InDrive/Didi/Cabify, sin YangoComfort).
-- ════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.get_price_volatility_by_category(
  p_country    text,
  p_category   text,
  p_year_start int DEFAULT NULL,
  p_week_start int DEFAULT NULL,
  p_year_end   int DEFAULT NULL,
  p_week_end   int DEFAULT NULL
)
RETURNS TABLE (
  competitor_name text,
  n_buckets       bigint,
  min_price       numeric,
  p10             numeric,
  p25             numeric,
  p50             numeric,
  p75             numeric,
  p90             numeric,
  max_price       numeric,
  avg_price       numeric
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  PERFORM require_country_access(p_country);
  RETURN QUERY
  SELECT
    v.competition_name,
    count(*)::bigint,
    ROUND(min(v.avg_price)::numeric, 2),
    ROUND(percentile_cont(0.10) WITHIN GROUP (ORDER BY v.avg_price)::numeric, 2),
    ROUND(percentile_cont(0.25) WITHIN GROUP (ORDER BY v.avg_price)::numeric, 2),
    ROUND(percentile_cont(0.50) WITHIN GROUP (ORDER BY v.avg_price)::numeric, 2),
    ROUND(percentile_cont(0.75) WITHIN GROUP (ORDER BY v.avg_price)::numeric, 2),
    ROUND(percentile_cont(0.90) WITHIN GROUP (ORDER BY v.avg_price)::numeric, 2),
    ROUND(max(v.avg_price)::numeric, 2),
    ROUND(avg(v.avg_price)::numeric, 2)
  FROM v_bracket_weekly_avg_mv v
  WHERE v.country = p_country
    AND v.category = p_category
    AND v.category <> 'Corp'
    AND (lower(btrim(v.competition_name)) = 'yango' OR v.competition_name NOT ILIKE 'Yango%')
    AND (p_year_start IS NULL OR (v.year > p_year_start) OR (v.year = p_year_start AND v.week >= p_week_start))
    AND (p_year_end   IS NULL OR (v.year < p_year_end)   OR (v.year = p_year_end   AND v.week <= p_week_end))
  GROUP BY v.competition_name
  ORDER BY v.competition_name;
END;
$function$;
