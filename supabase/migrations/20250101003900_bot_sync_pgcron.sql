-- ════════════════════════════════════════════════════════════════════════
-- LOCAL-ONLY VARIANT of supabase/39_bot_sync_pgcron.sql (Fase 0).
-- Agrega CREATE EXTENSION pg_cron (no viene habilitada de entrada en el
-- Postgres local del CLI, a diferencia del Supabase hosteado). El resto
-- de las 9 migraciones que usan cron.* más adelante en el replay dependen
-- de que esto exista — sin esto fallarían todas, no solo esta.
-- ════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pg_cron;

SELECT cron.unschedule('sync-bot-quotes-peru')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sync-bot-quotes-peru');

SELECT cron.schedule(
  'sync-bot-quotes-peru',
  '*/5 * * * *',
  $$ SELECT sync_bot_quotes('Peru', 50000); $$
);
