-- ══════════════════════════════════════════════════════════════════════
-- Migration 17: Add country column to pricing_observations
-- Enables multi-country support.
-- ══════════════════════════════════════════════════════════════════════

-- Add country column (defaults to 'Peru' for all existing rows)
ALTER TABLE pricing_observations
  ADD COLUMN IF NOT EXISTS country text NOT NULL DEFAULT 'Peru';

-- Backfill existing rows
UPDATE pricing_observations SET country = 'Peru' WHERE country IS NULL OR country = '';

-- Index for efficient per-country queries
CREATE INDEX IF NOT EXISTS pricing_observations_country     ON pricing_observations(country);
CREATE INDEX IF NOT EXISTS pricing_observations_country_city ON pricing_observations(country, city);

-- Also update ci_sessions if it exists
ALTER TABLE ci_sessions ADD COLUMN IF NOT EXISTS country text NOT NULL DEFAULT 'Peru';
UPDATE ci_sessions SET country = 'Peru' WHERE country IS NULL OR country = '';

-- Also update market_events if it exists
ALTER TABLE market_events ADD COLUMN IF NOT EXISTS country text NOT NULL DEFAULT 'Peru';
UPDATE market_events SET country = 'Peru' WHERE country IS NULL OR country = '';

-- Also update competitor_commissions
ALTER TABLE competitor_commissions ADD COLUMN IF NOT EXISTS country text NOT NULL DEFAULT 'Peru';
UPDATE competitor_commissions SET country = 'Peru' WHERE country IS NULL OR country = '';

-- Also update competitor_bonuses
ALTER TABLE competitor_bonuses ADD COLUMN IF NOT EXISTS country text NOT NULL DEFAULT 'Peru';
UPDATE competitor_bonuses SET country = 'Peru' WHERE country IS NULL OR country = '';

-- Also update earnings_scenarios
ALTER TABLE earnings_scenarios ADD COLUMN IF NOT EXISTS country text NOT NULL DEFAULT 'Peru';
UPDATE earnings_scenarios SET country = 'Peru' WHERE country IS NULL OR country = '';
