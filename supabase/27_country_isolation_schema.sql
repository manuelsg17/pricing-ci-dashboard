-- ============================================================
-- MIGRACIÓN 27: Country isolation — schema multi-país
-- ============================================================
-- Agrega columna `country` a las 7 tablas de configuración
-- que aún no la tienen. Backfill automático con 'Peru' para
-- filas legacy (DEFAULT). Las filas nuevas siempre reciben
-- `country` inyectado explícitamente desde el frontend.
--
-- PRE-REQUISITO: ejecutar audit_country_mislabeled.sql y
-- confirmar 0 filas antes de aplicar esta migración.
--
-- REVERSIBLE: sí (DROP COLUMN + restaurar constraints previos).
-- ============================================================

-- ── 1. distance_thresholds ──────────────────────────────────
ALTER TABLE distance_thresholds
  ADD COLUMN IF NOT EXISTS country text NOT NULL DEFAULT 'Peru';

-- Reemplazar UNIQUE (city, category, bracket) → incluye country
ALTER TABLE distance_thresholds
  DROP CONSTRAINT IF EXISTS distance_thresholds_city_category_bracket_key;

ALTER TABLE distance_thresholds
  ADD CONSTRAINT distance_thresholds_country_city_category_bracket_key
  UNIQUE (country, city, category, bracket);

CREATE INDEX IF NOT EXISTS idx_distance_thresholds_country_city
  ON distance_thresholds(country, city, category);


-- ── 2. bracket_weights ──────────────────────────────────────
ALTER TABLE bracket_weights
  ADD COLUMN IF NOT EXISTS country text NOT NULL DEFAULT 'Peru';

ALTER TABLE bracket_weights
  DROP CONSTRAINT IF EXISTS bracket_weights_city_bracket_key;

ALTER TABLE bracket_weights
  ADD CONSTRAINT bracket_weights_country_city_bracket_key
  UNIQUE (country, city, bracket);

CREATE INDEX IF NOT EXISTS idx_bracket_weights_country_city
  ON bracket_weights(country, city);


-- ── 3. distance_references ──────────────────────────────────
ALTER TABLE distance_references
  ADD COLUMN IF NOT EXISTS country text NOT NULL DEFAULT 'Peru';

CREATE INDEX IF NOT EXISTS idx_distance_refs_country_city
  ON distance_references(country, city, category);


-- ── 4. indrive_config ───────────────────────────────────────
ALTER TABLE indrive_config
  ADD COLUMN IF NOT EXISTS country text NOT NULL DEFAULT 'Peru';

ALTER TABLE indrive_config
  DROP CONSTRAINT IF EXISTS indrive_config_city_category_key;

ALTER TABLE indrive_config
  ADD CONSTRAINT indrive_config_country_city_category_key
  UNIQUE (country, city, category);

CREATE INDEX IF NOT EXISTS idx_indrive_config_country_city
  ON indrive_config(country, city, category);


-- ── 5. upload_batches ───────────────────────────────────────
ALTER TABLE upload_batches
  ADD COLUMN IF NOT EXISTS country text NOT NULL DEFAULT 'Peru';

CREATE INDEX IF NOT EXISTS idx_upload_batches_country
  ON upload_batches(country);


-- ── 6. price_validation_rules ───────────────────────────────
ALTER TABLE price_validation_rules
  ADD COLUMN IF NOT EXISTS country text NOT NULL DEFAULT 'Peru';

ALTER TABLE price_validation_rules
  DROP CONSTRAINT IF EXISTS price_validation_rules_city_category_competition_key;

ALTER TABLE price_validation_rules
  ADD CONSTRAINT price_validation_rules_country_city_category_competition_key
  UNIQUE (country, city, category, competition);

CREATE INDEX IF NOT EXISTS idx_price_validation_rules_country_city
  ON price_validation_rules(country, city);


-- ── 7. rush_hour_windows ────────────────────────────────────
ALTER TABLE rush_hour_windows
  ADD COLUMN IF NOT EXISTS country text NOT NULL DEFAULT 'Peru';

ALTER TABLE rush_hour_windows
  DROP CONSTRAINT IF EXISTS rush_hour_windows_city_start_time_end_time_key;

ALTER TABLE rush_hour_windows
  ADD CONSTRAINT rush_hour_windows_country_city_start_time_end_time_key
  UNIQUE (country, city, start_time, end_time);

CREATE INDEX IF NOT EXISTS idx_rush_hour_windows_country_city
  ON rush_hour_windows(country, city);


-- ── Verificación ─────────────────────────────────────────────
-- Ejecutar para confirmar que todas las columnas existen:
/*
SELECT table_name, column_name, column_default, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND column_name = 'country'
  AND table_name IN (
    'distance_thresholds', 'bracket_weights', 'distance_references',
    'indrive_config', 'upload_batches', 'price_validation_rules',
    'rush_hour_windows',
    -- ya tenían country (migración 17):
    'pricing_observations', 'market_events', 'ci_sessions',
    'competitor_commissions', 'competitor_bonuses', 'earnings_scenarios'
  )
ORDER BY table_name;
*/
