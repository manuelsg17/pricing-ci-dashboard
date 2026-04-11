-- ══════════════════════════════════════════════════════════════════════
-- Migration 18: Access Management — roles + user_profiles
-- Enables role-based access control (RBAC) per section and country.
-- ══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS roles (
  id          serial PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  label       text NOT NULL,
  permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- permissions: { "sections": ["dashboard","earnings",...], "countries": ["Peru","Colombia"] }
  -- Use ["all"] as wildcard for unrestricted access
  created_at  timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_profiles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL UNIQUE,
  first_name  text NOT NULL DEFAULT '',
  last_name   text NOT NULL DEFAULT '',
  role_id     int REFERENCES roles(id) ON DELETE SET NULL,
  is_active   boolean NOT NULL DEFAULT true,
  invited_by  text,
  notes       text,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

-- RLS
ALTER TABLE roles         ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'roles' AND policyname = 'auth_all_roles'
  ) THEN
    CREATE POLICY "auth_all_roles" ON roles FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'user_profiles' AND policyname = 'auth_all_profiles'
  ) THEN
    CREATE POLICY "auth_all_profiles" ON user_profiles FOR ALL TO authenticated USING (true) WITH CHECK (true);
  END IF;
END $$;

-- Indexes
CREATE INDEX IF NOT EXISTS user_profiles_email   ON user_profiles(email);
CREATE INDEX IF NOT EXISTS user_profiles_role_id ON user_profiles(role_id);

-- Seed default roles (idempotent)
INSERT INTO roles(name, label, permissions) VALUES
  ('admin', 'Administrador', '{
    "sections": ["all"],
    "countries": ["all"]
  }'),
  ('hub_expert', 'Hub Expert', '{
    "sections": ["dashboard", "dataentry", "rawdata"],
    "countries": ["Peru"]
  }'),
  ('analyst', 'Analista', '{
    "sections": ["dashboard", "earnings", "report"],
    "countries": ["all"]
  }')
ON CONFLICT(name) DO NOTHING;
