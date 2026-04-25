-- ════════════════════════════════════════════════════════════════════════
-- Migración 39 — pg_cron: sync_bot_quotes() automático cada 5 min
--
-- OPCIONAL — ejecutar SOLO después de que la migración 38 haya corrido
-- exitosamente al menos una vez en modo manual.
--
-- pg_cron viene habilitado por default en Supabase. Si por alguna razón
-- no lo está, primero: CREATE EXTENSION IF NOT EXISTS pg_cron;
-- ════════════════════════════════════════════════════════════════════════

-- Eliminar job previo si existe
SELECT cron.unschedule('sync-bot-quotes-peru')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'sync-bot-quotes-peru');

-- Programar cada 5 min
SELECT cron.schedule(
  'sync-bot-quotes-peru',
  '*/5 * * * *',
  $$ SELECT sync_bot_quotes('Peru', 50000); $$
);

-- Para inspeccionar:
--   SELECT * FROM cron.job;
--   SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;
--
-- Para pausar:
--   SELECT cron.unschedule('sync-bot-quotes-peru');
