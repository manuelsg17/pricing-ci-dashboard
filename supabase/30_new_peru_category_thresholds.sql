-- ============================================================
-- MIGRACIÓN 30: Umbrales de distancia para nuevas categorías Perú
-- ============================================================
-- Contexto: el sprint de renombrado (ae1e9ca) cambió los nombres de
-- categoría en Peru: Economy → Economy/Comfort, Comfort → Comfort+.
-- El trigger trg_assign_computed_fields() recalcula distance_bracket
-- a partir de distance_km usando la tabla distance_thresholds.
-- Como esa tabla solo tenía entradas para los nombres VIEJOS, todas
-- las filas de Economy/Comfort y Comfort+ recibían 'very_long' por
-- defecto, causando que no aparecieran en los brackets correctos del dashboard.
--
-- Esta migración:
-- 1. Agrega umbrales para Economy/Comfort, Comfort+ en Lima/Trujillo/Arequipa
-- 2. Agrega umbrales para las nuevas ciudades *_Airport (antes solo había 'Airport')
-- 3. Hace backfill de filas ya insertadas con los umbrales correctos
-- ============================================================


-- ── 1. Lima ─────────────────────────────────────────────────

INSERT INTO distance_thresholds (city, category, bracket, max_km) VALUES
  ('Lima', 'Economy/Comfort', 'very_short',  2.09),
  ('Lima', 'Economy/Comfort', 'short',        4.36),
  ('Lima', 'Economy/Comfort', 'median',       7.00),
  ('Lima', 'Economy/Comfort', 'average',     10.98),
  ('Lima', 'Economy/Comfort', 'long',        15.00),
  ('Lima', 'Economy/Comfort', 'very_long',   NULL),

  ('Lima', 'Comfort+',        'very_short',  2.09),
  ('Lima', 'Comfort+',        'short',        4.36),
  ('Lima', 'Comfort+',        'median',       7.00),
  ('Lima', 'Comfort+',        'average',     10.98),
  ('Lima', 'Comfort+',        'long',        15.00),
  ('Lima', 'Comfort+',        'very_long',   NULL)

ON CONFLICT (city, category, bracket) DO NOTHING;


-- ── 2. Trujillo ─────────────────────────────────────────────

INSERT INTO distance_thresholds (city, category, bracket, max_km) VALUES
  ('Trujillo', 'Economy/Comfort', 'very_short',  1.10),
  ('Trujillo', 'Economy/Comfort', 'short',        1.81),
  ('Trujillo', 'Economy/Comfort', 'median',       2.68),
  ('Trujillo', 'Economy/Comfort', 'average',      4.06),
  ('Trujillo', 'Economy/Comfort', 'long',          7.66),
  ('Trujillo', 'Economy/Comfort', 'very_long',    NULL),

  ('Trujillo', 'Comfort+',        'very_short',  1.10),
  ('Trujillo', 'Comfort+',        'short',        1.81),
  ('Trujillo', 'Comfort+',        'median',       2.68),
  ('Trujillo', 'Comfort+',        'average',      4.06),
  ('Trujillo', 'Comfort+',        'long',          7.66),
  ('Trujillo', 'Comfort+',        'very_long',    NULL),

  ('Trujillo', 'XL',              'very_short',  1.10),
  ('Trujillo', 'XL',              'short',        1.81),
  ('Trujillo', 'XL',              'median',       2.68),
  ('Trujillo', 'XL',              'average',      4.06),
  ('Trujillo', 'XL',              'long',          7.66),
  ('Trujillo', 'XL',              'very_long',    NULL)

ON CONFLICT (city, category, bracket) DO NOTHING;


-- ── 3. Arequipa ─────────────────────────────────────────────

