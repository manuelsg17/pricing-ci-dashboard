-- ============================================================
-- MIGRACIÓN 14: Escenarios de ganancias del conductor
-- Ejecutar en Supabase SQL Editor
-- ============================================================

CREATE TABLE IF NOT EXISTS earnings_scenarios (
  id               serial PRIMARY KEY,
  city             text NOT NULL,
  category         text NOT NULL,
  ref_year         int NOT NULL,
  ref_week         int NOT NULL,
  trip_scale       jsonb NOT NULL,     -- array de ints: [10,20,30,40,50]
  hours_per_week   numeric,
  avg_prices       jsonb NOT NULL,     -- { "Yango": 12.50, "Uber": 14.00, ... }
  commissions      jsonb NOT NULL,     -- { "Yango": 20, "Uber": 25, ... }
  bonuses          jsonb NOT NULL,     -- [ { competitor, type, threshold, amount, description } ]
  results          jsonb NOT NULL,     -- { "Yango": { "10": 100.0, "20": 200.0 }, ... }
  notes            text,
  user_email       text,
  created_at       timestamptz DEFAULT now()
);

ALTER TABLE earnings_scenarios ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_all" ON earnings_scenarios
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

SELECT * FROM earnings_scenarios ORDER BY created_at DESC LIMIT 5;
