-- ════════════════════════════════════════════════════════════════════════
-- Migración 128 — Filtro de ciudad + piso de precio en volatilidad (mig 126/127)
--
-- CONTEXTO (pedido del usuario, viendo la página en vivo):
--   1) Quiere filtrar la comparación de volatilidad por ciudad (hoy agrega
--      TODAS las ciudades del país en una sola distribución).
--   2) Vio Cabify con un "Mín" de S/0.24 en Comfort+ y lo marcó como error
--      100% — ninguna categoría cuesta menos de S/2 en estas ciudades.
--      Verificado en vivo: es EXACTAMENTE 1 bucket (Trujillo, very_long,
--      semana 27, observation_count=1) con avg_price=0.236 — un dato suelto
--      erróneo, no un patrón. Se agrega un piso `avg_price >= 2` para
--      descartar este tipo de outlier. El piso es universal (no por país):
--      ninguna moneda de las que soporta este dashboard (S/, COP, NPR, BOB,
--      ZMW, USD) tiene un viaje real por debajo de 2 unidades, así que es
--      inofensivo donde no aplica y corrige el caso real donde sí aplica.
--
-- VERIFICACIÓN:
--   SELECT * FROM get_price_volatility_by_category('Peru','Comfort+',NULL,NULL,NULL,NULL,'Trujillo');
--   → Cabify ya no debe traer el bucket de S/0.24 (el resto de Trujillo/
--     Comfort+ sigue intacto).
-- ════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.get_price_volatility_by_category(
  p_country    text,
  p_category   text,
  p_year_start int  DEFAULT NULL,
  p_week_start int  DEFAULT NULL,
  p_year_end   int  DEFAULT NULL,
  p_week_end   int  DEFAULT NULL,
  p_city       text DEFAULT NULL
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
    AND (p_city IS NULL OR v.city = p_city)
    AND v.avg_price >= 2  -- descarta buckets de 1 observación con precio casi-cero (dato erróneo, no real)
    AND (lower(btrim(v.competition_name)) = 'yango' OR v.competition_name NOT ILIKE 'Yango%')
    AND (p_year_start IS NULL OR (v.year > p_year_start) OR (v.year = p_year_start AND v.week >= p_week_start))
    AND (p_year_end   IS NULL OR (v.year < p_year_end)   OR (v.year = p_year_end   AND v.week <= p_week_end))
  GROUP BY v.competition_name
  ORDER BY v.competition_name;
END;
$function$;
