-- ============================================================
-- PRICING CI DASHBOARD — SCHEMA
-- Ejecutar en Supabase SQL Editor en orden: 01 → 04
-- ============================================================

-- --------------------------------------------------------
-- TABLA PRINCIPAL: observaciones de precios crudas
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS pricing_observations (
  id                     bigserial PRIMARY KEY,
  city                   text NOT NULL,
  year                   int,
  week                   int,
  observed_date          date NOT NULL,
  observed_time          time,
  rush_hour              boolean,
  point_a                text,
  point_b                text,
  zone                   text,
  distance_km            numeric NOT NULL,
  distance_bracket       text,          -- asignado automáticamente por trigger
  timeslot               text,          -- Morning / Midday / Evening
  category               text NOT NULL,
  competition_name       text NOT NULL,
  surge                  boolean DEFAULT false,
  travel_time_min        numeric,
  eta_min                numeric,
  recommended_price      numeric,
  minimal_bid            numeric,
  price_with_discount    numeric,
  price_without_discount numeric,
  bid_1                  numeric,
  bid_2                  numeric,
  bid_3                  numeric,
  bid_4                  numeric,
  bid_5                  numeric,
  discount_offer         numeric,
  diff                   numeric,
  for_pivot              text,
  upload_batch_id        uuid,
  uploaded_at            timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_po_city_week        ON pricing_observations (city, year, week);
CREATE INDEX IF NOT EXISTS idx_po_category         ON pricing_observations (category);
CREATE INDEX IF NOT EXISTS idx_po_competitor       ON pricing_observations (competition_name);
CREATE INDEX IF NOT EXISTS idx_po_bracket          ON pricing_observations (distance_bracket);
CREATE INDEX IF NOT EXISTS idx_po_date             ON pricing_observations (observed_date);
CREATE INDEX IF NOT EXISTS idx_po_city_cat_bracket ON pricing_observations (city, category, distance_bracket);

-- --------------------------------------------------------
-- CONFIGURACIÓN: umbrales de distancia por ciudad+categoría
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS distance_thresholds (
  id         serial PRIMARY KEY,
  city       text NOT NULL,
  category   text NOT NULL DEFAULT 'all',
  bracket    text NOT NULL,             -- very_short | short | median | average | long | very_long
  max_km     numeric(8,3),              -- NULL = sin límite superior (último bracket)
  updated_at timestamptz DEFAULT now(),
  UNIQUE (city, category, bracket)
);

-- --------------------------------------------------------
-- CONFIGURACIÓN: pesos por ciudad
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS bracket_weights (
  id         serial PRIMARY KEY,
  city       text NOT NULL DEFAULT 'all',
  bracket    text NOT NULL,
  weight     numeric(10,6) NOT NULL,    -- fracción: 0.0983 = 9.83%
  updated_at timestamptz DEFAULT now(),
  UNIQUE (city, bracket)
);

-- --------------------------------------------------------
-- CONFIGURACIÓN: semáforo (bandas de color)
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS semaforo_config (
  id       serial PRIMARY KEY,
  band     text NOT NULL,               -- green | yellow | red
  min_pct  numeric(8,4),               -- NULL = sin límite inferior
  max_pct  numeric(8,4),               -- NULL = sin límite superior
  note     text,
  UNIQUE (band, min_pct)
);

-- --------------------------------------------------------
-- AUDITORÍA: lotes de carga
-- --------------------------------------------------------
CREATE TABLE IF NOT EXISTS upload_batches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  uploaded_by   text,
  filename      text,
  row_count     int,
  city          text,
  created_at    timestamptz DEFAULT now()
);

-- --------------------------------------------------------
-- ROW LEVEL SECURITY
-- --------------------------------------------------------
ALTER TABLE pricing_observations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE distance_thresholds   ENABLE ROW LEVEL SECURITY;
ALTER TABLE bracket_weights       ENABLE ROW LEVEL SECURITY;
ALTER TABLE semaforo_config       ENABLE ROW LEVEL SECURITY;
ALTER TABLE upload_batches        ENABLE ROW LEVEL SECURITY;

-- Solo usuarios autenticados pueden leer/escribir
CREATE POLICY "auth_read_write" ON pricing_observations
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "auth_read_write" ON distance_thresholds
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "auth_read_write" ON bracket_weights
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "auth_read_write" ON semaforo_config
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE POLICY "auth_read_write" ON upload_batches
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
