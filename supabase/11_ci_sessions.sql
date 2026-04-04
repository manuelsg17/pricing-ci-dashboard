-- ============================================================
-- MIGRACIÓN 11: Sesiones de CI (auditoría de tiempo)
-- Ejecutar en Supabase SQL Editor
-- ============================================================

CREATE TABLE IF NOT EXISTS ci_sessions (
  id               serial PRIMARY KEY,
  city             text NOT NULL,
  observed_date    date NOT NULL,
  user_email       text,
  started_at       timestamptz NOT NULL,
  ended_at         timestamptz,
  duration_minutes numeric,
  rows_saved       int,
  created_at       timestamptz DEFAULT now()
);

ALTER TABLE ci_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_all" ON ci_sessions
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

SELECT * FROM ci_sessions ORDER BY created_at DESC LIMIT 10;
