-- ════════════════════════════════════════════════════════════════════════
-- Migración 98 — Storage cleanup phase 1
--
-- CONTEXTO 2026-05-29:
--   DB total: 485 MB (Supabase free = 500 MB — peligrosamente cerca)
--   pricing_observations: 470 MB (97% del total)
--     · heap: 275 MB
--     · índices: 195 MB
--   Dead tuples: 23,449 / 695,494 = 3.26% (bloat moderado)
--
--   Auditoría identifica:
--     · 5 columnas con >99% NULL (espacio desperdiciado en headers)
--     · 1 índice con 0 scans (sin uso real)
--     · 1 índice de 12 MB con uso marginal (subsumido)
--     · Logs viejos en bot_sync_log
--
-- QUÉ HACE:
--   A) DROP 5 columnas casi 100% NULL en pricing_observations
--   B) DROP 2 índices (sin uso + redundante)
--   C) DELETE bot_sync_log > 30d con status='ok'
--   D) Pasos de ANALYZE para refrescar estadísticas
--
-- LO QUE NO HACE (para mig 99 posterior, ventana baja):
--   - VACUUM FULL (lock AccessExclusive ~3-5 min)
--   - Compresión LZ4 en point_a/point_b
--   - Archive de filas < 2026-01-01 a tabla fría
--   - Particionado declarativo (refactor mayor)
--
-- IMPACTO ESTIMADO: 80-150 MB liberados sin downtime perceptible.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── (A) DROP 5 columnas casi 100% NULL ─────────────────────────────────
--
-- Verificación defensiva: el DROP solo se aplica si la columna existe.
-- Si querés re-correr la mig en otro entorno, es idempotente.

-- ⚠ POST-MORTEM 2026-05-30:
--   DROP COLUMN bid_4/bid_5 con CASCADE cascadeó a v_effective_price
--   (la vista las referenciaba en el cálculo de bids InDrive), lo cual
--   cascadeó a v_bracket_*_avg y a las funciones get_dashboard_data_*.
--   Resultado: Dashboard tirando 404 hasta aplicar mig 99 que re-crea
--   las vistas SIN bid_4/bid_5 + restaura las RPCs.
--   Para fresh deploys: aplicar mig 99 INMEDIATAMENTE DESPUÉS de mig 98.

DO $drop_cols$
DECLARE
  col text;
  cols_to_drop text[] := ARRAY[
    'for_pivot',        -- 100% NULL, 0 refs en código
    'bid_4',            -- 99.84% NULL — ⚠ cascadea v_effective_price (ver mig 99)
    'bid_5',            -- 99.94% NULL — ⚠ idem
    'discount_offer',   -- 99.92% NULL
    'diff'              -- 99.91% NULL
  ];
BEGIN
  FOREACH col IN ARRAY cols_to_drop LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'pricing_observations'
        AND column_name = col
    ) THEN
      EXECUTE format('ALTER TABLE pricing_observations DROP COLUMN %I CASCADE', col);
      RAISE NOTICE '[mig 98] DROP column pricing_observations.% OK', col;
    ELSE
      RAISE NOTICE '[mig 98] Skip column % (no existe)', col;
    END IF;
  END LOOP;
END
$drop_cols$;

-- ── (B) DROP 2 índices: 1 sin uso + 1 redundante ───────────────────────
--
-- idx_po_indrive_manual (mig 87): 0 scans desde último reset.
--   Era preventivo para queries que filtran InDrive+manual, pero
--   en la práctica los queries usan composites más amplios.
--
-- pricing_observations_country_city (mig 17): 29 scans, subsumido por
--   idx_po_country_city_cat_bracket (mig 29) y idx_po_country_source (mig 87).

DROP INDEX IF EXISTS idx_po_indrive_manual;
DROP INDEX IF EXISTS pricing_observations_country_city;

-- ── (C) DELETE bot_sync_log antiguos con status='ok' ───────────────────
--
-- Mantenemos errores (status!='ok') indefinidamente para auditoría.
-- Los runs exitosos > 30 días no aportan valor diagnóstico.

DO $cleanup_logs$
DECLARE
  v_deleted bigint;
BEGIN
  WITH del AS (
    DELETE FROM bot_sync_log
    WHERE status = 'ok'
      AND started_at < now() - interval '30 days'
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_deleted FROM del;
  RAISE NOTICE '[mig 98] bot_sync_log: % filas con status=ok > 30 días eliminadas', v_deleted;
END
$cleanup_logs$;

COMMIT;

-- ── (D) ANALYZE para refrescar estadísticas del planner ────────────────
-- Fuera de la transacción (ANALYZE no requiere lock fuerte y es seguro).
ANALYZE pricing_observations;
ANALYZE bot_sync_log;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN POST-APLICACIÓN
--
-- 1. Tamaño después:
--    SELECT pg_size_pretty(pg_total_relation_size('pricing_observations')) AS total,
--           pg_size_pretty(pg_relation_size('pricing_observations'))       AS heap,
--           pg_size_pretty(pg_indexes_size('pricing_observations'))        AS idx;
--    → Esperado: -50 a -100 MB total vs antes.
--
-- 2. Columnas restantes:
--    SELECT column_name FROM information_schema.columns
--    WHERE table_name='pricing_observations' ORDER BY ordinal_position;
--    → Sin for_pivot, bid_4, bid_5, discount_offer, diff.
--
-- 3. DB total:
--    SELECT pg_size_pretty(pg_database_size(current_database()));
--    → Esperado: 380-420 MB (vs 485 MB antes).
--
-- 4. (OPCIONAL, después de la mig) Si querés reclamar todo el espacio
--    inmediatamente, correr en ventana baja:
--      VACUUM FULL pricing_observations;
--    Esto toma lock AccessExclusive por ~3-5 minutos. Reduce bloat al
--    mínimo. Después: ANALYZE pricing_observations;
-- ════════════════════════════════════════════════════════════════════════
