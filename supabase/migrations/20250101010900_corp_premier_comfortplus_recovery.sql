-- ════════════════════════════════════════════════════════════════════════
-- Migración 69 — Limpieza de filas Corp "Yango" aplastadas (Premier+Comfort+)
--
-- POR QUÉ:
--   El diccionario COMPETITOR_NORMALIZE en src/algorithms/ingestionFilters.js
--   y src/pages/Upload.jsx tenía estos mapeos:
--     'YangoPremier'   → 'Yango'
--     'YangoComfort+'  → 'Yango'
--   Diseñados para Lima Economy/Comfort (donde Premier/Comfort+ NO son
--   competidores separados sino sub-variantes que se agregan al WA de
--   Yango). En **Corp** Premier y Comfort+ son competidores LEGÍTIMOS
--   separados. El aplastado los convertía a 'Yango' anónimo.
--
--   Resultado en producción (auditoría 2026-05-18):
--     competition_name = 'Yango' en (country='Peru', city='Corp') → 1190 filas
--                                  ≈ 595 (Premier) + 595 (Comfort+)
--     'Yango Premier'   → 0 filas
--     'Yango Comfort+'  → 102 (sólo las que vinieron de YangoPlus, mig 68)
--
-- QUE HACE ESTA MIGRACIÓN:
--   DELETE de las 1190 filas con competition_name='Yango' en city='Corp'.
--   NO podemos recuperar la distinción Premier/Comfort+ desde la DB porque
--   el aplastado fue lossless — el admin debe RE-SUBIR el Excel original
--   con el fix de código ya aplicado (commit que acompaña a esta mig).
--
--   Las 102 filas 'Yango Comfort+' (de YangoPlus) NO se tocan — fueron
--   verificadas por rango de precios (~7-10 S/) consistente con Comfort+,
--   no con Premier (~25-30 S/).
--
-- PRE-REQUISITO ANTES DE APLICAR:
--   El commit con el fix de COMPETITOR_NORMALIZE debe estar deployed. Si
--   re-subís el Excel antes del fix, vuelven a aplastarse a 'Yango'.
--
-- COMO RECUPERAR LAS FILAS:
--   1. Aplicar esta migración (BORRA 1190 filas).
--   2. Verificar que la versión del frontend incluye el commit con el fix
--      (COMPETITOR_CASING_FIXES vs COMPETITOR_YANGO_MASTER_FLATTEN).
--   3. Volver a subir el Excel original desde "Gestión de Datos → Cargar".
--      Tus 595 Premier y 595 Comfort+ ahora entran como 'Yango Premier'
--      y 'Yango Comfort+' canónicos.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- Pre-check: contar antes de borrar
DO $audit$
DECLARE
  v_count int;
  v_sum_prices numeric;
BEGIN
  SELECT COUNT(*), COALESCE(SUM(COALESCE(price_without_discount, recommended_price, 0)), 0)
    INTO v_count, v_sum_prices
    FROM pricing_observations
   WHERE country='Peru' AND city='Corp' AND competition_name='Yango';
  RAISE NOTICE '[mig 69] PRE-DELETE: % filas Corp "Yango" detectadas (suma precios=%).', v_count, v_sum_prices;
  IF v_count = 0 THEN
    RAISE NOTICE '[mig 69] Nada que borrar — la migración ya se aplicó antes o el aplastado nunca ocurrió.';
  END IF;
END
$audit$;

-- Borrar las filas aplastadas. Sólo Corp + Yango — nunca filas de E/C
-- (Lima/Trujillo/Arequipa) donde 'Yango' SÍ es el nombre canónico legítimo.
DELETE FROM pricing_observations
WHERE country='Peru'
  AND city='Corp'
  AND competition_name='Yango';

-- Post-check
DO $verify$
DECLARE
  v_remaining int;
  v_competitors text;
BEGIN
  SELECT COUNT(*) INTO v_remaining
    FROM pricing_observations
   WHERE country='Peru' AND city='Corp' AND competition_name='Yango';

  IF v_remaining > 0 THEN
    RAISE WARNING '[mig 69] Quedan % filas Corp "Yango" — el DELETE no las cubrió.', v_remaining;
  END IF;

  SELECT string_agg(DISTINCT competition_name, ', ' ORDER BY competition_name)
    INTO v_competitors
    FROM pricing_observations
   WHERE country='Peru' AND city='Corp';
  RAISE NOTICE '[mig 69] Competidores Corp tras DELETE: %', v_competitors;
  RAISE NOTICE '[mig 69] Re-subir Excel desde Gestión > Cargar Data para recuperar Premier y Comfort+ correctos.';
END
$verify$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN POST-APLICACIÓN
--
-- 1. Confirmar que ya no hay filas "Yango" en Corp:
--    SELECT COUNT(*) FROM pricing_observations
--    WHERE country='Peru' AND city='Corp' AND competition_name='Yango';
--    → debe devolver 0.
--
-- 2. Re-subir el Excel original (Gestión > Cargar Data > seleccionar archivo).
--
-- 3. Confirmar que ahora aparecen Premier y Comfort+:
--    SELECT competition_name, COUNT(*) AS n
--    FROM pricing_observations
--    WHERE country='Peru' AND city='Corp'
--    GROUP BY competition_name
--    ORDER BY n DESC;
--    → debe incluir 'Yango Premier' y 'Yango Comfort+' con conteo > 100.
-- ════════════════════════════════════════════════════════════════════════
