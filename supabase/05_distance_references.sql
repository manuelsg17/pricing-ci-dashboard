-- ============================================================
-- Tabla de distancias de referencia (rutas para CI)
-- Ejecutar en el SQL Editor de Supabase
-- ============================================================

CREATE TABLE IF NOT EXISTS distance_references (
  id             serial PRIMARY KEY,
  city           text NOT NULL,        -- DB-level city: Lima | Trujillo | Arequipa | Airport | Corp
  category       text NOT NULL DEFAULT '',
  bracket        text NOT NULL DEFAULT '',
  point_a        text,                 -- Nombre del punto de origen
  coordinate_a   text,                 -- Coordenadas del punto A (ej: "-12.0464, -77.0428")
  point_b        text,                 -- Nombre del punto de destino
  coordinate_b   text,                 -- Coordenadas del punto B
  waze_distance  numeric,              -- Distancia según Waze en km
  updated_at     timestamptz DEFAULT now(),
  updated_by     text
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_distance_refs_city ON distance_references(city);
CREATE INDEX IF NOT EXISTS idx_distance_refs_city_cat ON distance_references(city, category);

-- Row Level Security
ALTER TABLE distance_references ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_all" ON distance_references;
CREATE POLICY "auth_all" ON distance_references
  FOR ALL TO authenticated
  USING (true)
  WITH CHECK (true);
