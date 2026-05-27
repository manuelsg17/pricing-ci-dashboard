-- ════════════════════════════════════════════════════════════════════════
-- Migración 95 — Corp visible en selector de ciudad del Dashboard
--
-- CONTEXTO:
--   country_config.cities tiene Corp con isVirtual=true para Peru. El
--   helper dbConfigToInternal (src/lib/constants.js) construye uiCities
--   filtrando por !isVirtual, así que Corp nunca aparecía en el dropdown
--   del Dashboard / Market / Coverage.
--
--   Históricamente Corp era una "vista agregada" virtual (corporativo),
--   pero hoy tiene su propio set de competidores y observaciones reales
--   (mig 69 recuperó 1190 filas) — es una city operacional, no virtual.
--
-- QUÉ HACE:
--   Flip de isVirtual: true → false para la entrada Corp en
--   country_config Peru. Mismo patrón que mig 85 hizo para los airport.
--
-- COMPLEMENTO EN FRONTEND:
--   CACHE_KEY se bumpea de v3 a v4 en CountryContext para forzar refetch
--   en los browsers que tengan la versión cacheada con Corp virtual.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

DO $corp_visible$
DECLARE
  v_before  text;
  v_after   text;
BEGIN
  -- Snapshot pre/post para log
  SELECT (elem->>'isVirtual')::text INTO v_before
  FROM country_config, jsonb_array_elements(cities) AS elem
  WHERE country_key = 'Peru' AND elem->>'dbName' = 'Corp';

  UPDATE country_config
  SET cities = (
    SELECT jsonb_agg(
      CASE
        WHEN elem->>'dbName' = 'Corp'
          THEN elem || jsonb_build_object('isVirtual', false)
        ELSE elem
      END
      ORDER BY ord
    )
    FROM jsonb_array_elements(cities) WITH ORDINALITY AS t(elem, ord)
  )
  WHERE country_key = 'Peru';

  SELECT (elem->>'isVirtual')::text INTO v_after
  FROM country_config, jsonb_array_elements(cities) AS elem
  WHERE country_key = 'Peru' AND elem->>'dbName' = 'Corp';

  RAISE NOTICE 'Mig 95 [Corp.isVirtual]: % → %', v_before, v_after;
END
$corp_visible$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
--   SELECT elem->>'dbName' AS db, (elem->>'isVirtual')::boolean AS virtual
--   FROM country_config, jsonb_array_elements(cities) AS elem
--   WHERE country_key='Peru' AND elem->>'dbName'='Corp';
--   → Corp | false
-- ════════════════════════════════════════════════════════════════════════
