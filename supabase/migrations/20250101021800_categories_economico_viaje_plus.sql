-- ════════════════════════════════════════════════════════════════════════
-- Migración 137 — Categorías nuevas: Económico+ (Arequipa) y Viaje+ (Trujillo)
--
-- CONTEXTO 2026-07-20:
--   Se agrega un tier intermedio "superior al económico pero inferior al
--   comfort":
--     · Arequipa → "Económico+"
--     · Trujillo → "Viaje+"
--   Por ahora SOLO en los aeropuertos (Airport_A y Airport_B) de cada ciudad
--   — el CI normal queda para después (Trujillo normal hoy no tiene rutas
--   base que copiar). Competidores = mismo set que Comfort+ (Yango, Uber,
--   InDrive, Cabify). Se copian las 6 rutas (una por bracket) de
--   Economy/Comfort de cada aeropuerto, cambiando solo la categoría.
--
-- QUÉ HACE:
--   A) Copia las rutas Economy/Comfort → la categoría nueva en los 4
--      aeropuertos (idempotente: NOT EXISTS por ciudad+bracket).
--   B) Agrega la categoría al config (country_config.cities jsonb) justo
--      después de Economy/Comfort, solo en esos 4 aeropuertos (idempotente:
--      no la duplica si ya está). El resto de las ciudades queda intacto.
--
-- NOTA (cache de config): CountryContext refetchea country_config en cada
-- carga (el cache de localStorage solo cubre el primer render y se pisa con
-- el fetch fresco), así que la categoría aparece en la próxima recarga sin
-- necesidad de bumpear CACHE_VERSION.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── (A) Copiar rutas Economy/Comfort → categoría nueva (aeropuertos) ────

-- Arequipa airports → Económico+
INSERT INTO distance_references
  (country, city, category, bracket, point_a, coordinate_a, point_b, coordinate_b, waze_distance, zone, updated_by)
SELECT src.country, src.city, 'Económico+', src.bracket, src.point_a, src.coordinate_a,
       src.point_b, src.coordinate_b, src.waze_distance, src.zone, 'auto-copy mig137'
FROM distance_references src
WHERE src.country = 'Peru'
  AND src.city IN ('Arequipa_Airport_A', 'Arequipa_Airport_B')
  AND src.category = 'Economy/Comfort'
  AND NOT EXISTS (
    SELECT 1 FROM distance_references d
    WHERE d.country = 'Peru' AND d.city = src.city
      AND d.category = 'Económico+' AND d.bracket = src.bracket
  );

-- Trujillo airports → Viaje+
INSERT INTO distance_references
  (country, city, category, bracket, point_a, coordinate_a, point_b, coordinate_b, waze_distance, zone, updated_by)
SELECT src.country, src.city, 'Viaje+', src.bracket, src.point_a, src.coordinate_a,
       src.point_b, src.coordinate_b, src.waze_distance, src.zone, 'auto-copy mig137'
FROM distance_references src
WHERE src.country = 'Peru'
  AND src.city IN ('Trujillo_Airport_A', 'Trujillo_Airport_B')
  AND src.category = 'Economy/Comfort'
  AND NOT EXISTS (
    SELECT 1 FROM distance_references d
    WHERE d.country = 'Peru' AND d.city = src.city
      AND d.category = 'Viaje+' AND d.bracket = src.bracket
  );

-- ── (B) Agregar la categoría al config (country_config.cities) ──────────
-- Se inserta después de Economy/Comfort (índice 0) y antes de Comfort+.
-- Idempotente: si la categoría ya existe en esa ciudad, la deja igual.
UPDATE country_config cc
SET cities = sub.new_cities,
    updated_at = now()
FROM (
  SELECT jsonb_agg(
    CASE
      WHEN c->>'uiName' IN ('Arequipa_Airport_A', 'Arequipa_Airport_B')
           AND NOT (c->'categories' @> '[{"name":"Económico+"}]'::jsonb)
        THEN jsonb_set(c, '{categories}',
               jsonb_build_array(
                 (c->'categories')->0,
                 '{"name":"Económico+","dbName":"Económico+","competitors":["Yango","Uber","InDrive","Cabify"],"yangoDisplayName":"Yango"}'::jsonb
               ) || ((c->'categories') - 0))
      WHEN c->>'uiName' IN ('Trujillo_Airport_A', 'Trujillo_Airport_B')
           AND NOT (c->'categories' @> '[{"name":"Viaje+"}]'::jsonb)
        THEN jsonb_set(c, '{categories}',
               jsonb_build_array(
                 (c->'categories')->0,
                 '{"name":"Viaje+","dbName":"Viaje+","competitors":["Yango","Uber","InDrive","Cabify"],"yangoDisplayName":"Yango"}'::jsonb
               ) || ((c->'categories') - 0))
      ELSE c
    END
    ORDER BY ord
  ) AS new_cities
  FROM country_config cc2, LATERAL jsonb_array_elements(cc2.cities) WITH ORDINALITY AS t(c, ord)
  WHERE cc2.country_key = 'Peru'
) sub
WHERE cc.country_key = 'Peru';

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
--   SELECT city, category, count(*) FROM distance_references
--   WHERE country='Peru' AND category IN ('Económico+','Viaje+')
--   GROUP BY city, category;  -- 4 filas × 6 = 24 rutas
--
--   SELECT c->>'uiName',
--     (SELECT string_agg(cat->>'name',' | ') FROM jsonb_array_elements(c->'categories') cat)
--   FROM country_config cc, jsonb_array_elements(cc.cities) c
--   WHERE cc.country_key='Peru' AND c->>'uiName' LIKE '%Airport%';
--   -- Arequipa airports: ... | Económico+ | Comfort+ | ...
--   -- Trujillo airports: ... | Viaje+ | Comfort+ | ...
-- ════════════════════════════════════════════════════════════════════════
