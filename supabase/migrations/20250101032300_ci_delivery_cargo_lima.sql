-- ════════════════════════════════════════════════════════════════════════
-- Migración 242 — CI de Delivery y Cargo en Lima
--
-- POR QUÉ:
--   El user pidió mapear Delivery y Cargo en Lima (competidores: Yango,
--   InDrive, PedidosYa, Rappi para Delivery; Yango, InDrive para Cargo),
--   cargado por los hubs en Ingresar CI. Ver docs/ci-delivery-cargo-plan.md
--   para el diseño completo — acá solo la parte de datos.
--
-- DISEÑO (mismo criterio que TukTuk, no un país/ciudad nuevo):
--   Delivery y Cargo son categorías MÁS de Lima (city='Lima' en
--   pricing_observations), no una ciudad separada — igual que Economy/Comfort
--   o Premier ya conviven bajo Lima. El aislamiento de la pestaña en Ingresar
--   CI (marca de agua de guardado propia, sin pisar "Lima Normal") lo da el
--   campo `zone` del lado del cliente (ver src/lib/dataEntry/keys.js), no
--   una ciudad nueva — así el resto de la app (Dashboard, Competitividad,
--   RawData) sigue viendo "Lima" con una categoría más, sin ensuciar ningún
--   selector de ciudad con una entrada sin sentido fuera de Ingresar CI.
--
-- QUÉ HACE (todo idempotente, seguro de re-correr):
--   1. country_config: agrega o FUSIONA las categorías 'Delivery' y 'Cargo'
--      en Lima con sus competidores. CORREGIDO 2026-09-08 antes de aplicar a
--      producción: Lima ya tenía las dos categorías con `competitors:
--      ["Didi"]` (bot_rule activo desde 2026-08-14, sin observaciones hasta
--      hoy) — ver el bloque §1 para el detalle completo de la fusión y por
--      qué usa `ciHidden` (mismo mecanismo de mig 145) en vez de pisar.
--   2. distance_thresholds: 2/4/6/8/10/∞ km para Lima/Delivery y Lima/Cargo
--      — nuevo, no existía. Sin esto TODAS las rutas caerían en 'very_long'.
--   3. bracket_weights: 1/6 cada bracket para Lima/Delivery y Lima/Cargo.
--      Los pesos de Lima 'all' (very_long=28.5%) están calibrados para la
--      distribución real de viajes de ride-hailing — aplicados a una malla
--      UNIFORME de 12 rutas (1 a 12 km) distorsionarían el promedio. Ajustar
--      más adelante con distribución real de pedidos (ver plan, §1).
--   4. distance_references: 24 filas (12 rutas × 2 categorías, mismo
--      contenido hoy — EN TABLAS SEPARADAS por diseño: category discrimina,
--      así que ya serían independientes aunque hoy compartan destino/km).
--      Origen: Vía Principal 129, San Isidro. 2 rutas por bracket (ver
--      mapeo km→bracket abajo, exactamente lo que dan los umbrales del
--      punto 2).
--
-- PENDIENTE (documentado en docs/ci-delivery-cargo-plan.md §6, NO acá):
--   Curva de precio por distancia y ranking "quién es más barato por km" en
--   el dashboard — se retoman con 2-3 semanas de datos reales, no ahora.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. country_config: categorías Delivery/Cargo en Lima ──────────────────
-- Cada categoría se agrega de forma INDEPENDIENTE (revisión adversarial
-- 2026-09-07): el guard original saltaba el UPDATE completo si CUALQUIERA de
-- las dos ya existía, así que un estado a medias (alguien agregó Delivery a
-- mano pero no Cargo) quedaba así para siempre al re-correr la migración.
--
-- REVISADO 2026-09-08, ANTES de aplicar a PRODUCCIÓN: Lima YA tenía
-- 'Delivery' y 'Cargo' en prod, cada una con `competitors: ["Didi"]` — un
-- bot_rule activo desde 2026-08-14 (Didi en Cargo/Delivery Lima, 0
-- observaciones hasta hoy) que esta migración no conocía porque local nunca
-- tuvo ese bot_rule. La primera versión de esta migración solo agregaba la
-- categoría si NO EXISTÍA — con Lima ya teniendo las dos, el UPDATE entero
-- no disparaba (el guard exige que falte alguna) y 'Didi' se hubiera quedado
-- como único competidor de Ingresar CI, sin Yango/InDrive/etc.
--
-- Fix: si la categoría YA EXISTE, se FUSIONA — los competidores nuevos van
-- primero (controla el orden de columnas en Ingresar CI), y cualquier
-- competidor que ya estuviera y no sea parte de la lista pensada para CI
-- (acá, 'Didi') se conserva en el array `competitors` pero se agrega a
-- `ciHidden` — mismo mecanismo ya usado en mig 145 (ojo 👁) para no perder
-- data histórica/de otro camino de ingesta (CLAUDE.md §4): sigue disponible
-- para el dashboard/histórico, solo se deja de pedir en la grilla manual.
-- Si la categoría NO existe (caso local, o un país nuevo el día de mañana),
-- se crea con la lista pensada para CI y sin ciHidden — no hay nada que
-- ocultar.
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

  -- Delivery: 'Yango','InDrive','PedidosYa','Rappi' primero, después
  -- cualquier competidor previo que no sea parte de esa lista (ej. 'Didi').
  v_delivery_new := COALESCE(v_delivery_existing, '{}'::jsonb)
    || jsonb_build_object('name', 'Delivery', 'dbName', 'Delivery')
    || jsonb_build_object(
         'competitors',
         '["Yango","InDrive","PedidosYa","Rappi"]'::jsonb
           || COALESCE(
                (SELECT jsonb_agg(c)
                 FROM jsonb_array_elements_text(COALESCE(v_delivery_existing->'competitors', '[]'::jsonb)) c
                 WHERE c NOT IN ('Yango', 'InDrive', 'PedidosYa', 'Rappi')),
                '[]'::jsonb
              )
       );
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(COALESCE(v_delivery_existing->'competitors', '[]'::jsonb)) c
    WHERE c NOT IN ('Yango', 'InDrive', 'PedidosYa', 'Rappi')
  ) THEN
    v_delivery_new := v_delivery_new || jsonb_build_object(
      'ciHidden',
      COALESCE(v_delivery_existing->'ciHidden', '[]'::jsonb)
        || COALESCE(
             (SELECT jsonb_agg(DISTINCT c)
              FROM jsonb_array_elements_text(v_delivery_existing->'competitors') c
              WHERE c NOT IN ('Yango', 'InDrive', 'PedidosYa', 'Rappi')
                AND NOT (COALESCE(v_delivery_existing->'ciHidden', '[]'::jsonb) ? c)),
             '[]'::jsonb
           )
    );
  END IF;

  -- Cargo: mismo criterio, con 'Yango','InDrive' — la mig 244 reemplaza esta
  -- lista genérica por las 8 subcategorías de vehículo más adelante, y
  -- también respeta lo que haya quedado en `competitors`/`ciHidden` acá.
  --
  -- GUARD DE IDEMPOTENCIA (bug real encontrado probando en local,
  -- 2026-09-08): si esta migración se vuelve a correr DESPUÉS de que la
  -- mig 244 ya transformó Cargo a las 8 subcategorías, el código de abajo
  -- —que solo conoce 'Yango'/'InDrive' como "lo esperado"— tomaba las 8
  -- subcategorías como "competidores ajenos" y las escondía TODAS en
  -- `ciHidden`, dejando Cargo sin columnas visibles en Ingresar CI. Si
  -- Cargo YA tiene las 8 subcategorías, esta migración no le toca ni
  -- `competitors` ni `ciHidden` — es tarea de la mig 244, no de esta.
  IF v_cargo_existing IS NOT NULL AND (
    v_cargo_existing->'competitors' @> '[
      "YangoCargoXP", "YangoCargoPickup", "YangoCargoM", "YangoCargoXL",
      "InDriveCargoPickup", "InDriveCargoVan", "InDriveCargoLiviano", "InDriveCargoGrande"
    ]'::jsonb
  ) THEN
    v_cargo_new := v_cargo_existing;
  ELSE
    v_cargo_new := COALESCE(v_cargo_existing, '{}'::jsonb)
      || jsonb_build_object('name', 'Cargo', 'dbName', 'Cargo')
      || jsonb_build_object(
           'competitors',
           '["Yango","InDrive"]'::jsonb
             || COALESCE(
                  (SELECT jsonb_agg(c)
                   FROM jsonb_array_elements_text(COALESCE(v_cargo_existing->'competitors', '[]'::jsonb)) c
                   WHERE c NOT IN ('Yango', 'InDrive')),
                  '[]'::jsonb
                )
         );
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(COALESCE(v_cargo_existing->'competitors', '[]'::jsonb)) c
      WHERE c NOT IN ('Yango', 'InDrive')
    ) THEN
      v_cargo_new := v_cargo_new || jsonb_build_object(
        'ciHidden',
        COALESCE(v_cargo_existing->'ciHidden', '[]'::jsonb)
          || COALESCE(
               (SELECT jsonb_agg(DISTINCT c)
                FROM jsonb_array_elements_text(v_cargo_existing->'competitors') c
                WHERE c NOT IN ('Yango', 'InDrive')
                  AND NOT (COALESCE(v_cargo_existing->'ciHidden', '[]'::jsonb) ? c)),
               '[]'::jsonb
             )
      );
    END IF;
  END IF;

  -- Reemplaza Delivery/Cargo por sus versiones fusionadas (o las agrega si
  -- no existían) — el resto de las categorías de Lima queda intacto, y el
  -- resto de los países/ciudades ni se toca.
  UPDATE country_config
  SET cities = (
    SELECT jsonb_agg(
      CASE
        WHEN city_elem->>'uiName' = 'Lima' THEN
          jsonb_set(
            city_elem,
            '{categories}',
            (
              SELECT jsonb_agg(cat)
              FROM (
                SELECT cat
                FROM jsonb_array_elements(city_elem->'categories') cat
                WHERE cat->>'name' NOT IN ('Delivery', 'Cargo')
                UNION ALL
                SELECT v_delivery_new
                UNION ALL
                SELECT v_cargo_new
              ) merged(cat)
            )
          )
        ELSE city_elem
      END
    )
    FROM jsonb_array_elements(cities) AS city_elem
  )
  WHERE country_key = 'Peru';
