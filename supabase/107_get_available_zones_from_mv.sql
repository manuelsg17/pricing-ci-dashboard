-- ════════════════════════════════════════════════════════════════════════
-- Migración 107 — get_available_zones lee de la MV (fix timeout 8s)
--
-- CONTEXTO (bug encontrado en smoke test del cutover Mig 105):
--   get_available_zones(p_city,p_category,p_country) hacía
--   `SELECT DISTINCT COALESCE(zone,'All') FROM pricing_observations WHERE
--   country/city/category`. Eso escanea TODAS las observaciones de ese
--   city/category (~102k filas para Lima/Economy-Comfort) solo para devolver
--   un puñado de zonas distintas. Medido: ~9s en frío → excede el
--   statement_timeout=8s del rol `authenticated` → el browser recibe 500
--   (error rojo en consola, el dropdown de ZONA no se puebla).
--
-- APPROACH:
--   Leer las zonas de v_bracket_weekly_avg_mv (mig 105), que ya tiene la
--   columna `zone` (= COALESCE(zone,'All')) pre-agregada a ~41k filas
--   totales / cientos por city-category. Mismo resultado en ~ms, nunca
--   timeout. Consistente con el cutover (el dashboard ya lee de las MVs).
--
-- EQUIVALENCIA (verificada antes de aplicar):
--   - Parity por caso (incl. multi-zona: Trujillo_Airport_A devuelve
--     ['3.82','6.9','All'] igual que el scan crudo).
--   - Global: 0 combos (country,city,category,zone) existen en
--     pricing_observations y NO en la MV. El rewrite no pierde ninguna zona.
--   - Única diferencia teórica futura: una zona cuyas filas tengan TODAS
--     effective_price<=0 no aparecería — pero esa zona no muestra datos en
--     el dashboard de todos modos. Freshness: zonas nuevas aparecen al
--     próximo refresh horario de la MV (mig 106).
--
-- VERIFICACIÓN:
--   EXPLAIN ANALYZE SELECT * FROM get_available_zones('Lima','Economy/Comfort','Peru');
--   -- esperado: pocos ms (antes ~9s).
-- ════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.get_available_zones(p_city text, p_category text, p_country text)
 RETURNS TABLE(zone text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM require_country_access(p_country);
  RETURN QUERY
  SELECT DISTINCT v.zone
  FROM v_bracket_weekly_avg_mv v
  WHERE v.country  = p_country
    AND v.city     = p_city
    AND v.category = p_category
  ORDER BY 1;
END;
$function$;
