-- ════════════════════════════════════════════════════════════════════════
-- Migración 87 — Índices del hot path de pricing_observations
--
-- CONTEXTO:
--   Auditoría de performance (2026-05-24) identificó 3 índices faltantes
--   con HIGH impact en el hot path del dashboard:
--
--     1. get_indrive_summary/weekly/counts filtran por
--        (country, competition_name='InDrive', data_source='manual').
--        Ninguno de los índices existentes lidera con esta combinación —
--        seq scan o uso débil de idx_po_competitor.
--
--     2. apply_indrive_bot_prices + el nuevo trigger de mig 86 hacen join
--        de pricing_observations (InDrive bot) con indrive_config sobre
--        (country, city, category). El índice country_city_cat_bracket
--        existente arrastra rows manual+yango+etc.
--
--     3. get_bot_vs_hubs_summary filtra (country, data_source IN
--        ('manual','bot')) y agrupa por city/category. Sin índice
--        compuesto adecuado.
--
-- DISEÑO:
--   - Índices PARCIALES con WHERE para minimizar tamaño y costo de
--     mantenimiento. InDrive-only / bot-only / manual-only según el caso.
--   - CONCURRENTLY no usado para mantener atomicidad de la transacción
--     (Supabase aplica migraciones en bloque). Si en producción molesta
--     el lock corto, partir cada CREATE INDEX en una mig propia.
--
-- VERIFICACIÓN DE IMPACTO:
--   Antes / después: EXPLAIN ANALYZE las queries críticas y comparar.
--   Esperamos: bitmap heap scan → index only scan, latencia ~10x menor.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. InDrive + manual: get_indrive_* family ──────────────────────────
CREATE INDEX IF NOT EXISTS idx_po_indrive_manual
  ON pricing_observations (country, city, category)
  WHERE competition_name = 'InDrive' AND data_source = 'manual';

COMMENT ON INDEX idx_po_indrive_manual IS
  'Hot path: get_indrive_summary/weekly/counts. Partial index InDrive+manual reduce tamaño 90%+ vs índice completo.';

-- ── 2. InDrive + bot: apply_indrive_bot_prices + trigger mig 86 ───────
CREATE INDEX IF NOT EXISTS idx_po_indrive_bot
  ON pricing_observations (country, city, category)
  WHERE competition_name = 'InDrive' AND data_source = 'bot';

COMMENT ON INDEX idx_po_indrive_bot IS
  'Hot path: trigger trg_indrive_config_propagate (mig 86) y RPC apply_indrive_bot_prices (mig 73/75). Partial index acelera join con indrive_config.';

-- ── 3. country + data_source: get_bot_vs_hubs_summary ──────────────────
CREATE INDEX IF NOT EXISTS idx_po_country_source
  ON pricing_observations (country, data_source, city, category);

COMMENT ON INDEX idx_po_country_source IS
  'Hot path: get_bot_vs_hubs_summary agrupa por (country, data_source, city, category). Subsume idx_po_source (mig 07) que puede dropearse en una mig posterior si se confirma sin uso.';

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN POST-APLICACIÓN
--
-- 1. Verificar que los 3 índices se crearon:
--    SELECT indexname FROM pg_indexes
--    WHERE tablename = 'pricing_observations'
--      AND indexname IN ('idx_po_indrive_manual','idx_po_indrive_bot','idx_po_country_source');
--    → 3 filas.
--
-- 2. Sample EXPLAIN para confirmar uso:
--    EXPLAIN (ANALYZE, BUFFERS)
--    SELECT * FROM get_indrive_summary('Peru', 100);
--    → debe mostrar "Index Scan using idx_po_indrive_manual"
--      o "Bitmap Index Scan on idx_po_indrive_manual".
--
-- 3. Tamaños:
--    SELECT pg_size_pretty(pg_relation_size(indexrelid)) AS size, indexrelname
--    FROM pg_stat_user_indexes
--    WHERE relname = 'pricing_observations'
--      AND indexrelname LIKE 'idx_po_indrive%' OR indexrelname = 'idx_po_country_source';
--
-- FOLLOW-UP MIG SUGERIDA (no incluida acá para mantener este atómico):
--   Drop indexes que ahora son redundantes:
--     - idx_po_category (single-col, cubierto por composites)
--     - idx_po_bracket  (single-col)
--     - pricing_observations_country (single-col)
--     - idx_po_source (cubierto por idx_po_country_source)
-- ════════════════════════════════════════════════════════════════════════
