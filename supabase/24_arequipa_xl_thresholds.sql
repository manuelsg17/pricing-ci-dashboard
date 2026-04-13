-- ============================================================
-- MIGRACIÓN 24: Arequipa XL thresholds + Corp weights + diagnóstico
-- Ejecutar en Supabase SQL Editor
-- ============================================================

-- ──────────────────────────────────────────────────────────
-- 1. Thresholds para Arequipa XL
--    Mismos umbrales que Economy/Comfort de Arequipa.
--    Sin esto, get_distance_bracket('Arequipa','XL', any_km)
--    cae a 'very_long' para todos los viajes XL de Arequipa.
-- ──────────────────────────────────────────────────────────
INSERT INTO distance_thresholds (city, category, bracket, max_km) VALUES
  ('Arequipa', 'XL', 'very_short', 1.94),
  ('Arequipa', 'XL', 'short',      3.19),
  ('Arequipa', 'XL', 'median',     4.11),
  ('Arequipa', 'XL', 'average',    5.60),
  ('Arequipa', 'XL', 'long',       8.76),
  ('Arequipa', 'XL', 'very_long',  NULL)
ON CONFLICT (city, category, bracket) DO NOTHING;


-- ──────────────────────────────────────────────────────────
-- 2. Backfill: recalcular brackets de Arequipa XL existentes
--    Solo afecta filas con distance_km (no bot data).
-- ──────────────────────────────────────────────────────────
UPDATE pricing_observations
SET distance_bracket = get_distance_bracket(city, category, distance_km)
WHERE city = 'Arequipa'
  AND category = 'XL'
  AND distance_km IS NOT NULL;


-- ──────────────────────────────────────────────────────────
-- 3. Bracket weights para Corp
--    Faltaba en seed. Usa fallback 'all' hasta ahora,
--    pero es mejor tenerlo explícito para poder ajustarlo
--    desde el panel Config.
-- ──────────────────────────────────────────────────────────
INSERT INTO bracket_weights (city, bracket, weight) VALUES
  ('Corp', 'very_short', 0.098300),
  ('Corp', 'short',      0.196700),
  ('Corp', 'median',     0.193900),
  ('Corp', 'average',    0.138400),
  ('Corp', 'long',       0.075000),
  ('Corp', 'very_long',  0.297000)
ON CONFLICT (city, bracket) DO NOTHING;


-- ──────────────────────────────────────────────────────────
-- 4. DIAGNÓSTICO: ¿hay data Lima/Airport Premier guardada como 'Comfort'?
--    YangoPremier solo existe en categoría Premier.
--    Si aparece con category='Comfort', es data mal categorizada
--    por el bug de CATEGORY_NORMALIZE ('Premier' → 'Comfort').
-- ──────────────────────────────────────────────────────────
SELECT
  city,
  category,
  competition_name,
  COUNT(*) AS registros
FROM pricing_observations
WHERE competition_name = 'YangoPremier'
GROUP BY city, category, competition_name
ORDER BY city, category;

-- Resultado esperado: solo filas con category='Premier'.
-- Si hay filas con category='Comfort', ejecutar la corrección del paso 5.


-- ──────────────────────────────────────────────────────────
-- 5. CORRECCIÓN (ejecutar solo si paso 4 muestra category='Comfort'
--    para YangoPremier)
-- ──────────────────────────────────────────────────────────
-- UPDATE pricing_observations
-- SET    category = 'Premier'
-- WHERE  competition_name = 'YangoPremier'
--   AND  category = 'Comfort';
