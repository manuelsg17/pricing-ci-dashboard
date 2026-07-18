-- ════════════════════════════════════════════════════════════════════════
-- Migración 37 — Tabla bot_rules
--
-- Misma información que el array botRules de src/lib/constants.js, pero
-- en SQL para que la función sync_bot_quotes() pueda joinar contra ella
-- sin hardcodear las reglas. Editable desde Config → Países.
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS bot_rules (
  id                serial      PRIMARY KEY,
  country           text        NOT NULL,
  app               text        NOT NULL,                  -- yango_api, uber, indrive, didi
  vc                text        NOT NULL,                  -- vehicle_category (lowercase)
  ovc               text        NOT NULL,                  -- observed_vehicle_category (lowercase) — '*' = wildcard
  competition_name  text        NOT NULL,                  -- Yango, YangoComfort, Uber, InDrive, Didi
  category          text        NOT NULL,                  -- Economy/Comfort, Comfort+, Premier, XL, TukTuk
  cities            text[]      NOT NULL DEFAULT '{}',     -- vacío = aplica a cualquier dbCity del país
  active            boolean     NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (country, app, vc, ovc)
);

CREATE INDEX IF NOT EXISTS idx_bot_rules_lookup
  ON bot_rules (country, app, vc, ovc)
  WHERE active;

ALTER TABLE bot_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated read bot_rules" ON bot_rules;
CREATE POLICY "Authenticated read bot_rules" ON bot_rules
  FOR SELECT TO authenticated USING (true);


-- ── Seed: reglas de Perú ────────────────────────────────────────────────
-- Mismo contenido que constants.js → COUNTRY_CONFIG.Peru.botRules
INSERT INTO bot_rules (country, app, vc, ovc, competition_name, category, cities) VALUES
  ('Peru', 'yango_api', 'economy',  'economy',  'Yango',         'Economy/Comfort', '{}'),
  ('Peru', 'yango_api', 'comfort',  'comfort',  'YangoComfort',  'Economy/Comfort', '{}'),
  ('Peru', 'yango_api', 'comfort',  'comfort+', 'Yango',         'Comfort+',        '{}'),
  ('Peru', 'yango_api', 'premier',  'premier',  'Yango',         'Premier',         '{Lima,Lima_Airport}'),
  ('Peru', 'yango_api', 'xl',       'xl',       'Yango',         'XL',              '{}'),
  ('Peru', 'yango_api', 'tuktuk',   '*',        'Yango',         'TukTuk',          '{Lima}'),
  ('Peru', 'uber',      'economy',  'uberx',    'Uber',          'Economy/Comfort', '{}'),
  ('Peru', 'uber',      'comfort',  'comfort',  'Uber',          'Comfort+',        '{}'),
  ('Peru', 'uber',      'premium',  'black',    'Uber',          'Premier',         '{Lima,Lima_Airport}'),
  ('Peru', 'uber',      'xl',       'xl',       'Uber',          'XL',              '{}'),
  ('Peru', 'uber',      'tuktuk',   '*',        'Uber',          'TukTuk',          '{Lima}'),
  ('Peru', 'indrive',   'economy',  'viaje',    'InDrive',       'Economy/Comfort', '{}'),
  ('Peru', 'indrive',   'comfort',  'confort',  'InDrive',       'Comfort+',        '{}'),
  ('Peru', 'indrive',   'xl',       'xl',       'InDrive',       'XL',              '{}'),
  ('Peru', 'didi',      'economy',  'express',  'Didi',          'Economy/Comfort', '{}')
ON CONFLICT (country, app, vc, ovc) DO UPDATE SET
  competition_name = EXCLUDED.competition_name,
  category         = EXCLUDED.category,
  cities           = EXCLUDED.cities,
  active           = true;
