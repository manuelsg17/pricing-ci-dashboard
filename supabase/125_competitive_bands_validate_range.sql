-- ════════════════════════════════════════════════════════════════════════
-- Migración 125 — Validar min_pct<=max_pct en las RPCs de bandas competitivas
--
-- SÍNTOMA (hallado en revisión adversarial de mig 124):
--   get_competitive_band_summary / _breakdown reciben min_pct/max_pct como
--   parámetro libre (a propósito, para el preview en vivo antes de guardar).
--   El CHECK min_pct<max_pct de competitive_bands protege lo GUARDADO, pero
--   nada protegía la RPC en sí. Con min_pct > max_pct (posible momentáneamente
--   mientras el usuario tipea dos campos independientes en el preview), la
--   condición `pct_diff < min_pct` y `pct_diff > max_pct` dejan de ser
--   mutuamente excluyentes → below_count+within_count+above_count puede
--   superar total_observations (verificado con datos reales: 69,581 vs
--   62,221 con min=5,max=-5 invertidos).
--
-- FIX: guard explícito al inicio de ambas RPCs. El frontend (mig 125 +
--   useCompetitiveBandAnalysis.js) ya deja de llamar la RPC con rangos
--   inválidos, así que esto es defensa en profundidad para cualquier caller
--   directo de la RPC (API pública para authenticated).
-- ════════════════════════════════════════════════════════════════════════

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
  IF p_min_pct > p_max_pct THEN
    RAISE EXCEPTION 'invalid_range: min_pct (%) no puede ser mayor que max_pct (%)', p_min_pct, p_max_pct
      USING HINT = 'El piso de la banda debe ser menor o igual al techo.';
  END IF;
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
  IF p_min_pct > p_max_pct THEN
    RAISE EXCEPTION 'invalid_range: min_pct (%) no puede ser mayor que max_pct (%)', p_min_pct, p_max_pct
      USING HINT = 'El piso de la banda debe ser menor o igual al techo.';
  END IF;
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

-- VERIFICACIÓN:
--   SELECT * FROM get_competitive_band_summary('Peru','Uber','Economy/Comfort',5,-5);
--   → debe fallar con 'invalid_range: ...' en vez de devolver conteos inconsistentes.
