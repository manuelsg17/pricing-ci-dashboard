-- ════════════════════════════════════════════════════════════════════════
-- Migración 92 — Drop de índices redundantes en pricing_observations
--
-- CONTEXTO:
--   La mig 87 creó 3 índices compuestos en el hot path:
--     · idx_po_indrive_manual  (country, city, category) WHERE InDrive+manual
--     · idx_po_indrive_bot     (country, city, category) WHERE InDrive+bot
--     · idx_po_country_source  (country, data_source, city, category)
--
--   Adicionalmente ya existen desde migs anteriores:
--     · idx_po_city_cat_bracket           (city, category, distance_bracket)         — mig 01
--     · idx_po_country_city_cat_bracket   (country, city, category, distance_bracket)— mig 29
--     · pricing_observations_country_city (country, city)                            — mig 17
--
--   Con ese set, los 4 índices single-column listados abajo dejaron de tener
--   uso único: cualquier query que filtra por `category`, `distance_bracket`,
--   `country` o `data_source` se cubre con el prefijo de algún compuesto
--   existente (la columna líder de los nuevos índices es siempre `country`,
--   pero los compuestos de city/category también atrapan los filtros por
--   esas columnas).
--
-- QUÉ HACE:
--   Dropea 4 índices redundantes en pricing_observations:
--     1. idx_po_category              — subsumido por idx_po_city_cat_bracket,
--                                       idx_po_country_city_cat_bracket,
--                                       idx_po_indrive_manual/bot (todos llevan
--                                       `category` como columna no líder pero
--                                       el planner usa bitmap AND para queries
--                                       single-col cuando son selectivas).
--     2. idx_po_bracket               — subsumido por idx_po_city_cat_bracket
--                                       y idx_po_country_city_cat_bracket
--                                       (ambos llevan `distance_bracket` como
--                                       última columna; filtros por bracket
--                                       solo aparecen junto con city/category
--                                       en RPCs del dashboard).
--     3. pricing_observations_country — subsumido por idx_po_country_source
--                                       (country liderando) y por
--                                       pricing_observations_country_city
--                                       (mig 17, lidera con country).
--     4. idx_po_source                — subsumido por idx_po_country_source
--                                       (mig 87 ya lo documenta).
--
-- DEPENDE DE:
--   · Mig 87 aplicada (idx_po_country_source debe existir antes de dropear
--     idx_po_source / pricing_observations_country).
--   · Mig 90 aplicada (UNIQUE partial bot) — NO toca ninguno de los 4
--     candidatos.
--
-- SAFETY CHECKS (verificados en el repo antes de escribir esta mig):
--   · `pricing_observations` PK = `id` (bigserial). NINGUNO de los 4 índices
--     es PK ni respalda una UNIQUE constraint.
--   · No hay FK que referencie pricing_observations (grep -rn "REFERENCES
--     pricing_observations" supabase/ → vacío).
--   · No hay REPLICA IDENTITY USING INDEX configurada en ninguna mig.
--   · Ninguno es UNIQUE. El único UNIQUE en la tabla es el de la mig 90
--     (`uq_po_bot_natural_key`, partial bot), que NO está en la lista.
--
-- NOTA DE TRANSACCIÓN:
--   Originalmente esta mig usaba `DROP INDEX CONCURRENTLY` para evitar
--   AccessExclusive lock, pero Supabase SQL Editor envuelve TODO en una
--   transacción automática y PostgreSQL rechaza CONCURRENTLY dentro de
--   un BEGIN/COMMIT (error 25001). Cambiamos a `DROP INDEX` plano.
--
--   Impacto del lock: AccessExclusive sobre pricing_observations durante
--   el DROP. Para índices secundarios de columnas no-clave (sin tuplas
--   pendientes a limpiar) el DROP es prácticamente instantáneo (<100ms)
--   — un blip imperceptible que no debería afectar al sync ni al dashboard.
--
-- ROLLBACK:
--   Si algún query degrada tras este drop, recrear el índice puntual:
--     CREATE INDEX idx_po_category ON pricing_observations(category);
--   (idem para los otros). Los CREATE de las migs originales (01, 07, 17)
--   están versionados y se pueden re-ejecutar.
--
-- ESTIMACIÓN DE AHORRO (≈600k filas bot+manual a 2026-05):
--   · 4 índices btree single-col en columnas text de cardinalidad media
--   · ~30-50 bytes/entrada incluyendo TID y overhead → ~20-30 MB por índice
--   · Total esperado: 80-120 MB liberados, además de menor write amplification
--     en INSERT/UPDATE (4 índices menos que mantener por cada fila).
-- ════════════════════════════════════════════════════════════════════════

-- ── 1. idx_po_category — single-col en `category` (mig 01) ──────────────
DROP INDEX IF EXISTS idx_po_category;

-- ── 2. idx_po_bracket — single-col en `distance_bracket` (mig 01) ──────
DROP INDEX IF EXISTS idx_po_bracket;

-- ── 3. pricing_observations_country — single-col en `country` (mig 17) ─
--    Safety: confirmado NO PK (PK = `id`), NO UNIQUE, NO REPLICA IDENTITY.
DROP INDEX IF EXISTS pricing_observations_country;

-- ── 4. idx_po_source — single-col en `data_source` (mig 07) ────────────
--    Subsumido por idx_po_country_source (mig 87, country liderando +
--    data_source segunda columna).
DROP INDEX IF EXISTS idx_po_source;

-- ── Resumen via NOTICE ────────────────────────────────────────────────
DO $$
DECLARE
  remaining int;
BEGIN
  SELECT count(*) INTO remaining
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND tablename  = 'pricing_observations'
    AND indexname IN (
      'idx_po_category',
      'idx_po_bracket',
      'pricing_observations_country',
      'idx_po_source'
    );

  IF remaining = 0 THEN
    RAISE NOTICE 'Migración 92 OK: los 4 índices redundantes fueron dropeados.';
  ELSE
    RAISE WARNING 'Migración 92: quedan % índices candidatos sin dropear. Investigar.', remaining;
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN POST-APLICACIÓN
--
-- 1. Confirmar que los 4 índices ya no existen:
--    SELECT indexname FROM pg_indexes
--    WHERE tablename = 'pricing_observations'
--      AND indexname IN (
--        'idx_po_category',
--        'idx_po_bracket',
--        'pricing_observations_country',
--        'idx_po_source'
--      );
--    → 0 filas esperadas.
--
-- 2. Listar índices restantes en pricing_observations (sanity check):
--    SELECT indexname, indexdef
--    FROM pg_indexes
--    WHERE tablename = 'pricing_observations'
--    ORDER BY indexname;
--    → Debe incluir:
--        pricing_observations_pkey                 (PK en id)
--        idx_po_city_week                          (mig 01)
--        idx_po_competitor                         (mig 01)
--        idx_po_date                               (mig 01)
--        idx_po_city_cat_bracket                   (mig 01)
--        pricing_observations_country_city         (mig 17)
--        idx_po_country_city_cat_bracket           (mig 29)
--        idx_po_indrive_manual                     (mig 87, partial)
--        idx_po_indrive_bot                        (mig 87, partial)
--        idx_po_country_source                     (mig 87)
--        uq_po_bot_natural_key                     (mig 90, UNIQUE partial)
--      (más cualquier otro creado por migs intermedias — el listado completo
--       es referencial, no exhaustivo).
--
-- 3. Comparación de tamaño total de índices ANTES vs DESPUÉS:
--    -- Ejecutar ANTES de aplicar la mig y guardar el valor:
--    SELECT pg_size_pretty(
--             sum(pg_relation_size(indexrelid))
--           ) AS total_index_size
--    FROM pg_stat_user_indexes
--    WHERE relname = 'pricing_observations';
--
--    -- Repetir DESPUÉS. Esperar reducción de ~80-120 MB sobre ~600k filas.
--
-- 4. Desglose por índice (para confirmar qué desapareció):
--    SELECT indexrelname,
--           pg_size_pretty(pg_relation_size(indexrelid)) AS size,
--           idx_scan
--    FROM pg_stat_user_indexes
--    WHERE relname = 'pricing_observations'
--    ORDER BY pg_relation_size(indexrelid) DESC;
--
-- 5. Verificación de uso (pg_stat) — útil ANTES de aplicar para confirmar
--    que los 4 candidatos tenían `idx_scan = 0` o muy bajo respecto a los
--    composites:
--    SELECT indexrelname, idx_scan, idx_tup_read, idx_tup_fetch
--    FROM pg_stat_user_indexes
--    WHERE relname = 'pricing_observations'
--      AND indexrelname IN (
--        'idx_po_category',
--        'idx_po_bracket',
--        'pricing_observations_country',
--        'idx_po_source',
--        'idx_po_country_source',
--        'idx_po_country_city_cat_bracket',
--        'idx_po_city_cat_bracket'
--      );
-- ════════════════════════════════════════════════════════════════════════
