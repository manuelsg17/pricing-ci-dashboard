-- ============================================================
-- AUDITORÍA: filas potencialmente mal etiquetadas por país
-- ============================================================
-- Detecta rows en tablas con columna `country` cuya `city` NO pertenece
-- al conjunto de ciudades válidas para ese país (según constants.js).
-- Síntoma típico del bug P0B (Upload no inyectaba country).
--
-- USO:
--   1. Ejecutar este script (read-only — solo SELECT).
--   2. Revisar resultados manualmente.
--   3. Si hay rows mal etiquetadas, corregir con UPDATE puntual:
--        UPDATE pricing_observations
--        SET country = 'Colombia'
--        WHERE id IN (...);
--   4. Recién después aplicar la migración 27_country_isolation_schema.sql.
-- ============================================================

-- Mapeo país → ciudades válidas (mantener sincronizado con src/lib/constants.js)
WITH valid_country_cities (country, city) AS (
  VALUES
    -- Peru
    ('Peru', 'Lima'),
    ('Peru', 'Trujillo'),
    ('Peru', 'Arequipa'),
    ('Peru', 'Airport'),
    ('Peru', 'Corp'),
    -- Colombia
    ('Colombia', 'Bogotá'),
    ('Colombia', 'Medellín'),
    ('Colombia', 'Cali')
)

-- ── 1. pricing_observations ─────────────────────────────────
SELECT 'pricing_observations' AS source_table,
       country, city, COUNT(*) AS rows_mislabeled,
       MIN(observed_date) AS first_date,
       MAX(observed_date) AS last_date
FROM pricing_observations po
WHERE NOT EXISTS (
  SELECT 1 FROM valid_country_cities v
  WHERE v.country = po.country AND v.city = po.city
)
GROUP BY country, city

UNION ALL

-- ── 2. market_events ────────────────────────────────────────
SELECT 'market_events' AS source_table,
       country, city, COUNT(*),
       MIN(event_date), MAX(event_date)
FROM market_events me
WHERE NOT EXISTS (
  SELECT 1 FROM valid_country_cities v
  WHERE v.country = me.country AND v.city = me.city
)
GROUP BY country, city

UNION ALL

-- ── 3. competitor_commissions (city puede ser NULL = global) ─
SELECT 'competitor_commissions' AS source_table,
       country, city, COUNT(*), NULL::date, NULL::date
FROM competitor_commissions cc
WHERE cc.city IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM valid_country_cities v
    WHERE v.country = cc.country AND v.city = cc.city
  )
GROUP BY country, city

UNION ALL

-- ── 4. competitor_bonuses ───────────────────────────────────
SELECT 'competitor_bonuses' AS source_table,
       country, city, COUNT(*), NULL::date, NULL::date
FROM competitor_bonuses cb
WHERE cb.city IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM valid_country_cities v
    WHERE v.country = cb.country AND v.city = cb.city
  )
GROUP BY country, city

UNION ALL

-- ── 5. earnings_scenarios ───────────────────────────────────
SELECT 'earnings_scenarios' AS source_table,
       country, city, COUNT(*), NULL::date, NULL::date
FROM earnings_scenarios es
WHERE NOT EXISTS (
  SELECT 1 FROM valid_country_cities v
  WHERE v.country = es.country AND v.city = es.city
)
GROUP BY country, city

ORDER BY source_table, country, city;

-- Si esta query devuelve 0 filas → toda la data está bien etiquetada.
-- Si devuelve filas → revisar caso por caso antes de aplicar P1.
