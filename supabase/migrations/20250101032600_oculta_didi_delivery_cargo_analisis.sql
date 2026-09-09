-- ════════════════════════════════════════════════════════════════════════
-- Migración 245 — Ocultar Didi de Dashboard/Análisis en Delivery y Cargo (Lima)
--
-- POR QUÉ:
--   Pedido user 2026-09-09: en el Dashboard, "Didi" aparece como columna en
--   Delivery y Cargo (Lima) con TODAS las celdas en "—" — no tiene ni una
--   fila en pricing_observations. Viene de un bot_rule ACTIVO (ids 92/93,
--   country=Peru, category IN Delivery/Cargo, cities:[Lima], desde
--   2026-08-14) que ya había fusionado "Didi" en country_config.competitors
--   (mig 242/244, ver ciHidden ahí — eso solo oculta a Didi de la grilla
--   manual "Ingresar CI", el Dashboard/Rentabilidad lo siguen mostrando
--   completo vía getCompetitors(), ver src/lib/constants.js).
--
--   Decisión explícita del user: el bot_rule SIGUE ACTIVO (no se toca) — si
--   en algún momento trae data real, basta con sacar a Didi de este array
--   nuevo para que reaparezca en el análisis sin perder nada. Por ahora solo
--   se oculta de las vistas de análisis, igual criterio de "nunca borrar en
--   silencio" que ciHidden (CLAUDE.md §4), pero con SU PROPIO campo porque
--   ciHidden tiene una semántica distinta y ya probada (precedente
--   YangoComfort+ Corp, mig 145: sigue visible en Dashboard a propósito por
--   tener histórico real — mezclar los dos campos rompería ese caso).
--
-- QUÉ HACE (idempotente):
--   Agrega `analysisHidden: ["Didi"]` a Delivery y Cargo de Lima, fusionando
--   con lo que ya tenga cada categoría (sin pisar nada). Mismo patrón de
--   merge por jsonb_set + jsonb_agg(CASE...) que las migs 242/244.
--
-- CÓDIGO: getCompetitors() en src/lib/constants.js ahora filtra por
--   `analysisHiddenByDbCityCategory` (nuevo, paralelo a ciHiddenByDbCity-
--   Category) — afecta Dashboard, Rentabilidad y FilterBar. getCiCompetitors
--   (Ingresar CI) no cambia, sigue filtrando solo por ciHidden.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

DO $$
DECLARE
  v_delivery_existing jsonb;
  v_cargo_existing jsonb;
  v_delivery_new jsonb;
  v_cargo_new jsonb;
BEGIN
  SELECT ca INTO v_delivery_existing
  FROM country_config, jsonb_array_elements(cities) ci, jsonb_array_elements(ci->'categories') ca
  WHERE country_key = 'Peru' AND ci->>'uiName' = 'Lima' AND ca->>'name' = 'Delivery';

  SELECT ca INTO v_cargo_existing
  FROM country_config, jsonb_array_elements(cities) ci, jsonb_array_elements(ci->'categories') ca
  WHERE country_key = 'Peru' AND ci->>'uiName' = 'Lima' AND ca->>'name' = 'Cargo';

  IF v_delivery_existing IS NULL OR v_cargo_existing IS NULL THEN
    RAISE EXCEPTION 'mig 245: Lima no tiene Delivery y/o Cargo — ¿corrieron las mig 242/244?';
  END IF;

  v_delivery_new := v_delivery_existing || jsonb_build_object(
    'analysisHidden',
    COALESCE(v_delivery_existing->'analysisHidden', '[]'::jsonb)
      || CASE WHEN (COALESCE(v_delivery_existing->'analysisHidden', '[]'::jsonb) ? 'Didi')
              THEN '[]'::jsonb ELSE '["Didi"]'::jsonb END
  );

  v_cargo_new := v_cargo_existing || jsonb_build_object(
    'analysisHidden',
    COALESCE(v_cargo_existing->'analysisHidden', '[]'::jsonb)
      || CASE WHEN (COALESCE(v_cargo_existing->'analysisHidden', '[]'::jsonb) ? 'Didi')
              THEN '[]'::jsonb ELSE '["Didi"]'::jsonb END
  );

  UPDATE country_config
  SET cities = (
    SELECT jsonb_agg(
      CASE
        WHEN city_elem->>'uiName' = 'Lima' THEN
          jsonb_set(
            city_elem,
            '{categories}',
            (
              SELECT jsonb_agg(
                CASE
                  WHEN cat->>'name' = 'Delivery' THEN v_delivery_new
                  WHEN cat->>'name' = 'Cargo' THEN v_cargo_new
                  ELSE cat
                END
              )
              FROM jsonb_array_elements(city_elem->'categories') cat
            )
          )
        ELSE city_elem
      END
    )
    FROM jsonb_array_elements(cities) AS city_elem
  )
  WHERE country_key = 'Peru';
END $$;

-- Verificación: ambas categorías tienen "Didi" en analysisHidden. NO exige
-- que "Didi" esté en `competitors` — en local (fresh install desde
-- migraciones, sin el bot_rule corriendo) mig 242/244 nunca metieron a Didi
-- ahí porque no había nada previo que fusionar; analysisHidden con "Didi" es
-- un no-op inofensivo en ese caso (getCompetitors ya lo filtra del cruce con
-- `competitors`, así que no hay nada que ocultar). En prod sí está en
-- competitors (viene del bot_rule real) y ahí el filtro sí actúa.
DO $$
DECLARE v_del jsonb; v_car jsonb;
BEGIN
  SELECT ca INTO v_del FROM country_config, jsonb_array_elements(cities) ci, jsonb_array_elements(ci->'categories') ca
  WHERE country_key = 'Peru' AND ci->>'uiName' = 'Lima' AND ca->>'name' = 'Delivery';
  SELECT ca INTO v_car FROM country_config, jsonb_array_elements(cities) ci, jsonb_array_elements(ci->'categories') ca
  WHERE country_key = 'Peru' AND ci->>'uiName' = 'Lima' AND ca->>'name' = 'Cargo';

  IF NOT (v_del->'analysisHidden' ? 'Didi') THEN
    RAISE EXCEPTION 'mig 245: Delivery mal — analysisHidden: %', v_del;
  END IF;
  IF NOT (v_car->'analysisHidden' ? 'Didi') THEN
    RAISE EXCEPTION 'mig 245: Cargo mal — analysisHidden: %', v_car;
  END IF;
  RAISE NOTICE 'mig 245: OK — Didi marcado como oculto en análisis para Delivery y Cargo (Lima)';
END $$;

COMMIT;
