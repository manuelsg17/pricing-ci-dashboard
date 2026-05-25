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
--   ADEMÁS, la mayoría de la data de aeropuerto del usuario es
--   data_source='manual' (uploads desde Excel de hubs), no 'bot'. Por eso
--   esta mig NO filtra por data_source — procesa TODA la data del país.
--
-- QUÉ HACE:
--   Procesa DOS casos para cada marker:
--
--   BLOQUE A — city = base_city (Lima, Trujillo, Arequipa)
--     Solo mueve las filas que matchean zone o keyword. El resto son
--     viajes urbanos legítimos que quedan en base. Si zone matchea
--     zone_from/zone_to (mig 82), es source-of-truth y precede a
--     keywords.
--
--   BLOQUE B — city = base_city + '_Airport' (legacy)
--     TODAS son viajes de aeropuerto. Se reclasifican a city_from/
--     city_to por zone+keyword. Las que no matchean nada caen a
--     base_city como fallback defensivo (evita dejar legacy_Airport
--     huérfanos).
--
-- REGLAS (idénticas a resolve_airport_route() del Python + trigger mig 83):
--   1. raw.zone == zone_from_value           → city_from
--   2. raw.zone == zone_to_value             → city_to
--   3. Keyword en point_a (con o sin point_b)→ city_from
--   4. Keyword solo en point_b               → city_to
--   5. Sin match en ninguno:
--      - city era base_city  → SIN CAMBIOS
--      - city era legacy     → fallback base_city
--
-- IMPORTANTE — escenarios cubiertos:
--   ✓ Mig 80 → filas con city legacy '_Airport' (no había en este proyecto,
--             pero queda como red de seguridad para otros).
--   ✓ Mig 81 → filas con city base que SÍ son aeropuerto (este caso real).
--             Funciona para data_source IN ('bot','manual') sin distinción.
--
-- DEFENSIVO:
--   - Solo MUEVE filas que matchean — NUNCA pone en base las que ya están
--     en base sin keyword (sería no-op pero rompe la regla "sin cambios").
--   - Transacción única para poder rollback.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

DO $migration$
DECLARE
  m              record;
  v_legacy_city  text;
  v_to_from      bigint := 0;
  v_to_to        bigint := 0;
  v_legacy_to_fb bigint := 0;
  v_total_moved  bigint := 0;