INSERT INTO distance_thresholds (city, category, bracket, max_km) VALUES
  ('Arequipa', 'Economy/Comfort', 'very_short',  1.94),
  ('Arequipa', 'Economy/Comfort', 'short',        3.19),
  ('Arequipa', 'Economy/Comfort', 'median',       4.11),
  ('Arequipa', 'Economy/Comfort', 'average',      5.60),
  ('Arequipa', 'Economy/Comfort', 'long',          8.76),
  ('Arequipa', 'Economy/Comfort', 'very_long',    NULL),

  ('Arequipa', 'Comfort+',        'very_short',  1.94),
  ('Arequipa', 'Comfort+',        'short',        3.19),
  ('Arequipa', 'Comfort+',        'median',       4.11),
  ('Arequipa', 'Comfort+',        'average',      5.60),
  ('Arequipa', 'Comfort+',        'long',          8.76),
  ('Arequipa', 'Comfort+',        'very_long',    NULL)

ON CONFLICT (city, category, bracket) DO NOTHING;


-- ── 4. Lima_Airport ─────────────────────────────────────────
-- Las rutas de aeropuerto son más largas; usamos la misma escala
-- que el antiguo 'Airport' (5/10/20/30/40/NULL).
-- Aplica a todas las categorías vía 'all'.

INSERT INTO distance_thresholds (city, category, bracket, max_km) VALUES
  ('Lima_Airport', 'all', 'very_short',  5.00),
  ('Lima_Airport', 'all', 'short',       10.00),
  ('Lima_Airport', 'all', 'median',      20.00),
  ('Lima_Airport', 'all', 'average',     30.00),
  ('Lima_Airport', 'all', 'long',        40.00),
  ('Lima_Airport', 'all', 'very_long',   NULL)

ON CONFLICT (city, category, bracket) DO NOTHING;


-- ── 5. Trujillo_Airport ─────────────────────────────────────

INSERT INTO distance_thresholds (city, category, bracket, max_km) VALUES
  ('Trujillo_Airport', 'all', 'very_short',  5.00),
  ('Trujillo_Airport', 'all', 'short',       10.00),
  ('Trujillo_Airport', 'all', 'median',      20.00),
  ('Trujillo_Airport', 'all', 'average',     30.00),
  ('Trujillo_Airport', 'all', 'long',        40.00),
  ('Trujillo_Airport', 'all', 'very_long',   NULL)

ON CONFLICT (city, category, bracket) DO NOTHING;


-- ── 6. Arequipa_Airport ─────────────────────────────────────

INSERT INTO distance_thresholds (city, category, bracket, max_km) VALUES
  ('Arequipa_Airport', 'all', 'very_short',  5.00),
  ('Arequipa_Airport', 'all', 'short',       10.00),
  ('Arequipa_Airport', 'all', 'median',      20.00),
  ('Arequipa_Airport', 'all', 'average',     30.00),
  ('Arequipa_Airport', 'all', 'long',        40.00),
  ('Arequipa_Airport', 'all', 'very_long',   NULL)

ON CONFLICT (city, category, bracket) DO NOTHING;


-- ── 7. Backfill: recalcular brackets de filas existentes ────
-- Solo actualiza filas con distance_km (el trigger ya lo hará en inserciones futuras).
-- Excluye Corp (no tiene umbrales de distancia).

-- 7a. Ciudades regulares: nuevas categorías Economy/Comfort y Comfort+
UPDATE pricing_observations
SET distance_bracket = get_distance_bracket(city, category, distance_km)
WHERE country = 'Peru'
  AND city NOT IN ('Corp', 'Lima_Airport', 'Trujillo_Airport', 'Arequipa_Airport')
  AND distance_km IS NOT NULL
  AND category IN ('Economy/Comfort', 'Comfort+');

-- 7b. Nuevas ciudades aeropuerto (cualquier categoría)
UPDATE pricing_observations
SET distance_bracket = get_distance_bracket(city, category, distance_km)
WHERE country = 'Peru'
  AND city IN ('Lima_Airport', 'Trujillo_Airport', 'Arequipa_Airport')
  AND distance_km IS NOT NULL;

-- Verificar resultado:
SELECT
  city,
  category,
  distance_bracket,
  COUNT(*) AS filas
FROM pricing_observations
WHERE country = 'Peru'
  AND category IN ('Economy/Comfort', 'Comfort+')
GROUP BY city, category, distance_bracket
ORDER BY city, category, distance_bracket;
