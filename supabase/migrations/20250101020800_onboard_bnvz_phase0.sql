-- ════════════════════════════════════════════════════════════════════════
-- Migración 129 — Onboarding Fase 0: Bolivia, Nepal, Venezuela, Zambia
--
-- CONTEXTO: los 4 países ya existían como plantilla hardcodeada en
-- constants.js (1 ciudad, categoría "Economy", competidores Yango+InDrive)
-- pero con 0 filas en DB. Esta migración replica EXACTAMENTE lo que
-- CountryWizard.jsx → handleFinish() escribe en sus pasos 1-6 (Identidad,
-- Moneda, Ciudades, Categorías, Competidores, Pesos) para las 4 — status
-- queda en 'draft' (invisible en el selector global y en la matriz del
-- cron de bot-sync hasta activarlo a mano).
--
-- DELIBERADAMENTE NO se siembra bot_rules (tabla SQL) acá — esa es la
-- Fase 1 del plan de onboarding, que requiere datos reales del bot
-- (probe) antes de adivinar app/vc/ovc por país, en vez de copiar a
-- ciegas la plantilla de Perú.
--
-- Fuente de los valores outlier_threshold/max_price/locale:
--   - Nepal/Bolivia/Zambia: preset de moneda del wizard (CURRENCY_PRESETS
--     en CountryWizard.jsx) — para Nepal se validó contra tarifas reales
--     de Kathmandu en la conversación previa (rango típico 150-1500 NPR).
--   - Venezuela: se preservan los valores hardcodeados de constants.js
--     (outlier=10, max=100 USD) en vez del preset genérico de USD
--     (100/1000) — Venezuela cobra en USD pero en una economía informal
--     donde una tarifa de $100 sería casi con certeza un error de data,
--     no un viaje real premium. Mismo criterio para el locale (es-VE, no
--     el en-US que traería el preset de USD por default).
--   Estos 4 números son punto de partida — revisar contra data real de
--   cada país apenas empiece a fluir (Fase 1 en adelante).
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. country_config ──────────────────────────────────────────────────
INSERT INTO country_config
  (country_key, label, currency, locale, iso2, native_label,
   outlier_threshold, max_price, status, sort_order, cities)
VALUES
  ('Nepal', 'Nepal', 'NPR', 'ne-NP', 'NP', 'नेपाल', 5000, 20000, 'draft', 3,
   '[{"uiName":"Kathmandu","dbName":"Kathmandu","botKey":"kathmandu","isVirtual":false,
      "categories":[{"name":"Economy","dbName":"Economy","competitors":["Yango","InDrive"],"yangoDisplayName":"Yango"}]}]'::jsonb),
  ('Bolivia', 'Bolivia', 'BOB', 'es-BO', 'BO', 'Bolivia', 500, 2000, 'draft', 4,
   '[{"uiName":"Santa Cruz","dbName":"Santa Cruz","botKey":"santa_cruz","isVirtual":false,
      "categories":[{"name":"Economy","dbName":"Economy","competitors":["Yango","InDrive"],"yangoDisplayName":"Yango"}]}]'::jsonb),
  ('Venezuela', 'Venezuela', 'USD', 'es-VE', 'VE', 'Venezuela', 10, 100, 'draft', 5,
   '[{"uiName":"Caracas","dbName":"Caracas","botKey":"caracas","isVirtual":false,
      "categories":[{"name":"Economy","dbName":"Economy","competitors":["Yango","InDrive"],"yangoDisplayName":"Yango"}]}]'::jsonb),
  ('Zambia', 'Zambia', 'ZMW', 'en-ZM', 'ZM', 'Zambia', 500, 2000, 'draft', 6,
   '[{"uiName":"Lusaka","dbName":"Lusaka","botKey":"lusaka","isVirtual":false,
      "categories":[{"name":"Economy","dbName":"Economy","competitors":["Yango","InDrive"],"yangoDisplayName":"Yango"}]}]'::jsonb)
ON CONFLICT (country_key) DO UPDATE SET
  label = EXCLUDED.label, currency = EXCLUDED.currency, locale = EXCLUDED.locale,
  iso2 = EXCLUDED.iso2, native_label = EXCLUDED.native_label,
  outlier_threshold = EXCLUDED.outlier_threshold, max_price = EXCLUDED.max_price,
  sort_order = EXCLUDED.sort_order, cities = EXCLUDED.cities;

