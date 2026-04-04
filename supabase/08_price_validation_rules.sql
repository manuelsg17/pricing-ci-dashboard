-- ============================================================
-- MIGRACIÓN 08: Reglas de validación de precios
-- Ejecutar en Supabase SQL Editor
-- ============================================================

CREATE TABLE IF NOT EXISTS price_validation_rules (
  id          serial PRIMARY KEY,
  city        text NOT NULL,
  category    text NOT NULL DEFAULT 'all',
  competition text NOT NULL DEFAULT 'all',
  max_price   numeric NOT NULL DEFAULT 120,
  updated_at  timestamptz DEFAULT now(),
  UNIQUE(city, category, competition)
);

ALTER TABLE price_validation_rules ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_all" ON price_validation_rules
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Valores por defecto (ajusta según tu criterio)
INSERT INTO price_validation_rules(city, category, competition, max_price) VALUES
  ('Lima',      'all', 'all', 120),
  ('Trujillo',  'all', 'all',  80),
  ('Arequipa',  'all', 'all',  80),
  ('Airport',   'all', 'all', 150),
  ('Corp',      'all', 'all', 200)
ON CONFLICT (city, category, competition) DO NOTHING;

SELECT * FROM price_validation_rules ORDER BY city;
