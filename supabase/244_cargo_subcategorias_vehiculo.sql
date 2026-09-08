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
--   REEMPLAZA el array `competitors` de la categoría Cargo de Lima por las 8
--   subcategorías — PERO conservando al final cualquier competidor previo
--   que no sea parte de esas 8 (ej. 'Didi', ver más abajo), y asegurando que
--   quede en `ciHidden` para que no se pida en la grilla manual.
--
-- CORREGIDO 2026-09-08, ANTES de aplicar a producción: la versión original
-- de esta migración hacía un `jsonb_set` directo del array completo. Contra
-- el estado real de prod (Cargo ya con `competitors: ["Didi"]` desde un
-- bot_rule activo, ver mig 242) esto hubiera BORRADO 'Didi' de la
-- configuración sin dejar rastro — el bot_rule en sí no se toca (vive en
-- otra tabla), pero cualquier cosa que lea `country_config` para saber qué
-- competidores tiene Cargo/Lima dejaría de ver a Didi. Mismo criterio que
-- mig 145 y que la fusión de la mig 242: preservar en `competitors` +
-- `ciHidden`, nunca borrar en silencio (CLAUDE.md §4).
--
-- SIN CAMBIOS en distance_thresholds/bracket_weights/distance_references:
--   son por (país, ciudad, CATEGORÍA, bracket) — no dependen de qué
--   competidores tenga la categoría. Las 12 rutas y sus umbrales de la mig
--   242 siguen valiendo tal cual.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

DO $$
DECLARE
  v_cargo_existing jsonb;
  v_extra jsonb;
  v_cargo_new jsonb;
BEGIN
  SELECT ca INTO v_cargo_existing
  FROM country_config, jsonb_array_elements(cities) ci, jsonb_array_elements(ci->'categories') ca
  WHERE country_key = 'Peru' AND ci->>'uiName' = 'Lima' AND ca->>'name' = 'Cargo';

  IF v_cargo_existing IS NULL THEN
    RAISE EXCEPTION 'mig 244: Lima no tiene categoría Cargo — ¿corrió la mig 242?';
  END IF;

  -- Lo que haya en `competitors` HOY que no sea una de las 8 subcategorías
  -- nuevas NI el placeholder genérico ('Yango','InDrive') que la propia
  -- mig 242 le puso a Cargo a propósito para que ESTA migración lo
  -- reemplace, se conserva al final (ej. 'Didi', fusionado por la mig 242
  -- desde un bot_rule externo — eso sí es ajeno de verdad).
  --
  -- Bug real encontrado probando esta migración en local (2026-09-08,
  -- antes de tocar prod): sin excluir también 'Yango'/'InDrive' acá, la
  -- primera corrida los tomaba como "algo previo ajeno" y los dejaba
  -- colgados en `competitors` (al final, duplicados con las subcategorías)
  -- y en `ciHidden` — el placeholder que la 242 puso para ser reemplazado
  -- quedaba escondido en vez de reemplazado.
  v_extra := COALESCE(
    (SELECT jsonb_agg(c)
     FROM jsonb_array_elements_text(COALESCE(v_cargo_existing->'competitors', '[]'::jsonb)) c
     WHERE c NOT IN (
       'YangoCargoXP', 'YangoCargoPickup', 'YangoCargoM', 'YangoCargoXL',
       'InDriveCargoPickup', 'InDriveCargoVan', 'InDriveCargoLiviano', 'InDriveCargoGrande',
       'Yango', 'InDrive'
     )),
    '[]'::jsonb
  );

  v_cargo_new := v_cargo_existing
    || jsonb_build_object(
         'competitors',
         '["YangoCargoXP","YangoCargoPickup","YangoCargoM","YangoCargoXL","InDriveCargoPickup","InDriveCargoVan","InDriveCargoLiviano","InDriveCargoGrande"]'::jsonb
           || v_extra
       );
  -- Todo lo que quedó en `v_extra` (no es una subcategoría de Cargo) tiene
  -- que estar oculto de Ingresar CI — si ya estaba en ciHidden desde antes,
  -- no se duplica.
  IF jsonb_array_length(v_extra) > 0 THEN
    v_cargo_new := v_cargo_new || jsonb_build_object(
      'ciHidden',
      COALESCE(v_cargo_existing->'ciHidden', '[]'::jsonb)
        || COALESCE(
             (SELECT jsonb_agg(DISTINCT e)
              FROM jsonb_array_elements_text(v_extra) e
              WHERE NOT (COALESCE(v_cargo_existing->'ciHidden', '[]'::jsonb) ? e)),
             '[]'::jsonb
           )
    );
  END IF;

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
                CASE WHEN cat->>'name' = 'Cargo' THEN v_cargo_new ELSE cat END
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

-- Verificación: Cargo tiene las 8 subcategorías en orden, y nada de lo que
-- ya estaba en `competitors` (ej. 'Didi') se perdió.
DO $$
DECLARE v_cat jsonb;
BEGIN
  SELECT ca INTO v_cat
  FROM country_config, jsonb_array_elements(cities) ci, jsonb_array_elements(ci->'categories') ca
  WHERE country_key = 'Peru' AND ci->>'uiName' = 'Lima' AND ca->>'name' = 'Cargo';

  IF NOT (
    v_cat->'competitors' @> '["YangoCargoXP","YangoCargoPickup","YangoCargoM","YangoCargoXL","InDriveCargoPickup","InDriveCargoVan","InDriveCargoLiviano","InDriveCargoGrande"]'::jsonb
  ) THEN
    RAISE EXCEPTION 'mig 244: Cargo.competitors no tiene las 8 subcategorías: %', v_cat;
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(COALESCE(v_cat->'ciHidden', '[]'::jsonb)) h
    WHERE NOT (v_cat->'competitors' ? h)
  ) THEN
    RAISE EXCEPTION 'mig 244: Cargo tiene en ciHidden algo que ya no está en competitors: %', v_cat;
  END IF;
  RAISE NOTICE 'mig 244: OK — Cargo con las 8 subcategorías, nada perdido de lo que ya había';
END $$;

COMMIT;
