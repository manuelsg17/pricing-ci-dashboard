-- ════════════════════════════════════════════════════════════════════════
-- Migración 81 — Backfill airport split desde base cities (no solo legacy)
--
-- CONTEXTO:
--   Mig 80 procesó las filas con city legacy (Lima_Airport, etc.) pero
--   esas filas no existían más en pricing_observations (el bot no etiqueta
--   los viajes al aeropuerto separadamente — todos vienen como Lima/
--   Trujillo/Arequipa).
--
--   Verificación 2026-05-24: hay miles de filas con city='Arequipa' cuyo
--   point_b matchea "rodríguez ballón" o "aeropuerto" — esos SÍ son
--   viajes al aeropuerto pero el bot los marca como ciudad base.
--
-- QUÉ HACE:
--   Procesa filas con city = base_city (Lima, Trujillo, Arequipa) y
--   reasigna a city_from o city_to si encuentra keywords en
--   point_a/point_b. Si no matchea → quedan en base city (no las toca).
--
-- REGLAS (idénticas a resolve_airport_route() del Python):
--   1. Keyword en point_a (con o sin point_b) → city_from
--   2. Keyword solo en point_b               → city_to
--   3. Sin match en ninguno                  → SIN CAMBIOS (no-op)
--
-- IMPORTANTE — escenarios cubiertos:
--   ✓ Mig 80 → filas con city legacy '_Airport' (no había en este proyecto,
--             pero queda como red de seguridad para otros).
--   ✓ Mig 81 → filas con city base que SÍ son aeropuerto (este caso real).
--
-- DEFENSIVO:
--   - Solo toca data_source='bot'.
--   - Solo MUEVE filas que matchean — NUNCA pone en base las que ya están
--     en base sin keyword (sería no-op pero rompe la regla "sin cambios").
--   - Transacción única para poder rollback.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

DO $migration$
DECLARE
  m              record;
  v_to_from      bigint := 0;
  v_to_to        bigint := 0;
  v_total_moved  bigint := 0;
BEGIN
  FOR m IN
    SELECT base_city, city_from, city_to, keywords
    FROM airport_markers
    WHERE country = 'Peru' AND active = true
  LOOP
    -- PASO 1: city_from (keyword en point_a)
    -- Usamos EXISTS+unnest para construir el OR a partir del array de
    -- keywords sin string-concat (más limpio, planner mejor).
    WITH targets AS (
      SELECT id FROM pricing_observations
      WHERE country     = 'Peru'
        AND data_source = 'bot'
        AND city        = m.base_city
        AND EXISTS (
          SELECT 1 FROM unnest(m.keywords) kw
          WHERE lower(coalesce(point_a,'')) LIKE '%' || kw || '%'
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

    -- PASO 2: city_to (keyword solo en point_b, excluyendo las que ya
    -- tienen match en point_a — esas ya fueron a city_from en paso 1
    -- pero las re-verificamos por defensivo ya que su city cambió)
    WITH targets AS (
      SELECT id FROM pricing_observations
      WHERE country     = 'Peru'
        AND data_source = 'bot'
        AND city        = m.base_city
        AND EXISTS (
          SELECT 1 FROM unnest(m.keywords) kw
          WHERE lower(coalesce(point_b,'')) LIKE '%' || kw || '%'
        )
        AND NOT EXISTS (
          SELECT 1 FROM unnest(m.keywords) kw
          WHERE lower(coalesce(point_a,'')) LIKE '%' || kw || '%'
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

    v_total_moved := v_total_moved + v_to_from + v_to_to;

    RAISE NOTICE 'Marker [%]: %=%, %=% (total movidas: %)',
      m.base_city, m.city_from, v_to_from, m.city_to, v_to_to,
      (v_to_from + v_to_to);
  END LOOP;

  RAISE NOTICE 'Mig 81 OK: % filas reclasificadas en total.', v_total_moved;
END
$migration$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN POST-APLICACIÓN
--
-- 1. Distribución por city:
--    SELECT city, COUNT(*) AS n
--    FROM pricing_observations
--    WHERE country='Peru' AND data_source='bot'
--      AND (city ~ 'Aero' OR city IN ('Lima','Trujillo','Arequipa'))
--    GROUP BY city ORDER BY n DESC;
--
--    Esperado:
--      Lima_AeroFrom / Lima_AeroTo > 0 (si los addresses Lima matchearon)
--      Arequipa_AeroFrom / Arequipa_AeroTo > 0 (vimos data ahí)
--      Trujillo_AeroFrom / Trujillo_AeroTo (depende si hay data)
-- ════════════════════════════════════════════════════════════════════════
