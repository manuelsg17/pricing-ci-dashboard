-- ════════════════════════════════════════════════════════════════════════
-- Migración 45 — Setup completo de Colombia
--
-- Inserta toda la configuración necesaria para que el bot empiece a
-- ingerir data de Colombia (Bogotá, Cali, Barranquilla) y para que las
-- vistas del dashboard funcionen correctamente.
--
-- Idempotente: usa ON CONFLICT DO UPDATE/NOTHING en todos los inserts.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. bot_rules ──────────────────────────────────────────────────────
-- Mismo array que COUNTRY_CONFIG.Colombia.botRules en constants.js
INSERT INTO bot_rules (country, app, vc, ovc, competition_name, category, cities) VALUES
  -- Economy
  ('Colombia', 'yango',   'economy', 'economy', 'Yango',   'Economy', '{}'),
  ('Colombia', 'uber',    'economy', 'uberx',   'Uber',    'Economy', '{}'),
  ('Colombia', 'didi',    'economy', 'express', 'Didi',    'Economy', '{}'),
  ('Colombia', 'indrive', 'economy', 'viaje',   'InDrive', 'Economy', '{}'),
  -- Comfort
  ('Colombia', 'yango',   'comfort', 'comfort', 'Yango',   'Comfort', '{}'),
  ('Colombia', 'uber',    'comfort', 'comfort', 'Uber',    'Comfort', '{}'),
  ('Colombia', 'didi',    'comfort', '*',       'Didi',    'Comfort', '{}'),
  ('Colombia', 'indrive', 'comfort', 'confort', 'InDrive', 'Comfort', '{}'),
  -- Bike (Picap es app moto-only en Colombia)
  ('Colombia', 'yango',   'moto', '*', 'Yango',   'Bike', '{}'),
  ('Colombia', 'didi',    'moto', '*', 'Didi',    'Bike', '{}'),
  ('Colombia', 'indrive', 'moto', '*', 'InDrive', 'Bike', '{}'),
  ('Colombia', 'picap',   'moto', '*', 'Picap',   'Bike', '{}')
ON CONFLICT (country, app, vc, ovc) DO UPDATE SET
  competition_name = EXCLUDED.competition_name,
  category         = EXCLUDED.category,
  cities           = EXCLUDED.cities,
  active           = true;


-- ── 2. distance_thresholds ────────────────────────────────────────────
-- 6 brackets × 3 cities × 3 categorías = 54 filas. Valores iniciales
-- copiados de la curva de Lima Economy/Comfort. Tunear según métricas
-- reales después de empezar a ingerir data.
INSERT INTO distance_thresholds (country, city, category, bracket, max_km) VALUES
  ('Colombia', 'Bogota',       'Economy', 'very_short', 2),
  ('Colombia', 'Bogota',       'Economy', 'short',      4),
  ('Colombia', 'Bogota',       'Economy', 'median',     7),
  ('Colombia', 'Bogota',       'Economy', 'average',    11),
  ('Colombia', 'Bogota',       'Economy', 'long',       16),
  ('Colombia', 'Bogota',       'Economy', 'very_long',  NULL),
  ('Colombia', 'Bogota',       'Comfort', 'very_short', 2),
  ('Colombia', 'Bogota',       'Comfort', 'short',      4),
  ('Colombia', 'Bogota',       'Comfort', 'median',     7),
  ('Colombia', 'Bogota',       'Comfort', 'average',    11),
  ('Colombia', 'Bogota',       'Comfort', 'long',       16),
  ('Colombia', 'Bogota',       'Comfort', 'very_long',  NULL),
  ('Colombia', 'Bogota',       'Bike',    'very_short', 1.5),
  ('Colombia', 'Bogota',       'Bike',    'short',      3),
  ('Colombia', 'Bogota',       'Bike',    'median',     5),
  ('Colombia', 'Bogota',       'Bike',    'average',    8),
  ('Colombia', 'Bogota',       'Bike',    'long',       12),
  ('Colombia', 'Bogota',       'Bike',    'very_long',  NULL),
  ('Colombia', 'Cali',         'Economy', 'very_short', 2),
  ('Colombia', 'Cali',         'Economy', 'short',      4),
  ('Colombia', 'Cali',         'Economy', 'median',     7),
  ('Colombia', 'Cali',         'Economy', 'average',    11),
  ('Colombia', 'Cali',         'Economy', 'long',       16),
  ('Colombia', 'Cali',         'Economy', 'very_long',  NULL),
  ('Colombia', 'Cali',         'Comfort', 'very_short', 2),
  ('Colombia', 'Cali',         'Comfort', 'short',      4),
  ('Colombia', 'Cali',         'Comfort', 'median',     7),
  ('Colombia', 'Cali',         'Comfort', 'average',    11),
  ('Colombia', 'Cali',         'Comfort', 'long',       16),
  ('Colombia', 'Cali',         'Comfort', 'very_long',  NULL),
  ('Colombia', 'Cali',         'Bike',    'very_short', 1.5),
  ('Colombia', 'Cali',         'Bike',    'short',      3),
  ('Colombia', 'Cali',         'Bike',    'median',     5),
  ('Colombia', 'Cali',         'Bike',    'average',    8),
  ('Colombia', 'Cali',         'Bike',    'long',       12),
  ('Colombia', 'Cali',         'Bike',    'very_long',  NULL),
  ('Colombia', 'Barranquilla', 'Economy', 'very_short', 2),
  ('Colombia', 'Barranquilla', 'Economy', 'short',      4),
  ('Colombia', 'Barranquilla', 'Economy', 'median',     7),
  ('Colombia', 'Barranquilla', 'Economy', 'average',    11),
  ('Colombia', 'Barranquilla', 'Economy', 'long',       16),
  ('Colombia', 'Barranquilla', 'Economy', 'very_long',  NULL),
  ('Colombia', 'Barranquilla', 'Comfort', 'very_short', 2),
  ('Colombia', 'Barranquilla', 'Comfort', 'short',      4),
  ('Colombia', 'Barranquilla', 'Comfort', 'median',     7),
  ('Colombia', 'Barranquilla', 'Comfort', 'average',    11),
  ('Colombia', 'Barranquilla', 'Comfort', 'long',       16),
  ('Colombia', 'Barranquilla', 'Comfort', 'very_long',  NULL),
  ('Colombia', 'Barranquilla', 'Bike',    'very_short', 1.5),
  ('Colombia', 'Barranquilla', 'Bike',    'short',      3),
  ('Colombia', 'Barranquilla', 'Bike',    'median',     5),
  ('Colombia', 'Barranquilla', 'Bike',    'average',    8),
  ('Colombia', 'Barranquilla', 'Bike',    'long',       12),
  ('Colombia', 'Barranquilla', 'Bike',    'very_long',  NULL)
