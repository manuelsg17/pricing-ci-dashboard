-- ============================================================
-- MIGRACIÓN 25: Corregir category='Comfort+/Premier' → 'Premier'
-- 1,546 registros tienen el nombre UI como categoría en la BD,
-- lo que los hace invisibles en el Dashboard (que filtra por 'Premier').
-- ============================================================

-- ──────────────────────────────────────────────────────────
-- 1. Cuántos registros afectados (por ciudad)
-- ──────────────────────────────────────────────────────────
SELECT city, COUNT(*) AS registros
FROM pricing_observations
WHERE category = 'Comfort+/Premier'
GROUP BY city
ORDER BY city;


-- ──────────────────────────────────────────────────────────
-- 2. Corregir el nombre de categoría
-- ──────────────────────────────────────────────────────────
UPDATE pricing_observations
SET category = 'Premier'
WHERE category = 'Comfort+/Premier';


-- ──────────────────────────────────────────────────────────
-- 3. Recalcular brackets para los registros recién corregidos
--    (antes usaban category='Comfort+/Premier' que no tiene
--    thresholds → todos quedaron como 'very_long')
--    Ahora con category='Premier' los thresholds de Lima y
--    Airport sí existen.
-- ──────────────────────────────────────────────────────────
UPDATE pricing_observations
SET distance_bracket = get_distance_bracket(city, category, distance_km)
WHERE category = 'Premier'
  AND distance_km IS NOT NULL;


-- ──────────────────────────────────────────────────────────
-- 4. Verificación final
-- ──────────────────────────────────────────────────────────
SELECT city, category, competition_name, COUNT(*) AS registros
FROM pricing_observations
WHERE competition_name = 'YangoPremier'
GROUP BY city, category, competition_name
ORDER BY city, category;

-- Resultado esperado: todas las filas con category='Premier', ninguna con 'Comfort+/Premier'
