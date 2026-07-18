-- ════════════════════════════════════════════════════════════════════════
-- LOCAL-ONLY VARIANT of supabase/36_bot_fdw_pipeline.sql (Fase 0, workflow
-- local). El archivo original queda intacto como registro histórico real
-- de producción — este vive solo en supabase/migrations/ (CLI local) y
-- nunca se aplica contra producción.
--
-- El original conecta vía postgres_fdw a un host externo (fudobi.helioho.st)
-- con un password que nunca se commitea (placeholder __FUDOBI_PASSWORD__,
-- reemplazado a mano solo al correrlo contra producción vía SQL Editor).
-- Un replay local no tiene esas credenciales, y este pipeline FDW ya es
-- legacy — el mecanismo real de sync en producción es el Edge Function
-- sync-bot-quotes/index.ts + bot_sync_push.py, no este FDW.
--
-- En vez del foreign table real, se crea una tabla local vacía con el
-- mismo shape que bot_quotes_remote tiene hoy en producción (columnas
-- verificadas vía information_schema en vivo), para que cualquier
-- función/vista que la referencie más adelante en el replay siga
-- compilando igual.
-- ════════════════════════════════════════════════════════════════════════

DROP TABLE IF EXISTS bot_quotes_remote CASCADE;

CREATE TABLE bot_quotes_remote (
  id                        bigint,
  timestamp_utc             timestamptz,
  timestamp_local           timestamptz,
  timezone                  text,
  run_id                    text,
  app                       text,
  country                   text,
  city                      text,
  start_address             text,
  end_address               text,
  observed_start_address    text,
  observed_end_address      text,
  distance_bracket          text,
  main_category             text,
  vehicle_category          text,
  observed_vehicle_category text,
  estimated_eta_text        text,
  eta_mins                  numeric,
  price_regular_value       numeric,
  price_discounted_value    numeric,
  currency                  text,
  surge                     boolean,
  status                    text,
  error                     text,
  device_name               text,
  start_latitude            text,
  start_longitude           text,
  end_latitude              text,
  end_longitude             text,
  zone                      text,
  business_unit             text
);

GRANT SELECT ON bot_quotes_remote TO authenticated, service_role;

COMMENT ON TABLE bot_quotes_remote IS
  'LOCAL STUB (Fase 0) — en producción es un foreign table via postgres_fdw hacia fudobi.helioho.st. Acá es una tabla real y vacía con el mismo shape, solo para que el schema replay local compile. No se usa para sync real en local.';
