-- ============================================================================
-- Migración 29: Índices compuestos para queries multi-país
-- ============================================================================
-- Las RPCs get_dashboard_data_weekly/daily filtran por (country, city, category)
-- y agrupan por bracket. Los índices actuales cubren (country, city) y
-- (city, year, week) — faltan compuestos para el patrón de acceso real.
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_po_country_city_cat_bracket
  ON pricing_observations(country, city, category, distance_bracket);

CREATE INDEX IF NOT EXISTS idx_po_country_date
  ON pricing_observations(country, observed_date);

CREATE INDEX IF NOT EXISTS idx_market_events_country_city_date
  ON market_events(country, city, event_date);
