-- ══════════════════════════════════════════════════════════════════════
-- Migration 16: Ensure ci_sessions table exists (idempotent)
-- Run this in Supabase SQL Editor if the table doesn't exist yet.
-- ══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS ci_sessions (
  id               serial PRIMARY KEY,
  city             text NOT NULL,
  observed_date    date NOT NULL,
  user_email       text,
  started_at       timestamptz NOT NULL,
  ended_at         timestamptz NOT NULL,
  duration_minutes numeric NOT NULL,
  rows_saved       int NOT NULL DEFAULT 0,
  created_at       timestamptz DEFAULT now()
);

ALTER TABLE ci_sessions ENABLE ROW LEVEL SECURITY;

-- Allow all authenticated users to read/write their own sessions
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'ci_sessions' AND policyname = 'auth_all'
  ) THEN
    CREATE POLICY "auth_all" ON ci_sessions
      FOR ALL TO authenticated
      USING (true) WITH CHECK (true);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ci_sessions_city_date     ON ci_sessions(city, observed_date);
CREATE INDEX IF NOT EXISTS ci_sessions_user_email    ON ci_sessions(user_email);
CREATE INDEX IF NOT EXISTS ci_sessions_started_at    ON ci_sessions(started_at DESC);
