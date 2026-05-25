-- ════════════════════════════════════════════════════════════════════════
-- Migración 80 — Backfill retroactivo del split de aeropuertos
--
-- DEPENDE DE: mig 78 (airport_markers) + mig 79 (country_config).
--
-- QUÉ HACE:
--   Reclasifica las filas históricas de pricing_observations cuyo city es
--   un airport legacy (Lima_Airport, Trujillo_Airport, Arequipa_Airport),
--   asignándolas a city_from / city_to según los keywords matcheen en
--   point_a / point_b. Mismo algoritmo que resolve_airport_route() del
--   Python — mantenemos paridad para que data nueva y vieja terminen en
--   las mismas ciudades.
--
-- REGLAS (idénticas a Python):
--   1. Keyword en point_a (con o sin point_b) → city_from
--   2. Keyword solo en point_b               → city_to
--   3. Sin match en ningún lado              → base_city (ej: Lima)
--
-- DEFENSIVO:
--   - Solo toca data_source='bot' (uploads manuales de hubs quedan intactos).
--   - Hace todo en una transacción para poder rollback si algo se ve raro.
--   - Imprime conteos por (legacy_city → new_city) al final.
--   - Idempotente: si se corre dos veces, la segunda no hace nada porque
--     ya no quedan filas con city = legacy airport.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

DO $migration$
DECLARE
  m            record;
  v_to_from    bigint := 0;
  v_to_to      bigint := 0;
  v_to_base    bigint := 0;
  v_legacy     text;
  v_kw_or_expr text;
  v_total_before bigint;
  v_total_after  bigint;
BEGIN
  -- Total antes (para reporte)
  SELECT COUNT(*) INTO v_total_before
  FROM pricing_observations
  WHERE country = 'Peru'
    AND data_source = 'bot'
    AND city IN (
      SELECT base_city || '_Airport'
      FROM airport_markers WHERE country = 'Peru'
    );

  RAISE NOTICE 'Mig 80: % filas legacy a procesar (city LIKE *_Airport)', v_total_before;

  -- Iterar markers de Peru
  FOR m IN
    SELECT base_city, city_from, city_to, keywords
    FROM airport_markers
    WHERE country = 'Peru' AND active = true
  LOOP
    v_legacy := m.base_city || '_Airport';

    -- Build una expresión OR de ILIKE %keyword% para usar en WHERE.
    -- Hacemos esto vía un sub-query con ANY() en lugar de string concat
    -- (más seguro contra inyección + mejor para el planner).

    -- PASO 1: city_from (keyword en point_a)
    WITH targets AS (
      SELECT id FROM pricing_observations
      WHERE country     = 'Peru'
        AND data_source = 'bot'
        AND city        = v_legacy
        AND EXISTS (
          SELECT 1 FROM unnest(m.keywords) kw
          WHERE lower(point_a) LIKE '%' || kw || '%'
        )
    ),
    upd AS (
      UPDATE pricing_observations po
      SET city = m.city_from
      FROM targets t
      WHERE po.id = t.id
      RETURNING 1
    )
    SELECT count(*) INTO v_to_from FROM upd;

    -- PASO 2: city_to (keyword solo en point_b, excluyendo las ya
    -- movidas en paso 1)
    WITH targets AS (
      SELECT id FROM pricing_observations
      WHERE country     = 'Peru'
        AND data_source = 'bot'
        AND city        = v_legacy
        AND EXISTS (
          SELECT 1 FROM unnest(m.keywords) kw
          WHERE lower(point_b) LIKE '%' || kw || '%'
        )
        -- garantía: ninguna en point_a (las que matchean ambos ya están
        -- en city_from por el paso 1)
        AND NOT EXISTS (
          SELECT 1 FROM unnest(m.keywords) kw
          WHERE lower(point_a) LIKE '%' || kw || '%'
        )
    ),
    upd AS (
      UPDATE pricing_observations po
      SET city = m.city_to
      FROM targets t
      WHERE po.id = t.id
      RETURNING 1
    )
    SELECT count(*) INTO v_to_to FROM upd;

    -- PASO 3: resto (sin match) → base_city
    WITH upd AS (
      UPDATE pricing_observations po
      SET city = m.base_city
      WHERE po.country     = 'Peru'
        AND po.data_source = 'bot'
        AND po.city        = v_legacy
      RETURNING 1
    )
    SELECT count(*) INTO v_to_base FROM upd;

    RAISE NOTICE 'Marker [%]: → %=%, → %=%, → %(base)=%',
      v_legacy,
      m.city_from, v_to_from,
      m.city_to,   v_to_to,
      m.base_city, v_to_base;
  END LOOP;

  -- Total después
  SELECT COUNT(*) INTO v_total_after
  FROM pricing_observations
  WHERE country = 'Peru'
    AND data_source = 'bot'
    AND city IN (
      SELECT base_city || '_Airport'
      FROM airport_markers WHERE country = 'Peru'
    );

  RAISE NOTICE 'Mig 80: filas legacy restantes = % (esperado 0)', v_total_after;
END
$migration$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN POST-APLICACIÓN
--
-- 1. Distribución por city después del backfill:
--    SELECT city, COUNT(*) AS n
--    FROM pricing_observations
--    WHERE country = 'Peru' AND data_source = 'bot'
--      AND city LIKE '%Aero%' OR city LIKE '%Airport%'
--    GROUP BY city ORDER BY city;
--
--    -> Lima_AeroFrom, Lima_AeroTo, Trujillo_AeroFrom, Trujillo_AeroTo,
--       Arequipa_AeroFrom, Arequipa_AeroTo (con N>0 cada una si había
--       data histórica). Lima_Airport / Trujillo_Airport / Arequipa_Airport
--       NO deberían aparecer.
--
-- 2. Confirmar que no quedó legacy:
--    SELECT COUNT(*) FROM pricing_observations
--    WHERE country='Peru' AND data_source='bot'
--      AND city IN ('Lima_Airport','Trujillo_Airport','Arequipa_Airport');
--    -> 0.
-- ════════════════════════════════════════════════════════════════════════
