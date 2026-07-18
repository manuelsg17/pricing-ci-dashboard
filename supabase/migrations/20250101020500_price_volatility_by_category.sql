-- ════════════════════════════════════════════════════════════════════════
-- Migración 126 — Volatilidad de precio real (soles) por competidor y categoría
--
-- CONTEXTO:
--   La página Competitividad (mig 124/125) mide Δ% (Yango vs rival), no
--   precio absoluto, y solo compara Yango contra rivales — no da un precio
--   "de Yango" comparable al de "InDrive" en la misma tabla. El usuario
--   pidió ver, para una categoría, cuánto varía el precio TÍPICO de cada
--   competidor (incluyendo Yango) — ej. "el P50 de Yango va de 10 a 40
--   soles, mientras que InDrive va de 20 a 22" — para detectar si Yango es
--   más inconsistente que la competencia.
--
-- APPROACH:
--   v_bracket_weekly_avg_mv (ya existe, refresh cada 15 min por
--   refresh-mv-weekly) tiene una fila por (país,ciudad,categoría,bracket,
--   año,semana,competidor) con avg_price — INCLUYE filas con
--   competition_name='Yango' (mig 124 tuvo que excluirlas explícitamente
--   con NOT ILIKE 'Yango%' para armar el lado rival, lo cual prueba que
--   existen). Tomamos TODOS los avg_price que matchean país+categoría
--   (across ciudades, brackets, semanas del período) por competidor y
--   calculamos sus percentiles — la dispersión natural entre bracket corto
--   y largo, entre ciudades, y entre semanas ES la "volatilidad" que pide
--   ver el usuario. No hace falta partir por bracket: ya viene de ahí.
--
--   No se crea MV nueva — se lee v_bracket_weekly_avg_mv directo, filtrada
--   a un solo país+categoría (miles de filas, no cientos de miles).
--
-- VERIFICACIÓN:
--   SELECT * FROM get_price_volatility_by_category('Peru','Economy/Comfort');
--   → confirmar min_price <= p10 <= p25 <= p50 <= p75 <= p90 <= max_price
--     para cada fila, y que 'Yango' aparece junto a los rivales reales.
-- ════════════════════════════════════════════════════════════════════════

CREATE FUNCTION public.get_price_volatility_by_category(
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
    -- Solo el Yango canónico + rivales reales — excluye sub-marcas internas
    -- de Yango (ej. 'YangoComfort') que NO son un competidor aparte.
    AND (v.competition_name = 'Yango' OR v.competition_name NOT ILIKE 'Yango%')
    AND (p_year_start IS NULL OR (v.year > p_year_start) OR (v.year = p_year_start AND v.week >= p_week_start))
    AND (p_year_end   IS NULL OR (v.year < p_year_end)   OR (v.year = p_year_end   AND v.week <= p_week_end))
  GROUP BY v.competition_name
  ORDER BY v.competition_name;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_price_volatility_by_category(text, text, int, int, int, int) TO authenticated;
