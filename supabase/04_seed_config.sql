-- ============================================================
-- SEED: configuración por defecto
-- Umbrales de distancia, pesos y semáforo
-- ============================================================

-- --------------------------------------------------------
-- Umbrales de distancia por ciudad+categoría
-- max_km = NULL significa "sin límite" (último bracket)
-- --------------------------------------------------------

-- LIMA — todas las categorías usan los mismos umbrales base
-- (ajusta por categoría si los datos lo requieren)
INSERT INTO distance_thresholds (city, category, bracket, max_km) VALUES
  ('Lima', 'Economy',          'very_short',  2.09),
  ('Lima', 'Economy',          'short',        4.36),
  ('Lima', 'Economy',          'median',       7.00),
  ('Lima', 'Economy',          'average',     10.98),
  ('Lima', 'Economy',          'long',        15.00),
  ('Lima', 'Economy',          'very_long',   NULL),

  ('Lima', 'Comfort',          'very_short',  2.09),
  ('Lima', 'Comfort',          'short',        4.36),
  ('Lima', 'Comfort',          'median',       7.00),
  ('Lima', 'Comfort',          'average',     10.98),
  ('Lima', 'Comfort',          'long',        15.00),
  ('Lima', 'Comfort',          'very_long',   NULL),

  ('Lima', 'Premier', 'very_short',  2.09),
  ('Lima', 'Premier', 'short',        4.36),
  ('Lima', 'Premier', 'median',       7.00),
  ('Lima', 'Premier', 'average',     10.98),
  ('Lima', 'Premier', 'long',        15.00),
  ('Lima', 'Premier', 'very_long',   NULL),

  ('Lima', 'TukTuk',  'very_short',  2.09),
  ('Lima', 'TukTuk',  'short',        4.36),
  ('Lima', 'TukTuk',  'median',       7.00),
  ('Lima', 'TukTuk',  'average',     10.98),
  ('Lima', 'TukTuk',  'long',        15.00),
  ('Lima', 'TukTuk',  'very_long',   NULL),

  ('Lima', 'XL',      'very_short',  2.09),
  ('Lima', 'XL',      'short',        4.36),
  ('Lima', 'XL',      'median',       7.00),
  ('Lima', 'XL',      'average',     10.98),
  ('Lima', 'XL',      'long',        15.00),
  ('Lima', 'XL',      'very_long',   NULL),

-- AREQUIPA
  ('Arequipa', 'Economy',          'very_short',  1.94),
  ('Arequipa', 'Economy',          'short',        3.19),
  ('Arequipa', 'Economy',          'median',       4.11),
  ('Arequipa', 'Economy',          'average',      5.60),
  ('Arequipa', 'Economy',          'long',          8.76),
  ('Arequipa', 'Economy',          'very_long',    NULL),

  ('Arequipa', 'Comfort',  'very_short',  1.94),
  ('Arequipa', 'Comfort',  'short',        3.19),
  ('Arequipa', 'Comfort',  'median',       4.11),
  ('Arequipa', 'Comfort',  'average',      5.60),
  ('Arequipa', 'Comfort',  'long',          8.76),
  ('Arequipa', 'Comfort',  'very_long',    NULL),

-- TRUJILLO
  ('Trujillo', 'Economy',          'very_short',  1.10),
  ('Trujillo', 'Economy',          'short',        1.81),
  ('Trujillo', 'Economy',          'median',       2.68),
  ('Trujillo', 'Economy',          'average',      4.06),
  ('Trujillo', 'Economy',          'long',          7.66),
  ('Trujillo', 'Economy',          'very_long',    NULL),

  ('Trujillo', 'Comfort',  'very_short',  1.10),
  ('Trujillo', 'Comfort',  'short',        1.81),
  ('Trujillo', 'Comfort',  'median',       2.68),
  ('Trujillo', 'Comfort',  'average',      4.06),
  ('Trujillo', 'Comfort',  'long',          7.66),
  ('Trujillo', 'Comfort',  'very_long',    NULL),

-- AIRPORT — configura desde el panel Config
  ('Airport', 'all', 'very_short',  5.00),
  ('Airport', 'all', 'short',       10.00),
  ('Airport', 'all', 'median',      20.00),
  ('Airport', 'all', 'average',     30.00),
  ('Airport', 'all', 'long',        40.00),
  ('Airport', 'all', 'very_long',   NULL)

ON CONFLICT (city, category, bracket) DO NOTHING;

-- --------------------------------------------------------
-- Pesos por ciudad
-- Valor 'all' = por defecto global
-- --------------------------------------------------------
INSERT INTO bracket_weights (city, bracket, weight) VALUES
  -- Pesos globales (fallback)
  ('all', 'very_short', 0.098300),
  ('all', 'short',      0.196700),
  ('all', 'median',     0.193900),
  ('all', 'average',    0.138400),
  ('all', 'long',       0.075000),
  ('all', 'very_long',  0.297000),

  -- Lima (mismos pesos iniciales; ajusta desde Config)
  ('Lima', 'very_short', 0.098300),
  ('Lima', 'short',      0.196700),
  ('Lima', 'median',     0.193900),
  ('Lima', 'average',    0.138400),
  ('Lima', 'long',       0.075000),
  ('Lima', 'very_long',  0.297000),

  -- Trujillo
  ('Trujillo', 'very_short', 0.098300),
  ('Trujillo', 'short',      0.196700),
  ('Trujillo', 'median',     0.193900),
  ('Trujillo', 'average',    0.138400),
  ('Trujillo', 'long',       0.075000),
  ('Trujillo', 'very_long',  0.297000),

  -- Arequipa
  ('Arequipa', 'very_short', 0.098300),
  ('Arequipa', 'short',      0.196700),
  ('Arequipa', 'median',     0.193900),
  ('Arequipa', 'average',    0.138400),
  ('Arequipa', 'long',       0.075000),
  ('Arequipa', 'very_long',  0.297000),

  -- Airport
  ('Airport', 'very_short', 0.098300),
  ('Airport', 'short',      0.196700),
  ('Airport', 'median',     0.193900),
  ('Airport', 'average',    0.138400),
  ('Airport', 'long',       0.075000),
  ('Airport', 'very_long',  0.297000)

ON CONFLICT (city, bracket) DO NOTHING;

-- --------------------------------------------------------
-- Semáforo — bandas de color
-- --------------------------------------------------------
INSERT INTO semaforo_config (band, min_pct, max_pct, note) VALUES
  ('green',   5.00,  10.00, 'Competidor cobra 5-10% más que Yango (óptimo)'),
  ('yellow',  1.00,   4.99, 'Competidor cobra 1-5% más: vigilar'),
  ('yellow', 10.01,  12.00, 'Competidor cobra 10-12% más: sobre límite verde'),
  ('red',    NULL,    0.99, 'Competidor casi igual o más barato que Yango'),
  ('red',   12.01,   NULL,  'Competidor cobra >12% más: diferencia excesiva')

ON CONFLICT (band, min_pct) DO NOTHING;
