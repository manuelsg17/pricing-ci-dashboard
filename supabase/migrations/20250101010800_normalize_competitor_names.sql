-- ════════════════════════════════════════════════════════════════════════
-- Migración 68 — Normalización de competition_name en pricing_observations
--
-- POR QUÉ:
--   Auditoría de mayo 2026 sobre el conteo de filas por competition_name en
--   pricing_observations (country='Peru') mostró que la ingesta histórica
--   acumuló variantes pegadas-sin-espacio en city='Corp' que el dashboard
--   no resuelve:
--
--     YangoEconomy           592      ← debería ser 'Yango Economy'
--     YangoComfort        13,069      ← legítimo en E/C, typo en Corp
--     YangoXL                595
--     CabifyLite             595
--     CabifyExtraComfort     594
--     CabifyXL               594
--     YangoPlus              102      ← AMBIGUO (hipótesis: Comfort+)
--     uber                     3      ← typo de casing
--     yango                    1      ← typo de casing
--
--   El catálogo competitorsByDbCityCategory.Corp.Corp en src/lib/constants.js
--   define los canónicos con espacios ('Yango Economy', 'Cabify Extra
--   Comfort', etc.). Cuando el bot/Excel insertó variantes pegadas, el
--   lookup en usePricingData.js:286 falló silenciosamente y el dashboard
--   muestra Corp vacío.
--
-- ESTRATEGIA:
--   Backfill data-driven en 3 UPDATEs separados, idempotentes
--   (re-ejecutables sin efecto duplicado porque cada WHERE filtra valores
--   no-canónicos):
--
--   (1) Casing universal: 'uber'→'Uber', 'yango'→'Yango'. Aplica en
--       TODA city — son typos puros de casing.
--
--   (2) Corp aliases (sub-variantes Yango/Cabify): sólo city='Corp',
--       agregando espacios. NUNCA tocar fuera de Corp — 'YangoComfort' en
--       Lima es legítimo.
--
--   (3) 'YangoPlus' → 'Yango Comfort+': SEPARADO. Hipótesis (plus = +).
--       Alternativa posible: 'Yango Premier'. 102 filas afectadas. Si
--       resulta equivocado, mig 69 puede revertir.
--
--   Comportamiento idempotente garantizado por:
--     - WHERE competition_name IN ('lista de valores no-canónicos').
--     - El RAISE NOTICE final muestra cuántas filas no-canónicas quedan;
--       segunda corrida verá 0.
--
-- VERIFICACIÓN:
--   El DO block al final cuenta filas en city='Corp' cuyo competition_name
--   NO está en la lista canónica del dashboard. Esperado: 0 (o muy pocas,
--   atribuibles a competidores no soportados).
--
-- RELACIONADO:
--   - src/lib/normalize.js → normalizeCompetitorName (fuente de verdad
--     para futuros INSERTs; esta migración limpia el histórico).
--   - supabase/functions/sync-bot-quotes/index.ts → duplica el diccionario
--     inline para Deno.
--   - scripts/test-normalize-competitor.mjs → tests JS de la normalización.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── (1) Casing universal: 'uber'→'Uber', 'yango'→'Yango' ────────────────
-- Filas afectadas según auditoría: uber=3, yango=1. Bajo riesgo.
UPDATE public.pricing_observations
SET    competition_name = CASE competition_name
                            WHEN 'uber'  THEN 'Uber'
                            WHEN 'yango' THEN 'Yango'
                            ELSE competition_name
                          END
WHERE  country = 'Peru'
  AND  competition_name IN ('uber', 'yango');

-- ── (2) Corp aliases — sub-variantes pegadas → con espacio ──────────────
-- Sólo city='Corp'. En el resto, valores como 'YangoComfort' son legítimos
-- (sub-variante Yango en categoría Economy/Comfort). Filas afectadas según
-- auditoría: ~595 c/u (Yango*) y ~594 c/u (Cabify*). Total ≈ 3,500 filas.
UPDATE public.pricing_observations
SET    competition_name = CASE competition_name
                            WHEN 'YangoEconomy'       THEN 'Yango Economy'
                            WHEN 'YangoComfort'       THEN 'Yango Comfort'
                            WHEN 'YangoXL'            THEN 'Yango XL'
                            WHEN 'CabifyLite'         THEN 'Cabify Lite'
                            WHEN 'CabifyExtraComfort' THEN 'Cabify Extra Comfort'
                            WHEN 'CabifyXL'           THEN 'Cabify XL'
                            ELSE competition_name
                          END
WHERE  country = 'Peru'
  AND  city    = 'Corp'
  AND  competition_name IN (
         'YangoEconomy',
         'YangoComfort',
         'YangoXL',
         'CabifyLite',
         'CabifyExtraComfort',
         'CabifyXL'
       );

-- ── (3) 'YangoPlus' → 'Yango Comfort+' (HIPÓTESIS) ──────────────────────
-- Separado del UPDATE (2) por riesgo: no es obvio si 'Plus' significa
-- Comfort+ o Premier en el contexto de Corp Perú. La convención de naming
-- en otras categorías (YangoComfort+, YangoPremier) sugiere que un valor
-- aparte llamado 'YangoPlus' es Comfort+ (por descarte: si fuera Premier
-- usaría 'YangoPremier'). 102 filas afectadas.
DO $$
DECLARE
  affected INT;
BEGIN
  UPDATE public.pricing_observations
  SET    competition_name = 'Yango Comfort+'
  WHERE  country = 'Peru'
    AND  city    = 'Corp'
    AND  competition_name = 'YangoPlus';

  GET DIAGNOSTICS affected = ROW_COUNT;
  RAISE NOTICE '[mig 68] (3) YangoPlus → Yango Comfort+: % filas. HIPÓTESIS — validar con product owner. Alternativa posible: Yango Premier. Revertir con UPDATE inverso si fuera necesario.', affected;
END $$;

-- ── Verificación: filas no-canónicas que quedan en Corp ─────────────────
DO $$
DECLARE
  weird_count INT;
  weird_list  TEXT;
BEGIN
  SELECT COUNT(*),
         string_agg(DISTINCT competition_name, ', ' ORDER BY competition_name)
    INTO weird_count, weird_list
    FROM public.pricing_observations
   WHERE country = 'Peru'
     AND city    = 'Corp'
     AND competition_name NOT IN (
           'Yango Economy', 'Yango Comfort', 'Yango Comfort+',
           'Yango Premier', 'Yango XL',
           'Cabify', 'Cabify Lite', 'Cabify Extra Comfort', 'Cabify XL'
         );

  IF weird_count = 0 THEN
    RAISE NOTICE '[mig 68] Verificación OK — todas las filas Corp tienen competition_name canónico.';
  ELSE
    RAISE NOTICE '[mig 68] ATENCIÓN: % filas en Corp con competition_name no-canónico. Valores: %', weird_count, weird_list;
  END IF;
END $$;

COMMIT;
