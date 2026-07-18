-- 119 — Desacoplar el refresh de las MV del dashboard + subir el budget del cron.
--
-- PROBLEMA (dashboard mostrando data congelada):
--   El cron 'refresh-dashboard-mv' corría `SELECT refresh_dashboard_mv()`, que
--   refresca las 3 MV (weekly, daily, bot_vs_manual) en UNA sola transacción.
--   El REFRESH de la MV DIARIA excede el statement_timeout (2min del rol postgres)
--   y, al ser una función (transacción única), su fallo hacía ROLLBACK de TODO —
--   incluida la weekly, que alimenta el dashboard. Resultado: NINGUNA MV se
--   actualizaba (badge/WA congelados; p.ej. W27 Lima Eco Yango MV=78 vs crudo=2515).
--   Además, statement_timeout se ARMA al inicio del statement externo con el default
--   de la sesión; el `SET statement_timeout='600s'` DENTRO de la función NO re-arma
--   ese timer, por eso nunca tuvo efecto (el cron moría siempre a los 120s).
--
-- FIX:
--   (1) Subir el statement_timeout a nivel del rol que corre el cron (postgres),
--       para que cada statement del cron se arme con 600s. No afecta la app:
--       authenticated/anon conservan sus 8s/3s.
--   (2) Separar el job combinado en jobs INDEPENDIENTES — cada REFRESH es su propio
--       statement/transacción, así una MV lenta o fallida ya no tumba a las otras.
--       CONCURRENTLY = no bloquea lecturas del dashboard. La weekly (rápida) corre
--       cada 15 min para mantener el dashboard fresco.

-- (1) budget del cron
ALTER ROLE postgres SET statement_timeout = '600s';

-- (2) baja el job combinado viejo y cualquier job nuevo previo (idempotente al re-correr)
SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname IN (
  'refresh-dashboard-mv',
  'refresh-mv-weekly',
  'refresh-mv-daily',
  'refresh-mv-botvsmanual'
);

-- (3) jobs independientes por MV (horarios sin solaparse)
SELECT cron.schedule('refresh-mv-weekly',      '*/15 * * * *',
  $$REFRESH MATERIALIZED VIEW CONCURRENTLY public.v_bracket_weekly_avg_mv$$);
SELECT cron.schedule('refresh-mv-daily',       '7 * * * *',
  $$REFRESH MATERIALIZED VIEW CONCURRENTLY public.v_bracket_daily_avg_mv$$);
SELECT cron.schedule('refresh-mv-botvsmanual', '9 * * * *',
  $$REFRESH MATERIALIZED VIEW CONCURRENTLY public.v_bot_vs_manual_mv$$);
