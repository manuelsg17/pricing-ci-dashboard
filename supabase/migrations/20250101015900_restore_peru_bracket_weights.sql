-- ════════════════════════════════════════════════════════════════════════
-- Migración 120 — Restaurar los pesos REALES de Perú en bracket_weights
--
-- POR QUÉ:
--   El 2026-07-07 se aplicó un parche de emergencia que puso TODOS los pesos de
--   Perú en 16.6% (equal weight) para forzar un "promedio simple" en todo el
--   dashboard. Ese parche era un stopgap. La solución real vive en el frontend
--   (corte por semana: desde 2026-W25 el WA es promedio simple; ≤2026-W24
--   conserva el ponderado). Para Perú, el histórico ponderado ya lo maneja el
--   frontend con los pesos fijados en código (LEGACY_WEIGHTS_PE en
--   src/lib/constants.js). Esta migración deja la BD y el editor Config→Pesos
--   HONESTOS: restaura cada fila de Perú a su valor inmediato ANTES del parche
--   (recuperado del audit_log 2026-07-07). Los valores son idénticos a
--   LEGACY_WEIGHTS_PE.
--
-- ⚠️ ORDEN OBLIGATORIO:
--   Aplicar SOLO DESPUÉS de que el frontend con el corte por semana esté
--   desplegado (push a main → GitHub Pages). Con el corte ya live, Perú lee los
--   pesos del código y W25+ es simple, así que restaurar la BD NO cambia nada
--   visual (cosmético/seguro). Si se aplicara ANTES, el sitio desplegado (sin
--   corte) re-ponderaría las semanas recientes (W25+) en vivo — lo que el
--   gerente NO quiere ver durante la presentación.
--
-- Idempotente: re-correrla deja los mismos valores.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

WITH pe(city, w) AS (
  VALUES
    ('all',                ARRAY[0.0983, 0.1967, 0.1939, 0.1384, 0.075,  0.297 ]),
    ('Corp',               ARRAY[0.0983, 0.1967, 0.1939, 0.1384, 0.075,  0.297 ]),
    ('Lima',               ARRAY[0.0975, 0.2043, 0.1952, 0.133,  0.085,  0.285 ]),
    ('Arequipa',           ARRAY[0.1003, 0.186,  0.2118, 0.0861, 0.1158, 0.2236]),
    ('Trujillo',           ARRAY[0.1003, 0.186,  0.2118, 0.0861, 0.1158, 0.2236]),
    ('Airport',            ARRAY[0.0666, 0.1221, 0.2222, 0,      0.5891, 0     ]),
    ('Lima_Airport_A',     ARRAY[0.0666, 0.1221, 0.2222, 0,      0.5891, 0     ]),
    ('Lima_Airport_B',     ARRAY[0.0666, 0.1221, 0.2222, 0,      0.5891, 0     ]),
    ('Arequipa_Airport_A', ARRAY[0.1003, 0.186,  0.2118, 0.0861, 0.1158, 0.3   ]),
    ('Arequipa_Airport_B', ARRAY[0.1003, 0.186,  0.2118, 0.0861, 0,      0.3336]),
    ('Trujillo_Airport_A', ARRAY[0.1003, 0.186,  0.2118, 0.0861, 0.4058, 0     ]),
    ('Trujillo_Airport_B', ARRAY[0.1003, 0.186,  0.2118, 0,      0,      0.4136])
),
brk(bracket, idx) AS (
  VALUES ('very_short', 1), ('short', 2), ('median', 3),
         ('average', 4), ('long', 5), ('very_long', 6)
)
INSERT INTO bracket_weights (country, city, category, bracket, weight)
SELECT 'Peru', pe.city, 'all', brk.bracket, pe.w[brk.idx]
FROM pe CROSS JOIN brk
ON CONFLICT (country, city, category, bracket)
DO UPDATE SET weight = EXCLUDED.weight, updated_at = now();

COMMIT;

-- POST-APLICACIÓN (verificar que ninguna fila de Perú quedó en 16.6%):
--   SELECT city, array_agg(weight ORDER BY bracket) FROM bracket_weights
--   WHERE country = 'Peru' GROUP BY city ORDER BY city;
