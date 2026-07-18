-- ════════════════════════════════════════════════════════════════════════
-- Migración 96 — Fix drift Corp competitors entre country_config y BD
--
-- CONTEXTO:
--   La mig 72 estableció la convención canónica para Corp competitors como
--   formato pegado/concat ('YangoEconomy', 'YangoComfort+', 'CabifyLite', etc).
--   La parte B de mig 72 backfilleó pricing_observations correctamente.
--   La parte C debía actualizar country_config.cities[Corp].categories[Corp].competitors
--   pero por algún motivo (race, mig posterior que regrabó cities, error
--   silenciado) ese array quedó con la convención vieja CON ESPACIOS
--   ('Yango Economy', 'Yango Comfort+', 'Cabify Lite').
--
--   Síntoma observado 2026-05-27:
--     - Data Raw tab Corp muestra 7490 filas con `YangoEconomy` (sin espacio).
--     - Dashboard city=Corp/category=Corp muestra todos los Yango/Cabify
--       variantes en 0. Sólo 'Cabify' (idéntico en ambas convenciones)
--       muestra data.
--     - Causa: `filters.competitors` viene de country_config.cities con
--       espacios → lookup priceMatrix['Yango Economy'] vs nested['YangoEconomy'] → mismatch.
--
-- QUÉ HACE:
--   Re-ejecuta la parte C de mig 72 de forma idempotente. Reemplaza el
--   array competitors dentro de cities[Corp].categories[Corp] con la
--   versión canónica concat.
--
-- IDEMPOTENCIA:
--   Si el array ya está concat, el UPDATE es no-op semántico (re-escribe
--   con el mismo valor). 100% seguro de re-correr.
--
-- COMPLEMENTO EN FRONTEND:
--   CountryContext.jsx debe bumpear CACHE_KEY de v4 a v5 para invalidar
--   localStorage en browsers que hayan cacheado el array con espacios.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

DO $fix_corp_competitors$
DECLARE
  v_before jsonb;
  v_after  jsonb;
BEGIN
  -- Snapshot del array antes del fix (para el log)
  SELECT cat->'competitors' INTO v_before
  FROM country_config,
       jsonb_array_elements(cities) AS city_elem,
       jsonb_array_elements(city_elem->'categories') AS cat
  WHERE country_key = 'Peru'
    AND city_elem->>'dbName' = 'Corp'
    AND cat->>'dbName' = 'Corp';

  UPDATE country_config
  SET cities = (
    SELECT jsonb_agg(
      CASE
        WHEN city_elem->>'dbName' = 'Corp' THEN
          jsonb_set(
            city_elem,
            '{categories}',
            (
              SELECT jsonb_agg(
                CASE
                  WHEN cat->>'dbName' = 'Corp' THEN
                    jsonb_set(
                      cat,
                      '{competitors}',
                      '["YangoEconomy","YangoComfort","YangoComfort+","YangoPremier","YangoXL","Cabify","CabifyLite","CabifyExtraComfort","CabifyXL"]'::jsonb
                    )
                  ELSE cat
                END
                ORDER BY cat_ord
              )
              FROM jsonb_array_elements(city_elem->'categories') WITH ORDINALITY AS t(cat, cat_ord)
            )
          )
        ELSE city_elem
      END
      ORDER BY city_ord
    )
    FROM jsonb_array_elements(cities) WITH ORDINALITY AS t(city_elem, city_ord)
  )
  WHERE country_key = 'Peru';

  -- Snapshot del array después
  SELECT cat->'competitors' INTO v_after
  FROM country_config,
       jsonb_array_elements(cities) AS city_elem,
       jsonb_array_elements(city_elem->'categories') AS cat
  WHERE country_key = 'Peru'
    AND city_elem->>'dbName' = 'Corp'
    AND cat->>'dbName' = 'Corp';

  RAISE NOTICE '[mig 96] Corp competitors antes : %', v_before;
  RAISE NOTICE '[mig 96] Corp competitors después: %', v_after;
END
$fix_corp_competitors$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN POST-APLICACIÓN
--
-- 1. Confirmar que el array está en concat:
--    SELECT cat->'competitors' AS competitors
--    FROM country_config,
--         jsonb_array_elements(cities) AS city_elem,
--         jsonb_array_elements(city_elem->'categories') AS cat
--    WHERE country_key='Peru'
--      AND city_elem->>'dbName'='Corp'
--      AND cat->>'dbName'='Corp';
--    → ["YangoEconomy","YangoComfort","YangoComfort+","YangoPremier",
--       "YangoXL","Cabify","CabifyLite","CabifyExtraComfort","CabifyXL"]
--
-- 2. Hard reload del frontend (Cmd+Shift+R) — la cache de localStorage
--    `cc.dbConfigs.v4` puede tener la versión vieja. Después del bump
--    a v5 en src/context/CountryContext.jsx, esto es automático.
--
-- 3. Dashboard → ciudad Corp → categoría Corp → debe mostrar todos los
--    Yango/Cabify variantes con sus precios (no más 0).
-- ════════════════════════════════════════════════════════════════════════