END $$;

-- Verificación §1: Delivery/Cargo tienen los competidores pensados para CI,
-- y si había algo más (ej. 'Didi') sigue en `competitors` pero pasó a
-- `ciHidden` — nunca desaparece del todo.
DO $$
DECLARE v_cat jsonb;
BEGIN
  FOR v_cat IN
    SELECT ca
    FROM country_config, jsonb_array_elements(cities) ci, jsonb_array_elements(ci->'categories') ca
    WHERE country_key = 'Peru' AND ci->>'uiName' = 'Lima' AND ca->>'name' IN ('Delivery', 'Cargo')
  LOOP
    IF v_cat->>'name' = 'Delivery'
       AND NOT (v_cat->'competitors' ?& array['Yango', 'InDrive', 'PedidosYa', 'Rappi']) THEN
      RAISE EXCEPTION 'mig 242: Delivery quedó sin los competidores de CI: %', v_cat;
    END IF;
    -- Cargo: 'Yango'/'InDrive' es el estado GENÉRICO que deja esta migración
    -- — si la mig 244 ya corrió antes (re-ejecución fuera de orden), Cargo
    -- tiene las 8 subcategorías y ya no contiene esos dos literales; el
    -- guard de idempotencia de arriba lo deja intacto a propósito, así que
    -- acá no corresponde exigirlos.
    IF v_cat->>'name' = 'Cargo'
       AND NOT (v_cat->'competitors' ?& array['Yango', 'InDrive'])
       AND NOT (v_cat->'competitors' @> '[
             "YangoCargoXP", "YangoCargoPickup", "YangoCargoM", "YangoCargoXL",
             "InDriveCargoPickup", "InDriveCargoVan", "InDriveCargoLiviano", "InDriveCargoGrande"
           ]'::jsonb) THEN
      RAISE EXCEPTION 'mig 242: Cargo quedó sin los competidores de CI: %', v_cat;
    END IF;
    -- Ningún competidor que ya estuviera antes se puede haber perdido: todo
    -- lo que no entró a `ciHidden` tiene que seguir en `competitors`.
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(COALESCE(v_cat->'ciHidden', '[]'::jsonb)) h
      WHERE NOT (v_cat->'competitors' ? h)
    ) THEN
      RAISE EXCEPTION 'mig 242: % tiene en ciHidden algo que no está en competitors: %',
        v_cat->>'name', v_cat;
    END IF;
  END LOOP;
  RAISE NOTICE 'mig 242: OK — Delivery/Cargo fusionados sin perder competidores previos';
