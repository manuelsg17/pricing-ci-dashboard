-- ============================================================
-- Migration 19: InDrive adjustment config
-- Almacena el % de ajuste que se aplica a la data del bot
-- de InDrive (bot no captura bids, solo precio recomendado).
-- ============================================================

CREATE TABLE IF NOT EXISTS indrive_config (
  id             serial PRIMARY KEY,
  city           text NOT NULL,
  category       text NOT NULL,
  adjustment_pct numeric NOT NULL DEFAULT 0,
  note           text,
  updated_at     timestamptz DEFAULT now(),
  UNIQUE(city, category)
);

ALTER TABLE indrive_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_all" ON indrive_config
  FOR ALL TO authenticated
  USING (true)
  WITH CHECK (true);

-- Filas iniciales para las combinaciones conocidas (pct = 0 hasta que el usuario las configure)
INSERT INTO indrive_config (city, category, adjustment_pct) VALUES
  ('Lima',     'Economy', 0),
  ('Lima',     'Comfort', 0),
  ('Lima',     'Premier', 0),
  ('Lima',     'XL',      0),
  ('Lima',     'TukTuk',  0),
  ('Trujillo', 'Economy', 0),
  ('Trujillo', 'Comfort', 0),
  ('Arequipa', 'Economy', 0),
  ('Arequipa', 'Comfort', 0)
ON CONFLICT (city, category) DO NOTHING;
