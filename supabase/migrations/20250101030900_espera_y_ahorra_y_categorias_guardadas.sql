-- ════════════════════════════════════════════════════════════════════════
-- Migración 228 — Perú: mapear 3 categorías que el bot manda y el sync
-- descarta a diario por "no_rule" (visto en dropped_combos de bot_sync_log,
-- 2026-08-30):
--
--   1. InDrive "espera y ahorra" (vc=wait_save) — Arequipa + sus 2
--      aeropuertos, ~68 filas/corrida. VISIBLE: categoría propia en el
--      dashboard de Arequipa (decisión del user 2026-08-30). NO se mezcla
--      con Economy/Comfort: es el producto barato de espera de InDrive y
--      contaminaría el promedio hacia abajo.
--   2. InDrive "viaje" (vc=comfort_plus) — Arequipa + aeropuertos. SOLO
--      SE GUARDA ("guarda viaje... y luego decido cómo compararlos").
--      Ojo: la regla 12 ya cubre ovc='viaje' pero con vc=economy (Lima);
--      en Arequipa el bot lo manda con vc=comfort_plus, y resolve_rule
--      matchea por (app, vc, ovc) — por eso se estaba descartando.
--   3. Uber "wait & save" (vc=wait_save) — Lima, ~42 filas/corrida.
--      SOLO SE GUARDA, misma decisión.
--
-- Las reglas son data-driven: el sync las recarga de bot_rules en cada
-- corrida, así que rigen desde la próxima corrida sin redeploy.
--
-- cities=[] a propósito (regla nacional): si mañana InDrive habilita
-- "espera y ahorra" en Lima, se guarda solo, sin migración nueva.
--
-- NOTA: las 3 categorías nuevas no tienen price_validation_rules, así que
-- el filtro de outliers del sync no les aplica (find_threshold → None).
-- Aceptado: primero acumular data cruda, después decidir umbrales.
--
-- VISIBILIDAD: "Espera y Ahorra" entra a country_config de Arequipa con
-- competitors=['InDrive'] únicamente — mismo patrón ya existente de la
-- categoría "Delivery" de Arequipa (solo Uber, sin Yango). "Viaje" y
-- "Wait & Save" NO entran a country_config: se acumulan invisibles hasta
-- que el user decida cómo compararlos.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Reglas del bot (idempotentes por country+app+vc+ovc) ─────────────
INSERT INTO public.bot_rules (country, app, vc, ovc, competition_name, category, cities, active)
SELECT v.country, v.app, v.vc, v.ovc, v.competition_name, v.category, '{}'::text[], true
FROM (VALUES
  ('Peru', 'indrive', 'wait_save',    'espera y ahorra', 'InDrive', 'Espera y Ahorra'),
  ('Peru', 'indrive', 'comfort_plus', 'viaje',           'InDrive', 'Viaje'),
  ('Peru', 'uber',    'wait_save',    'wait & save',     'Uber',    'Wait & Save')
) AS v(country, app, vc, ovc, competition_name, category)
WHERE NOT EXISTS (
  SELECT 1 FROM public.bot_rules b
  WHERE b.country = v.country AND b.app = v.app AND b.vc = v.vc AND b.ovc = v.ovc
);

-- ── 2. Categoría visible en Arequipa ────────────────────────────────────
UPDATE public.country_config
SET cities = (
  SELECT jsonb_agg(
    CASE WHEN c->>'dbName' = 'Arequipa'
           AND NOT EXISTS (
             SELECT 1 FROM jsonb_array_elements(c->'categories') cat
             WHERE cat->>'dbName' = 'Espera y Ahorra'
           )
      THEN jsonb_set(c, '{categories}', (c->'categories') || jsonb_build_array(
             jsonb_build_object(
               'name', 'Espera y Ahorra', 'dbName', 'Espera y Ahorra',
               'competitors', jsonb_build_array('InDrive'),
               'yangoDisplayName', 'Yango'
             )))
      ELSE c
    END
  )
  FROM jsonb_array_elements(cities) c
)
WHERE country_key = 'Peru';

-- ── 3. Verificación ─────────────────────────────────────────────────────
DO $$
DECLARE
  v_reglas int;
  v_peru_existe boolean;
  v_categoria boolean;
BEGIN
  SELECT count(*) INTO v_reglas FROM public.bot_rules
  WHERE country='Peru' AND (app, vc, ovc) IN (
    ('indrive','wait_save','espera y ahorra'),
    ('indrive','comfort_plus','viaje'),
    ('uber','wait_save','wait & save'));
  IF v_reglas <> 3 THEN
    RAISE EXCEPTION 'mig 228 ABORTADA: se esperaban 3 reglas, hay %.', v_reglas;
  END IF;

  -- En LOCAL Perú puede no existir en country_config (mismo criterio que
  -- la guarda de la mig 224): solo se exige la categoría si Perú existe.
  SELECT EXISTS (SELECT 1 FROM public.country_config WHERE country_key='Peru')
    INTO v_peru_existe;
  IF v_peru_existe THEN
    SELECT EXISTS (
      SELECT 1 FROM public.country_config cc,
                    jsonb_array_elements(cc.cities) c,
                    jsonb_array_elements(c->'categories') cat
      WHERE cc.country_key='Peru' AND c->>'dbName'='Arequipa'
        AND cat->>'dbName'='Espera y Ahorra'
    ) INTO v_categoria;
    IF NOT v_categoria THEN
      RAISE EXCEPTION 'mig 228 ABORTADA: la categoría no quedó en Arequipa.';
    END IF;
    RAISE NOTICE 'mig 228 OK — 3 reglas + categoría Espera y Ahorra en Arequipa.';
  ELSE
    RAISE NOTICE 'mig 228 OK — 3 reglas; Perú no existe en country_config de este entorno.';
  END IF;
END $$;

COMMIT;
