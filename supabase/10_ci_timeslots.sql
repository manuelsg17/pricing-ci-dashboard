-- ============================================================
-- MIGRACIÓN 10: Timeslots de CI (configurables)
-- Ejecutar en Supabase SQL Editor
-- ============================================================

CREATE TABLE IF NOT EXISTS ci_timeslots (
  id         serial PRIMARY KEY,
  label      text NOT NULL,
  start_time time NOT NULL,
  end_time   time NOT NULL,
  is_active  boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 0,
  UNIQUE(label)
);

ALTER TABLE ci_timeslots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_all" ON ci_timeslots
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Valores por defecto (3 timeslots diarios)
INSERT INTO ci_timeslots(label, start_time, end_time, is_active, sort_order) VALUES
  ('Mañana', '08:00', '10:00', true, 1),
  ('Tarde',  '13:00', '15:00', true, 2),
  ('Noche',  '18:00', '20:00', true, 3)
ON CONFLICT(label) DO NOTHING;

SELECT * FROM ci_timeslots ORDER BY sort_order;
