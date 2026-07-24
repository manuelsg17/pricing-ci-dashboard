-- ════════════════════════════════════════════════════════════════════════
-- 162_cron_io_diet.sql — recalibrar los jobs de pg_cron para dejar de
-- quemar el presupuesto de Disk IO del compute Micro.
--
-- Contexto (2026-07-24): Supabase venía avisando "Project is using its
-- Disk IO budget and may become unresponsive if fully consumed", con swap
-- en uso constante. Diagnóstico con pg_stat_statements en prod:
--
--   - refresh-mv-weekly corría CADA 15 MINUTOS, 24/7 (96 veces/día).
--     Cada corrida: ~31s, escaneo completo de pricing_observations
--     (888 MB, ya no cabe en la RAM de 1 GB del Micro) + ~210 MB de
--     archivos temporales. Acumulado histórico: 1.095 corridas, 13+ horas
--     de ejecución, ~400 GB leídos de disco. El requisito real del
--     negocio siempre fue "frescura ≤ 1 hora" (ver mig 105/106) — 4x/hora
--     era puro desperdicio.
--   - reconcile-indrive-bot-prices corría CADA 10 MINUTOS (144/día, ~9s
--     c/u) para reconciliar data que el bot ingesta UNA VEZ POR HORA
--     (GitHub Actions bot-sync). 6x más frecuente que la fuente.
--   - refresh-mv-competitive-bands (v_yango_rival_diff_mv, 207 MB):
--     ~78s y ~1.1 GB de spill temporal POR CORRIDA, cada hora.
--   - Todos corrían de madrugada, cuando ningún hub ni analista mira el
--     dashboard (equipo opera en horario Lima).
--
-- CAMBIOS (los 5 jobs ya existen; cron.schedule con el mismo jobname
-- actualiza el schedule sin duplicar):
--   1. Todo pasa a frecuencia HORARIA como máximo — cumple el "≤1h".
--   2. Ventana nocturna: sin corridas de 23:00 a 05:59 hora Lima
--      (04:00–10:59 UTC). Primera corrida de la mañana ≈ 06:07–06:35
--      Lima, antes de que los hubs arranquen. La data del bot acumulada
--      de madrugada aparece en esa primera corrida.
--
-- Horas en UTC (Lima = UTC-5): activo 11-23 UTC (06:00–18:59 Lima) y
-- 0-3 UTC (19:00–22:59 Lima). Reducción total estimada de IO: ~75-80%
-- (weekly 96→18 corridas/día, reconcile 144→18, resto 24→18).
--
-- Qué NO cambia: las MVs, sus definiciones, los RPCs _fast que las leen,
-- y la ingesta del bot (GitHub Actions) siguen exactamente igual.
-- Un admin siempre puede forzar un refresh fuera de horario vía MCP
-- (SELECT refresh_dashboard_mv()) si hace falta.
-- ════════════════════════════════════════════════════════════════════════

SELECT cron.schedule(
  'refresh-mv-weekly',
  '12 0-3,11-23 * * *',
  'REFRESH MATERIALIZED VIEW CONCURRENTLY public.v_bracket_weekly_avg_mv'
);

SELECT cron.schedule(
  'refresh-mv-daily',
  '7 0-3,11-23 * * *',
  'REFRESH MATERIALIZED VIEW CONCURRENTLY public.v_bracket_daily_avg_mv'
);

SELECT cron.schedule(
  'refresh-mv-botvsmanual',
  '9 0-3,11-23 * * *',
  'REFRESH MATERIALIZED VIEW CONCURRENTLY public.v_bot_vs_manual_mv'
);

-- A las :35 para caer DESPUÉS del bot-sync horario de GitHub Actions —
-- reconciliar antes de que llegue la tanda nueva sería trabajar dos veces.
SELECT cron.schedule(
  'reconcile-indrive-bot-prices',
  '35 0-3,11-23 * * *',
  'SELECT public.reconcile_indrive_bot_prices()'
);

SELECT cron.schedule(
  'refresh-mv-competitive-bands',
  '20 0-3,11-23 * * *',
  'REFRESH MATERIALIZED VIEW CONCURRENTLY public.v_yango_rival_diff_mv'
);