END $$;

-- ── 2. distance_thresholds — 2/4/6/8/10/∞ km ───────────────────────────────
INSERT INTO distance_thresholds (country, city, category, bracket, max_km)
SELECT 'Peru', 'Lima', cat, bracket, max_km
FROM (VALUES ('Delivery'), ('Cargo')) AS c(cat)
CROSS JOIN (VALUES
  ('very_short', 2::numeric),
  ('short',      4),
  ('median',     6),
  ('average',    8),
  ('long',       10),
  ('very_long',  NULL)
) AS b(bracket, max_km)
ON CONFLICT (country, city, category, bracket) DO UPDATE SET max_km = EXCLUDED.max_km;

-- ── 3. bracket_weights — 1/6 cada bracket ──────────────────────────────────
INSERT INTO bracket_weights (country, city, category, bracket, weight)
SELECT 'Peru', 'Lima', cat, bracket, 1.0 / 6
FROM (VALUES ('Delivery'), ('Cargo')) AS c(cat)
CROSS JOIN (VALUES
  ('very_short'), ('short'), ('median'), ('average'), ('long'), ('very_long')
) AS b(bracket)
ON CONFLICT (country, city, category, bracket) DO UPDATE SET weight = EXCLUDED.weight;

-- ── 4. distance_references — 12 rutas × 2 categorías ───────────────────────
-- point_a fijo (Vía Principal 129, San Isidro); km exacto → bracket, tal
-- como quedan definidos los umbrales del punto 2 (2 rutas por bracket).
INSERT INTO distance_references (country, city, category, bracket, point_a, point_b, waze_distance, zone, updated_by)
SELECT 'Peru', 'Lima', cat, r.bracket, 'Vía Principal 129, San Isidro', r.point_b, r.km, NULL, 'mig_242'
FROM (VALUES ('Delivery'), ('Cargo')) AS c(cat)
CROSS JOIN (VALUES
  (1,  'very_short', 'Av. Los Conquistadores 502-566, San Isidro 15073, Perú'),
  (2,  'very_short', 'Av. Dos de Mayo 1889, San Isidro 15076, Perú'),
  (3,  'short',      'C. Ricardo Angulo 1291, San Isidro 15036, Perú'),
  (4,  'short',      'Ca. Narciso de la Colina 703, Lima 15047, Perú'),
  (5,  'median',     'Jirón Cabo Nicolás Gutarra 838-851, Pueblo Libre 15084, Perú'),
  (6,  'median',     'Jr. Irma Gamero de Planas, Santiago de Surco 15048, Perú'),
  (7,  'average',    'Museo Larco, Av. Simón Bolívar 1515, Pueblo Libre 15084, Perú'),
  (8,  'average',    'Esmeralda 558, Lima 15037, Perú'),
  (9,  'long',       'Doña Amalia 198-290, Santiago de Surco 15049, Perú'),
  (10, 'long',       'Plaza Vea Bolichera, Av. Santiago de Surco 5000, Santiago de Surco 15054, Perú'),
  (11, 'very_long',  'Av. Javier Prado Este 6420, La Molina 15024, Perú'),
  (12, 'very_long',  'Colegio América del Callao, Jr. Nicolás de Piérola, Bellavista 07016, Perú')
) AS r(km, bracket, point_b)
WHERE NOT EXISTS (
  SELECT 1 FROM distance_references dr
  WHERE dr.country = 'Peru' AND dr.city = 'Lima' AND dr.category = c.cat
    AND dr.point_a = 'Vía Principal 129, San Isidro' AND dr.point_b = r.point_b
);

-- Verificación: 2 rutas por bracket en cada categoría.
DO $$
DECLARE v int;
BEGIN
  SELECT count(*) INTO v FROM (
    SELECT category, bracket, count(*) n
    FROM distance_references
    WHERE country = 'Peru' AND city = 'Lima' AND category IN ('Delivery', 'Cargo')
    GROUP BY category, bracket
    HAVING count(*) != 2
  ) x;
  IF v > 0 THEN RAISE EXCEPTION 'mig 242: % brackets sin exactamente 2 rutas', v; END IF;
  RAISE NOTICE 'mig 242: OK — 2 rutas por bracket en Delivery y Cargo';
END $$;

COMMIT;
