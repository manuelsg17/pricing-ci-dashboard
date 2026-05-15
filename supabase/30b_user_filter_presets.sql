-- Migration 30: User filter presets
-- Allows users to save and load named filter combinations.

CREATE TABLE IF NOT EXISTS user_filter_presets (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  country     text        NOT NULL DEFAULT 'Peru',
  name        text        NOT NULL,
  filters     jsonb       NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_filter_presets_user_country
  ON user_filter_presets(user_id, country);

ALTER TABLE user_filter_presets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users manage their own presets"
  ON user_filter_presets FOR ALL
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
