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
--   1. country_config: agrega las categorías 'Delivery' y 'Cargo' a Lima,
--      con sus competidores. Sin Didi/Uber (no hay bot_rules para estas
--      categorías en esta base — ver cabecera de mig 239 sobre el mismo tema
--      en prod, donde si las hay: ahí van con ciHidden, acá no hace falta).
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
UPDATE country_config
SET cities = (
  SELECT jsonb_agg(
    CASE
      WHEN city_elem->>'uiName' = 'Lima' THEN
        jsonb_set(
          city_elem,
          '{categories}',
          (city_elem->'categories') || jsonb_build_array(
            jsonb_build_object(
              'name', 'Delivery',
              'dbName', 'Delivery',
              'competitors', jsonb_build_array('Yango', 'InDrive', 'PedidosYa', 'Rappi')
            ),
            jsonb_build_object(
              'name', 'Cargo',
              'dbName', 'Cargo',
              'competitors', jsonb_build_array('Yango', 'InDrive')
            )
          )
        )
      ELSE city_elem
    END
  )
  FROM jsonb_array_elements(cities) AS city_elem
)
WHERE country_key = 'Peru'
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(cities) ci, jsonb_array_elements(ci->'categories') ca
    WHERE ci->>'uiName' = 'Lima' AND ca->>'name' IN ('Delivery', 'Cargo')
  );

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
