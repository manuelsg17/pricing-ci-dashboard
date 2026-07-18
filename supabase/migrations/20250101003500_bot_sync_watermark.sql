-- ════════════════════════════════════════════════════════════════════════
-- Migración 35 — Watermark + log para la sincronización directa con la
-- BD del bot (fudobi.helioho.st / quotes_output).
--
-- Diseño:
--  • bot_sync_watermark: una fila por país. Guarda el último timestamp/id
--    procesado para no re-leer filas viejas en cada corrida.
--  • bot_sync_log:        bitácora de cada corrida (qué ingestó, cuántas
--    filas, errores) — útil para troubleshooting en /upload/bot-sync.
-- ════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS bot_sync_watermark (
  country         text PRIMARY KEY,
  last_synced_at  timestamptz NOT NULL DEFAULT '1970-01-01'::timestamptz,
  last_synced_id  bigint,                 -- por si quotes_output tiene un id incremental que es más fiable que un timestamp
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bot_sync_log (
  id            bigserial PRIMARY KEY,
  country       text NOT NULL,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  status        text NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running','ok','error','probe')),
  read_count    int NOT NULL DEFAULT 0,
  inserted_count int NOT NULL DEFAULT 0,
  dropped_count int NOT NULL DEFAULT 0,
  outlier_count int NOT NULL DEFAULT 0,
  error_msg     text,
  notes         jsonb
);

CREATE INDEX IF NOT EXISTS idx_bot_sync_log_country_started
  ON bot_sync_log (country, started_at DESC);

-- RLS — solo admins (servicio) pueden modificar; usuarios autenticados pueden leer
ALTER TABLE bot_sync_watermark ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_sync_log       ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated read watermark" ON bot_sync_watermark;
CREATE POLICY "Authenticated read watermark" ON bot_sync_watermark
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Authenticated read log" ON bot_sync_log;
CREATE POLICY "Authenticated read log" ON bot_sync_log
  FOR SELECT TO authenticated USING (true);

-- Las Edge Functions usan service_role y bypassan RLS automáticamente.

COMMENT ON TABLE bot_sync_watermark IS
  'Marca el último timestamp/id sincronizado desde la BD externa del bot. La Edge Function sync-bot-quotes lee y actualiza esta tabla.';
COMMENT ON TABLE bot_sync_log IS
  'Bitácora de corridas de sync-bot-quotes — visible en /upload/bot-sync para troubleshooting.';
