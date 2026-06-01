-- ════════════════════════════════════════════════════════════════════════
-- Migración 106 — pg_cron refresh horario de los MVs del dashboard
--
-- NOTA DE NUMERACIÓN:
--   Esta NO es la "mig 106 InDrive index + DEFAULT Peru" que el ROADMAP dejó
--   diferida. Esa sigue diferida; si algún día se hace, será la 107. El slot
--   106 quedó libre (nunca se creó) y lo usa este refresh job.
--
-- CONTEXTO:
--   Cutover de Mig 105: el dashboard pasa a leer get_dashboard_data_*_fast,
--   que leen de v_bracket_weekly_avg_mv / _daily_avg_mv. Un MATERIALIZED VIEW
--   solo refleja datos al momento del último REFRESH. La mig 105 dejó
--   refresh_dashboard_mv() definida pero el job programado quedó como TODO
--   ("no incluido — el operador decide cadencia"). Esta mig lo crea.
--
-- POR QUÉ pg_cron Y NO refresh desde el cliente:
--   El refresh completo cuesta ~70-120s (medido con EXPLAIN ANALYZE: weekly
--   ~54s + daily ~16s + overhead de CONCURRENTLY). El rol `authenticated`
--   (con el que el browser llama los RPC vía PostgREST) tiene
--   statement_timeout = 8s → un refresh disparado desde el cliente se
--   abortaría sin completar. pg_cron corre como superuser sin el pooler, sin
--   ese cap, así que completa.
--
-- CADENCIA:
--   1×/hora a los :10. El bot sync (GitHub Action bot-sync.yml) corre a los
--   :00; refrescar a los :10 captura su carga con margen. Los datos del bot
--   (fuente principal, con el precio InDrive ya calculado por el trigger
--   zz_indrive_price_before_insert) se ven ~10 min después de llegar.
--   Cargas manuales (Upload/DataEntry/re-sync InDrive/recompute thresholds)
--   se reflejan en la próxima corrida → ≤ 1h. REFRESH ... CONCURRENTLY no
--   bloquea lecturas, así que el dashboard sigue respondiendo durante el job.
--
-- VERIFICACIÓN:
--   SELECT jobid, schedule, command, active
--     FROM cron.job WHERE jobname = 'refresh-dashboard-mv';
--   -- tras el primer tick de :10:
--   SELECT status, return_message, start_time, end_time
--     FROM cron.job_run_details
--    WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'refresh-dashboard-mv')
--    ORDER BY start_time DESC LIMIT 5;
--
-- PREREQUISITO:
--   pg_cron disponible en Supabase (1.6.4) pero NO instalado de fábrica en
--   este proyecto. Si `create extension` falla por privilegios, habilitarlo
--   en Dashboard → Database → Extensions → pg_cron y re-correr el resto.
-- ════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Idempotente: si el job ya existe (re-corrida de la mig), lo reprograma.
SELECT cron.unschedule('refresh-dashboard-mv')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'refresh-dashboard-mv');

SELECT cron.schedule(
  'refresh-dashboard-mv',
  '10 * * * *',                              -- 1×/hora a los :10
  $$SELECT public.refresh_dashboard_mv();$$
);
