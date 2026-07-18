-- ============================================================
-- MIGRACIÓN 12: Comisiones por competidor
-- Ejecutar en Supabase SQL Editor
-- ============================================================

CREATE TABLE IF NOT EXISTS competitor_commissions (
  id              serial PRIMARY KEY,
  competitor_name text NOT NULL,
  city            text,          -- NULL = aplica a todas las ciudades
  commission_pct  numeric NOT NULL DEFAULT 0,
  updated_at      timestamptz DEFAULT now(),
  UNIQUE(competitor_name, city)
);

ALTER TABLE competitor_commissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_all" ON competitor_commissions
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Defaults (comisiones aproximadas del mercado peruano)
INSERT INTO competitor_commissions(competitor_name, city, commission_pct) VALUES
  ('Yango',         NULL, 20),
  ('YangoPremier',  NULL, 20),
  ('YangoComfort+', NULL, 20),
  ('Yango Economy', NULL, 20),
  ('Yango Comfort', NULL, 20),
  ('Yango Comfort+',NULL, 20),
  ('Yango Premier', NULL, 20),
  ('Yango XL',      NULL, 20),
  ('Uber',          NULL, 25),
  ('Didi',          NULL, 20),
  ('InDrive',       NULL, 10),
  ('Cabify',        NULL, 20),
  ('Cabify Lite',   NULL, 20),
  ('Cabify Extra Comfort', NULL, 20),
  ('Cabify XL',     NULL, 20)
ON CONFLICT(competitor_name, city) DO NOTHING;

SELECT * FROM competitor_commissions ORDER BY competitor_name;
