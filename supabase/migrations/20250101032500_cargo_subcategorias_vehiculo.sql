-- ════════════════════════════════════════════════════════════════════════
-- Migración 244 — Cargo: subcategorías de vehículo en vez de Yango/InDrive genéricos
--
-- POR QUÉ:
--   Pedido user 2026-09-07: Cargo no es "Yango vs InDrive" a secas — cada
--   marca tiene varios tamaños de vehículo y el hub necesita cargar el
--   precio de CADA UNO, no un promedio. Reemplaza los 2 competidores
--   genéricos de la mig 242 por 8 subcategorías (4 por marca), ordenadas de
--   más chico a más grande — ese orden en el array controla el orden de
--   columnas en la grilla.
--
--   Yango:   YangoCargoXP · YangoCargoPickup · YangoCargoM · YangoCargoXL
--   InDrive: InDriveCargoPickup · InDriveCargoVan · InDriveCargoLiviano ·
--            InDriveCargoGrande (las 4 con contraofertas, igual que
--            'InDrive' a secas en el resto de la app — ver
--            isInDriveVariant() en src/lib/constants.js)
--
--   Turnos: SIN cambios — Cargo sigue con los 3 turnos globales de
--   siempre. El turno de mediodía se carga marcando "sin oferta" (decisión
--   explícita del user para no tocar el mecanismo de turnos, que es global
--   y toca ~10 puntos de DataEntry.jsx si se hiciera por-categoría).
--
-- QUÉ HACE (idempotente):
--   REEMPLAZA por completo el array `competitors` de la categoría Cargo de
--   Lima (no lo agrega al final) — a diferencia de la mig 242, que solo
--   AGREGABA categorías nuevas. Acá el contenido de una categoría existente
--   cambia, así que un simple `jsonb_set` directo alcanza y es
--   naturalmente idempotente (fija el valor, no lo acumula).
--
-- SIN CAMBIOS en distance_thresholds/bracket_weights/distance_references:
--   son por (país, ciudad, CATEGORÍA, bracket) — no dependen de qué
--   competidores tenga la categoría. Las 12 rutas y sus umbrales de la mig
--   242 siguen valiendo tal cual.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

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
                WHEN cat->>'name' = 'Cargo' THEN
                  jsonb_set(
                    cat,
                    '{competitors}',
                    jsonb_build_array(
                      'YangoCargoXP', 'YangoCargoPickup', 'YangoCargoM', 'YangoCargoXL',
                      'InDriveCargoPickup', 'InDriveCargoVan', 'InDriveCargoLiviano', 'InDriveCargoGrande'
                    )
                  )
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
WHERE country_key = 'Peru'
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(cities) ci, jsonb_array_elements(ci->'categories') ca
    WHERE ci->>'uiName' = 'Lima' AND ca->>'name' = 'Cargo'
      -- Solo tocar si el array todavía NO es exactamente el nuevo (idempotencia
      -- explícita: re-correr esto no debe generar un UPDATE de más).
      AND ca->'competitors' <> '["YangoCargoXP","YangoCargoPickup","YangoCargoM","YangoCargoXL","InDriveCargoPickup","InDriveCargoVan","InDriveCargoLiviano","InDriveCargoGrande"]'::jsonb
  );

-- Verificación: Cargo debe tener exactamente las 8 subcategorías, en orden.
DO $$
DECLARE v_competitors jsonb;
BEGIN
  SELECT ca->'competitors' INTO v_competitors
  FROM country_config, jsonb_array_elements(cities) ci, jsonb_array_elements(ci->'categories') ca
  WHERE country_key = 'Peru' AND ci->>'uiName' = 'Lima' AND ca->>'name' = 'Cargo';

  IF v_competitors IS DISTINCT FROM
     '["YangoCargoXP","YangoCargoPickup","YangoCargoM","YangoCargoXL","InDriveCargoPickup","InDriveCargoVan","InDriveCargoLiviano","InDriveCargoGrande"]'::jsonb
  THEN
    RAISE EXCEPTION 'mig 244: Cargo.competitors no quedó como se esperaba: %', v_competitors;
  END IF;
  RAISE NOTICE 'mig 244: OK — Cargo con las 8 subcategorías en el orden correcto';
END $$;

COMMIT;
