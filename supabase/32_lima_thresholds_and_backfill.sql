-- ============================================================
-- MIGRACIÓN 32: Alinear umbrales de Lima con configuración UI + backfill
-- ============================================================
-- Problema: la migración 30 insertó umbrales basados en los valores
-- viejos del seed (Economy/Comfort long=15 km). El usuario configuró
-- umbrales más finos en el panel Config (long=6.2 km) pero esos valores
-- no se reflejan en los datos porque el UPDATE del backfill usó los
-- umbrales viejos o el save del UI nunca llegó a la BD.
--
-- Esta migración:
-- 1. Muestra los umbrales actuales (diagnóstico)
-- 2. Reemplaza los umbrales de Lima Economy/Comfort, Comfort+, Premier
--    con la configuración deseada (1.2, 2.5, 4.6, 5.0, 6.2, ∞)
-- 3. Re-clasifica TODAS las filas de Lima (excepto Corp) con
--    get_distance_bracket usando los nuevos umbrales.
--
-- IMPORTANTE: ejecuta la query de diagnóstico PRIMERO, antes del BEGIN,
-- para confirmar qué hay en la BD ahora. Si ya estaba correcto para
-- Premier, solo Economy/Comfort y Comfort+ necesitan el cambio.
-- ============================================================

-- ── 0. Diagnóstico previo (ejecutar ANTES del BEGIN) ────────
--
-- SELECT country, city, category, bracket, max_km
-- FROM distance_thresholds
-- WHERE country = 'Peru' AND city = 'Lima'
--   AND category IN ('Economy/Comfort', 'Comfort+', 'Premier')
-- ORDER BY category, COALESCE(max_km, 999);


BEGIN;

-- ── 1. Limpiar Lima: Economy/Comfort, Comfort+, Premier ─────

DELETE FROM distance_thresholds
WHERE country = 'Peru'
  AND city = 'Lima'
  AND category IN ('Economy/Comfort', 'Comfort+', 'Premier');


-- ── 2. Insertar umbrales deseados ───────────────────────────
-- Mismos valores para las 3 categorías (según panel Config).

INSERT INTO distance_thresholds (country, city, category, bracket, max_km) VALUES
  -- Economy/Comfort
  ('Peru', 'Lima', 'Economy/Comfort', 'very_short', 1.2),
  ('Peru', 'Lima', 'Economy/Comfort', 'short',       2.5),
  ('Peru', 'Lima', 'Economy/Comfort', 'median',      4.6),
  ('Peru', 'Lima', 'Economy/Comfort', 'average',     5.0),
  ('Peru', 'Lima', 'Economy/Comfort', 'long',        6.2),
  ('Peru', 'Lima', 'Economy/Comfort', 'very_long',   NULL),

  -- Comfort+
  ('Peru', 'Lima', 'Comfort+',        'very_short', 1.2),
  ('Peru', 'Lima', 'Comfort+',        'short',       2.5),
  ('Peru', 'Lima', 'Comfort+',        'median',      4.6),
  ('Peru', 'Lima', 'Comfort+',        'average',     5.0),
  ('Peru', 'Lima', 'Comfort+',        'long',        6.2),
  ('Peru', 'Lima', 'Comfort+',        'very_long',   NULL),

  -- Premier
  ('Peru', 'Lima', 'Premier',         'very_short', 1.2),
  ('Peru', 'Lima', 'Premier',         'short',       2.5),
  ('Peru', 'Lima', 'Premier',         'median',      4.6),
  ('Peru', 'Lima', 'Premier',         'average',     5.0),
  ('Peru', 'Lima', 'Premier',         'long',        6.2),
  ('Peru', 'Lima', 'Premier',         'very_long',   NULL);


-- ── 3. Backfill: re-clasificar TODAS las filas de Lima ──────
-- Aplica a Economy/Comfort, Comfort+, Premier (y otras si existieran).
-- Excluye Corp (no tiene umbrales de distancia).

UPDATE pricing_observations
SET distance_bracket = get_distance_bracket(city, category, distance_km)
WHERE country = 'Peru'
  AND city = 'Lima'
  AND category IN ('Economy/Comfort', 'Comfort+', 'Premier')
  AND distance_km IS NOT NULL;


COMMIT;


-- ── 4. Verificación ─────────────────────────────────────────

-- 4a. Umbrales quedaron así:
SELECT city, category, bracket, max_km
FROM distance_thresholds
WHERE country = 'Peru' AND city = 'Lima'
  AND category IN ('Economy/Comfort', 'Comfort+', 'Premier')
ORDER BY category, COALESCE(max_km, 999);

-- 4b. Distribución de rutas por bracket tras el backfill:
SELECT
  category,
  distance_bracket,
  COUNT(*) AS filas,
  ROUND(MIN(distance_km)::numeric, 2) AS min_km,
  ROUND(MAX(distance_km)::numeric, 2) AS max_km
FROM pricing_observations
WHERE country = 'Peru'
  AND city = 'Lima'
  AND category IN ('Economy/Comfort', 'Comfort+', 'Premier')
  AND distance_km IS NOT NULL
  AND year = 2026 AND week IN (15, 16, 17)
GROUP BY category, distance_bracket
ORDER BY category, MIN(distance_km);
