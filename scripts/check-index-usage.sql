-- ════════════════════════════════════════════════════════════════════════
-- check-index-usage.sql — uso real de los índices secundarios de las
-- particiones calientes y de las tablas agregadas.
--
-- PARA QUÉ: decidir con datos (no con intuición) qué índices dropear.
-- Cada índice se paga en CADA inserción del sync horario (~17-25k filas/día
-- en la partición del mes), así que un índice que no se usa es puro costo.
--
-- CÓMO SE USA (revisión de arquitectura 2026-09-03, punto #5):
--   1. Línea base tomada el 2026-09-03 → docs/index-usage-baseline-2026-09-03.md
--   2. Volver a correr esto el 2026-10-03 (un mes después) y comparar idx_scan.
--   3. Índices cuyo idx_scan no despegó en el mes → candidatos a DROP, con
--      una migración propia (y su espejo en supabase/migrations/).
--
-- OJO: pg_stat_user_indexes acumula desde el último reset de estadísticas
-- (ver pg_stat_statements_info.stats_reset / pg_stat_reset()). Comparar
-- SIEMPRE contra la línea base, no leer el número absoluto.
-- ════════════════════════════════════════════════════════════════════════
SELECT s.relname                                   AS tabla,
       s.indexrelname                              AS indice,
       s.idx_scan                                  AS usos,
       pg_size_pretty(pg_relation_size(s.indexrelid)) AS tamano,
       now()::date                                 AS medido_el
FROM pg_stat_user_indexes s
JOIN pg_index i ON i.indexrelid = s.indexrelid
WHERE s.schemaname = 'public'
  AND NOT i.indisunique AND NOT i.indisprimary
  AND (s.relname LIKE 'pricing_observations_20%' OR s.relname LIKE 'v_%_mv')
ORDER BY s.relname, s.idx_scan;