BEGIN
  FOR m IN
    SELECT base_city, city_from, city_to, keywords,
           zone_from_value, zone_to_value
    FROM airport_markers
    WHERE country = 'Peru' AND active = true
  LOOP
    v_legacy_city := m.base_city || '_Airport';

    -- ════════════════════════════════════════════════════════════════
    -- BLOQUE A: filas con city = base_city (Lima/Trujillo/Arequipa)
    -- Solo se MUEVEN si matchean keyword o zone — el resto son viajes
    -- urbanos normales que deben quedar en su base.
    -- ════════════════════════════════════════════════════════════════

    -- A.1 city_from: zone match (preferido) o keyword en point_a
    WITH targets AS (
      SELECT id FROM pricing_observations
      WHERE country = 'Peru'
        AND city    = m.base_city
        AND (
          (m.zone_from_value IS NOT NULL AND zone = m.zone_from_value)
          OR EXISTS (
            SELECT 1 FROM unnest(m.keywords) kw
            WHERE lower(coalesce(point_a,'')) LIKE '%' || kw || '%'
          )
        )
    ),
    upd AS (
      UPDATE pricing_observations po
      SET city = m.city_from
      FROM targets t WHERE po.id = t.id RETURNING 1
    )
    SELECT count(*) INTO v_to_from FROM upd;

    -- A.2 city_to: zone match o keyword en point_b sin match en point_a
    WITH targets AS (
      SELECT id FROM pricing_observations
      WHERE country = 'Peru'
        AND city    = m.base_city
        AND (
          (m.zone_to_value IS NOT NULL AND zone = m.zone_to_value)
          OR (
            EXISTS (
              SELECT 1 FROM unnest(m.keywords) kw
              WHERE lower(coalesce(point_b,'')) LIKE '%' || kw || '%'
            )
            AND NOT EXISTS (
              SELECT 1 FROM unnest(m.keywords) kw
              WHERE lower(coalesce(point_a,'')) LIKE '%' || kw || '%'
            )
          )
        )
    ),
    upd AS (
      UPDATE pricing_observations po
      SET city = m.city_to
      FROM targets t WHERE po.id = t.id RETURNING 1
    )
    SELECT count(*) INTO v_to_to FROM upd;

    RAISE NOTICE 'Base [%]: %=%, %=%',
      m.base_city, m.city_from, v_to_from, m.city_to, v_to_to;
    v_total_moved := v_total_moved + v_to_from + v_to_to;

    -- ════════════════════════════════════════════════════════════════
    -- BLOQUE B: filas con city = base_city + '_Airport' (LEGACY)
    -- TODAS son viajes de aeropuerto. Se reclasifican:
    --   - matchea zone/point_a → city_from
    --   - matchea zone/point_b → city_to
    --   - sin match            → fallback a base_city (defensivo)
    -- ════════════════════════════════════════════════════════════════

    -- B.1 legacy → city_from
    WITH targets AS (
      SELECT id FROM pricing_observations
      WHERE country = 'Peru'
        AND city    = v_legacy_city
        AND (
          (m.zone_from_value IS NOT NULL AND zone = m.zone_from_value)
          OR EXISTS (
            SELECT 1 FROM unnest(m.keywords) kw
            WHERE lower(coalesce(point_a,'')) LIKE '%' || kw || '%'
          )
        )
    ),
    upd AS (
      UPDATE pricing_observations po
      SET city = m.city_from
      FROM targets t WHERE po.id = t.id RETURNING 1
    )
    SELECT count(*) INTO v_to_from FROM upd;

    -- B.2 legacy → city_to (sin match en point_a)
    WITH targets AS (
      SELECT id FROM pricing_observations
      WHERE country = 'Peru'
        AND city    = v_legacy_city
        AND (
          (m.zone_to_value IS NOT NULL AND zone = m.zone_to_value)
          OR (
            EXISTS (
              SELECT 1 FROM unnest(m.keywords) kw
              WHERE lower(coalesce(point_b,'')) LIKE '%' || kw || '%'
            )
            AND NOT EXISTS (
              SELECT 1 FROM unnest(m.keywords) kw
              WHERE lower(coalesce(point_a,'')) LIKE '%' || kw || '%'
            )
          )
        )
    ),
    upd AS (
      UPDATE pricing_observations po
      SET city = m.city_to
      FROM targets t WHERE po.id = t.id RETURNING 1
    )
    SELECT count(*) INTO v_to_to FROM upd;

    -- B.3 legacy sobrante (no matcheó nada) → base_city (fallback)
    WITH upd AS (
      UPDATE pricing_observations po
      SET city = m.base_city
      WHERE po.country = 'Peru' AND po.city = v_legacy_city
      RETURNING 1
    )
    SELECT count(*) INTO v_legacy_to_fb FROM upd;

    RAISE NOTICE 'Legacy [%]: %=%, %=%, %(fallback base)=%',
      v_legacy_city, m.city_from, v_to_from, m.city_to, v_to_to,
      m.base_city, v_legacy_to_fb;

    v_total_moved := v_total_moved + v_to_from + v_to_to + v_legacy_to_fb;
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
--      AND (city ~ 'Airport' OR city IN ('Lima','Trujillo','Arequipa'))
--    GROUP BY city ORDER BY n DESC;
--
--    Esperado:
--      Lima_Airport_A / Lima_Airport_B > 0 (si los addresses Lima matchearon)
--      Arequipa_Airport_A / Arequipa_Airport_B > 0 (vimos data ahí)
--      Trujillo_Airport_A / Trujillo_Airport_B (depende si hay data)
-- ════════════════════════════════════════════════════════════════════════
