-- ============================================================
-- MIGRACIÓN 13: Bonos por competidor
-- Ejecutar en Supabase SQL Editor
-- ============================================================

CREATE TABLE IF NOT EXISTS competitor_bonuses (
  id              serial PRIMARY KEY,
  competitor_name text NOT NULL,
  city            text,          -- NULL = aplica a todas las ciudades
  bonus_type      text NOT NULL CHECK (bonus_type IN ('viajes','horas','zona')),
  threshold       numeric NOT NULL,
  bonus_amount    numeric NOT NULL,
  description     text,
  sort_order      int NOT NULL DEFAULT 0,
  is_active       boolean NOT NULL DEFAULT true,
  updated_at      timestamptz DEFAULT now()
);

ALTER TABLE competitor_bonuses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_all" ON competitor_bonuses
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

SELECT * FROM competitor_bonuses ORDER BY competitor_name, sort_order;
