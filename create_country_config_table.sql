-- ============================================================
-- MIGRATION: country_config table
-- Run once in Supabase SQL Editor
-- ============================================================

CREATE TABLE IF NOT EXISTS public.country_config (
  country_key        text PRIMARY KEY,
  label              text NOT NULL,
  currency           text NOT NULL DEFAULT 'USD',
  locale             text NOT NULL DEFAULT 'en-US',
  outlier_threshold  numeric NOT NULL DEFAULT 100,
  max_price          numeric NOT NULL DEFAULT 1000,
  sort_order         int NOT NULL DEFAULT 0,
  cities             jsonb NOT NULL DEFAULT '[]',
  updated_at         timestamptz DEFAULT now()
);

-- RLS
ALTER TABLE public.country_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "allow_read_country_config"
  ON public.country_config FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "allow_write_country_config"
  ON public.country_config FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- ============================================================
-- cities JSONB format reference:
-- [
--   {
--     "uiName": "Lima",          -- name shown in UI dropdowns
--     "dbName": "Lima",          -- name used in Supabase queries
--     "botKey": "lima",          -- lowercase key from bot CSV files
--     "isVirtual": false,        -- true = hidden from UI city picker
--     "categories": [
--       {
--         "name": "Economy",     -- UI category name
--         "dbName": "Economy",   -- DB category name
--         "competitors": ["Yango", "Uber", "InDrive"],
--         "yangoDisplayName": "Yango"
--       }
--     ]
--   }
-- ]
-- ============================================================
