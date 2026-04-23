-- ============================================================================
-- Migración: Nueva nomenclatura de categorías del CI de Perú (2026-04)
--
-- Cambios:
--   Lima:     Economy+Comfort         → "Economy/Comfort"
--             Comfort (legacy)        → "Comfort+"
--             Premier                 → "Premier"        (sin cambio)
--   Trujillo: Economy                 → "Economy/Comfort"
--             Comfort                 → "Comfort+"
--   Arequipa: Economy                 → "Economy/Comfort"
--             Comfort                 → "Comfort+"
--
--   competition_name:
--     YangoPremier   → Yango   (Lima + Airport, Premier)
--     YangoComfort+  → Yango   (Trujillo + Arequipa, Comfort legacy)
--
--   dbCity:
--     "Airport" → "Lima_Airport"   (Lima era el único que usaba Airport)
--
-- Corp se mantiene EXACTAMENTE igual (no tocar filas con city='Corp').
--
-- IMPORTANTE:
--   Ejecutar primero el bloque de VERIFICACIÓN (abajo) para ver volúmenes.
--   Luego correr la MIGRACIÓN dentro de una transacción.
--   Recomendado: hacer backup / snapshot antes de ejecutar en producción.
-- ============================================================================


-- ───────────────────────── VERIFICACIÓN (read-only) ─────────────────────────
-- Revisa volúmenes afectados antes de migrar:

-- SELECT city, category, COUNT(*) AS n
-- FROM pricing_observations
-- WHERE country = 'Peru'
--   AND city <> 'Corp'
-- GROUP BY 1,2
-- ORDER BY 1,2;

-- SELECT city, competition_name, COUNT(*) AS n
-- FROM pricing_observations
-- WHERE country = 'Peru'
--   AND competition_name IN ('YangoPremier', 'YangoComfort+')
-- GROUP BY 1,2
-- ORDER BY 1,2;


-- ───────────────────────── MIGRACIÓN ────────────────────────────────────────
BEGIN;

-- 1) Renombrar competition_name legacy ANTES de renombrar categorías
UPDATE pricing_observations
SET competition_name = 'Yango'
WHERE country = 'Peru'
  AND city IN ('Lima', 'Airport')
  AND category = 'Premier'
  AND competition_name = 'YangoPremier';

UPDATE pricing_observations
SET competition_name = 'Yango'
WHERE country = 'Peru'
  AND city IN ('Trujillo', 'Arequipa')
  AND category = 'Comfort'
  AND competition_name = 'YangoComfort+';

-- 2) Renombrar categorías (excepto Corp)
UPDATE pricing_observations
SET category = 'Economy/Comfort'
WHERE country = 'Peru'
  AND city IN ('Lima', 'Trujillo', 'Arequipa', 'Airport')
  AND category = 'Economy';

UPDATE pricing_observations
SET category = 'Comfort+'
WHERE country = 'Peru'
  AND city IN ('Lima', 'Trujillo', 'Arequipa', 'Airport')
  AND category = 'Comfort';

-- Premier se queda como 'Premier' (no rename).
-- TukTuk, XL, Corp se quedan igual.

-- 3) Renombrar dbCity Airport → Lima_Airport
UPDATE pricing_observations
SET city = 'Lima_Airport'
WHERE country = 'Peru'
  AND city = 'Airport';

-- ───────────────────────── VERIFICACIÓN POST-MIGRACIÓN ───────────────────────
-- Antes de COMMIT, correr estas queries para confirmar:
--
-- SELECT city, category, COUNT(*) AS n
-- FROM pricing_observations
-- WHERE country = 'Peru'
-- GROUP BY 1,2
-- ORDER BY 1,2;
-- Esperado: solo las categorías nuevas (Economy/Comfort, Comfort+, Premier, XL, TukTuk, Corp).
-- Esperado: city ∈ (Lima, Trujillo, Arequipa, Lima_Airport, Corp) — "Airport" ya no debe existir.
--
-- SELECT COUNT(*) AS residuos_premier_viejo
-- FROM pricing_observations
-- WHERE country = 'Peru' AND competition_name IN ('YangoPremier', 'YangoComfort+');
-- Esperado: 0.

COMMIT;

-- Si algo se ve mal, ROLLBACK; en su lugar.