ON CONFLICT (country, city, category, bracket) DO NOTHING;


-- ── 3. bracket_weights ────────────────────────────────────────────────
-- Pesos uniformes iniciales (~16% por bracket). Ajustar según mix real
-- de viajes una vez que haya histórico.
INSERT INTO bracket_weights (country, city, bracket, weight) VALUES
  ('Colombia', 'all', 'very_short', 0.10),
  ('Colombia', 'all', 'short',      0.20),
  ('Colombia', 'all', 'median',     0.20),
  ('Colombia', 'all', 'average',    0.15),
  ('Colombia', 'all', 'long',       0.10),
  ('Colombia', 'all', 'very_long',  0.25)
ON CONFLICT (country, city, bracket) DO NOTHING;


-- ── 4. price_validation_rules ─────────────────────────────────────────
-- Tope general en COP. Sin esto, usePriceRules.checkOutliers no rechaza
-- nada (después del fix devuelve Infinity en lugar del antiguo 999).
INSERT INTO price_validation_rules (country, city, category, competition, max_price) VALUES
  ('Colombia', 'Bogota',       'all', 'all', 300000),
  ('Colombia', 'Cali',         'all', 'all', 300000),
  ('Colombia', 'Barranquilla', 'all', 'all', 300000)
ON CONFLICT (country, city, category, competition) DO NOTHING;


-- ── 5. semaforo_config ────────────────────────────────────────────────
-- Si la tabla existe y soporta country, replicar config de Perú.
-- Si no, esto es no-op.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'semaforo_config' AND column_name = 'country') THEN
    INSERT INTO semaforo_config (country, band, min_pct, max_pct)
    SELECT 'Colombia', band, min_pct, max_pct
    FROM semaforo_config WHERE country = 'Peru'
    ON CONFLICT DO NOTHING;
  END IF;
END $$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- Verificación post-aplicación:
--
-- SELECT count(*) FROM bot_rules WHERE country = 'Colombia';
--   → debería ser 12
--
-- SELECT count(*) FROM distance_thresholds WHERE country = 'Colombia';
--   → debería ser 54
--
-- SELECT count(*) FROM bracket_weights WHERE country = 'Colombia';
--   → debería ser 6
--
-- SELECT count(*) FROM price_validation_rules WHERE country = 'Colombia';
--   → debería ser 3
-- ════════════════════════════════════════════════════════════════════════
