-- ============================================================
-- MIGRACIÓN 15: Anotaciones / Eventos de mercado
-- Ejecutar en Supabase SQL Editor
-- ============================================================

CREATE TABLE IF NOT EXISTS market_events (
  id           serial PRIMARY KEY,
  city         text NOT NULL,
  event_date   date NOT NULL,
  event_type   text NOT NULL
    CHECK (event_type IN ('huelga','lluvia','feriado','promo_competidor','regulacion','otro')),
  description  text NOT NULL,
  impact       text NOT NULL CHECK (impact IN ('alto','medio','bajo')),
  user_email   text,
  created_at   timestamptz DEFAULT now()
);

ALTER TABLE market_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_all" ON market_events
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS market_events_city_date
  ON market_events(city, event_date);

SELECT * FROM market_events ORDER BY event_date DESC LIMIT 10;
