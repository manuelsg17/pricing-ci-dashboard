-- ============================================================
-- MIGRACIÓN 09: Configuración de horarios Rush Hour
-- Ejecutar en Supabase SQL Editor
-- ============================================================

CREATE TABLE IF NOT EXISTS rush_hour_windows (
  id         serial PRIMARY KEY,
  city       text NOT NULL DEFAULT 'all',   -- 'all' aplica a todas las ciudades
  label      text,                           -- 'Mañana', 'Tarde'
  start_time time NOT NULL,
  end_time   time NOT NULL,
  UNIQUE(city, start_time, end_time)
);

ALTER TABLE rush_hour_windows ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_all" ON rush_hour_windows
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Valores por defecto (horarios típicos de Lima/ciudades peruanas)
INSERT INTO rush_hour_windows(city, label, start_time, end_time) VALUES
  ('all', 'Mañana', '07:00', '09:00'),
  ('all', 'Tarde',  '17:00', '20:00')
ON CONFLICT (city, start_time, end_time) DO NOTHING;

SELECT * FROM rush_hour_windows ORDER BY city, start_time;
