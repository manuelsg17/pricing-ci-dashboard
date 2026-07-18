-- ════════════════════════════════════════════════════════════════════════
-- LOCAL-ONLY, sin equivalente en supabase/*.sql (Fase 0, hallazgo real).
--
-- `country_config` nunca tiene un CREATE TABLE en ningún archivo de
-- supabase/ — la migración 57 ya la ALTERea como si existiera. Confirmado
-- contra producción: la tabla real SÍ existe (con PK country_key +
-- CHECK status), pero se creó fuera del historial de migraciones (muy
-- probablemente a mano en el SQL Editor / Table Editor de Supabase en su
-- momento). Este archivo reconstruye el shape que la migración 57 espera
-- encontrar ya creado, para que el replay local no se corte acá. Nunca se
-- aplica a producción — ahí la tabla ya existe.
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS country_config (
  country_key       text PRIMARY KEY,
  label             text NOT NULL,
  currency          text NOT NULL DEFAULT 'USD',
  locale            text NOT NULL DEFAULT 'en-US',
  outlier_threshold numeric NOT NULL DEFAULT 100,
  max_price         numeric NOT NULL DEFAULT 1000,
  sort_order        integer NOT NULL DEFAULT 0,
  cities            jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at        timestamptz DEFAULT now()
);

ALTER TABLE country_config ENABLE ROW LEVEL SECURITY;