-- ── 2. bracket_weights (mismos pesos default para las 4, city='all') ────
INSERT INTO bracket_weights (country, city, category, bracket, weight)
SELECT c.country, 'all', 'all', w.bracket, w.weight
FROM (VALUES ('Nepal'), ('Bolivia'), ('Venezuela'), ('Zambia')) AS c(country)
CROSS JOIN (VALUES
  ('very_short', 0.0983), ('short', 0.1967), ('median', 0.1939),
  ('average', 0.1384), ('long', 0.075), ('very_long', 0.297)
) AS w(bracket, weight)
ON CONFLICT (country, city, category, bracket) DO UPDATE SET weight = EXCLUDED.weight;

-- ── 3. distance_thresholds (misma escala km para las 4 — no depende de
--       moneda/país, mismo criterio que el wizard) ─────────────────────
INSERT INTO distance_thresholds (country, city, category, bracket, max_km)
SELECT city_map.country, city_map.city, 'Economy', b.bracket, b.max_km
FROM (VALUES
  ('Nepal', 'Kathmandu'), ('Bolivia', 'Santa Cruz'),
  ('Venezuela', 'Caracas'), ('Zambia', 'Lusaka')
) AS city_map(country, city)
CROSS JOIN (VALUES
  ('very_short', 2::numeric), ('short', 4), ('median', 6),
  ('average', 8), ('long', 10), ('very_long', NULL)
) AS b(bracket, max_km)
ON CONFLICT (country, city, category, bracket) DO UPDATE SET max_km = EXCLUDED.max_km;

-- ── 4. price_validation_rules (tope país = max_price * 3, ver wizard) ──
INSERT INTO price_validation_rules (country, city, category, competition, max_price)
VALUES
  ('Nepal',     'all', 'all', 'all', 20000 * 3),
  ('Bolivia',   'all', 'all', 'all', 2000 * 3),
  ('Venezuela', 'all', 'all', 'all', 100 * 3),
  ('Zambia',    'all', 'all', 'all', 2000 * 3)
ON CONFLICT (country, city, category, competition) DO UPDATE SET max_price = EXCLUDED.max_price;

-- ── 5. semaforo_config (bandas default, solo si el país no tiene filas
--       previas — mismo guard que el wizard) ──────────────────────────
INSERT INTO semaforo_config (country, band, min_pct, max_pct, note)
SELECT c.country, s.band, s.min_pct, s.max_pct, s.note
FROM (VALUES ('Nepal'), ('Bolivia'), ('Venezuela'), ('Zambia')) AS c(country)
CROSS JOIN (VALUES
  ('green',  5::numeric,   10::numeric,  'Yango competitivo'),
  ('yellow', 1,            5,            'Cerca pero por debajo'),
  ('yellow', 10,           12,           'Cerca pero por arriba'),
  ('red',    NULL,         1,            'Yango muy bajo vs mercado'),
  ('red',    12,           NULL,         'Yango muy alto vs mercado')
) AS s(band, min_pct, max_pct, note)
WHERE NOT EXISTS (
  SELECT 1 FROM semaforo_config existing WHERE existing.country = c.country
);

-- ── 6. rush_hour_windows (ventanas estándar 07-09 / 17-20) ─────────────
INSERT INTO rush_hour_windows (country, city, start_time, end_time, label)
SELECT city_map.country, city_map.city, w.start_time, w.end_time, w.label
FROM (VALUES
  ('Nepal', 'Kathmandu'), ('Bolivia', 'Santa Cruz'),
  ('Venezuela', 'Caracas'), ('Zambia', 'Lusaka')
) AS city_map(country, city)
CROSS JOIN (VALUES
  ('07:00'::time, '09:00'::time, 'Mañana'),
  ('17:00'::time, '20:00'::time, 'Tarde')
) AS w(start_time, end_time, label)
ON CONFLICT (country, city, start_time, end_time) DO UPDATE SET label = EXCLUDED.label;

-- ── 7. indrive_config (adjustment_pct=0 de punto de partida) ───────────
INSERT INTO indrive_config (country, city, category, adjustment_pct)
VALUES
  ('Nepal', 'Kathmandu', 'Economy', 0),
  ('Bolivia', 'Santa Cruz', 'Economy', 0),
  ('Venezuela', 'Caracas', 'Economy', 0),
  ('Zambia', 'Lusaka', 'Economy', 0)
ON CONFLICT (country, city, category) DO UPDATE SET adjustment_pct = EXCLUDED.adjustment_pct;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN:
--   SELECT * FROM validate_country_setup('Nepal');
--   SELECT * FROM validate_country_setup('Bolivia');
--   SELECT * FROM validate_country_setup('Venezuela');
--   SELECT * FROM validate_country_setup('Zambia');
--   → se espera warning (no error) en bot_rules (Fase 1, todavía no
--     sembrada) y ok/warning razonable en el resto.
-- ════════════════════════════════════════════════════════════════════════
