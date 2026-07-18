-- ════════════════════════════════════════════════════════════════════════
-- Migración 84 — Rename airport split AeroFrom/AeroTo → Airport_A/Airport_B
--
-- CONTEXTO:
--   Las migs 78/79/80 introdujeron el split de aeropuertos en Peru usando
--   la convención "AeroFrom" / "AeroTo" (origen vs destino del aeropuerto).
--   Para estandarizar con Colombia y futuras expansiones, normalizamos a
--   "Airport_A" / "Airport_B": semánticamente equivalente, pero alineado
--   con la convención canónica del dashboard.
--
--   El usuario YA aplicó 78/79/80 — esta mig opera sobre el estado actual
--   y NO requiere re-aplicar las anteriores.
--
-- DEPENDE DE:
--   - mig 78 (airport_markers seed)
--   - mig 79 (country_config.cities + bot_rules.cities expansion)
--   - mig 80 (backfill de pricing_observations)
--
-- QUÉ HACE:
--   1. airport_markers: renombra city_from/city_to de las 3 filas Peru.
--   2. country_config.cities (JSONB Peru): renombra uiName/dbName/botKey
--      de las 6 entradas virtuales del split.
--   3. bot_rules.cities (text[] Peru): reemplaza strings AeroFrom/AeroTo
--      por Airport_A/Airport_B, deduplicando.
--
--   NOTA: pricing_observations.city también podría tener filas con los
--   nombres viejos (de data nueva ingerida entre 78-80 y 84). Las migramos
--   con un UPDATE directo al final.
--
-- NAMING (old → new):
--   ┌──────────────────────┬──────────────────────┐
--   │ AeroFrom/AeroTo      │ Airport_A/Airport_B  │
--   ├──────────────────────┼──────────────────────┤
--   │ Lima_AeroFrom        │ Lima_Airport_A       │
--   │ Lima_AeroTo          │ Lima_Airport_B       │
--   │ Trujillo_AeroFrom    │ Trujillo_Airport_A   │
--   │ Trujillo_AeroTo      │ Trujillo_Airport_B   │
--   │ Arequipa_AeroFrom    │ Arequipa_Airport_A   │
--   │ Arequipa_AeroTo      │ Arequipa_Airport_B   │
--   └──────────────────────┴──────────────────────┘
--
--   botKey (lowercase): lima_aerofrom → lima_airport_a, etc.
--
-- IDEMPOTENCIA:
--   - airport_markers: el UPDATE usa CASE/WHEN sobre el valor actual; si
--     ya está renombrado, no toca nada.
--   - country_config: el rebuild via jsonb_agg aplica replace() a cada
--     entrada; si ya están con el naming nuevo, replace() es no-op.
--   - bot_rules: el ARRAY(SELECT DISTINCT ...) sobre replace() es estable.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── A. airport_markers: renombrar city_from / city_to ──────────────────
-- Sólo tocamos filas de Peru. CASE WHEN garantiza idempotencia: si el
-- valor ya está renombrado, queda igual.

DO $rename_markers$
DECLARE
  v_updated bigint;
BEGIN
  WITH upd AS (
    UPDATE public.airport_markers
    SET
      city_from = CASE city_from
        WHEN 'Lima_AeroFrom'     THEN 'Lima_Airport_A'
        WHEN 'Trujillo_AeroFrom' THEN 'Trujillo_Airport_A'
        WHEN 'Arequipa_AeroFrom' THEN 'Arequipa_Airport_A'
        ELSE city_from
      END,
      city_to = CASE city_to
        WHEN 'Lima_AeroTo'     THEN 'Lima_Airport_B'
        WHEN 'Trujillo_AeroTo' THEN 'Trujillo_Airport_B'
        WHEN 'Arequipa_AeroTo' THEN 'Arequipa_Airport_B'
        ELSE city_to
      END
    WHERE country = 'Peru'
      AND (
        city_from IN ('Lima_AeroFrom','Trujillo_AeroFrom','Arequipa_AeroFrom')
        OR city_to IN ('Lima_AeroTo','Trujillo_AeroTo','Arequipa_AeroTo')
      )
    RETURNING 1
  )
  SELECT count(*) INTO v_updated FROM upd;

  RAISE NOTICE 'Mig 84 [airport_markers]: % filas renombradas', v_updated;
END
$rename_markers$;

-- ── B. country_config.cities (JSONB) — Peru ────────────────────────────
-- Rebuild del array vía jsonb_agg aplicando replace() en uiName/dbName/
-- botKey. Entradas que no sean parte del split quedan intactas (replace
-- sobre string sin match es no-op). 100% idempotente.

DO $rename_cities$
DECLARE
  v_n_before int;
  v_n_after  int;
BEGIN
  SELECT jsonb_array_length(cities) INTO v_n_before
  FROM public.country_config WHERE country_key = 'Peru';

  UPDATE public.country_config
  SET cities = COALESCE(
    (
      SELECT jsonb_agg(
        elem
          || jsonb_build_object(
               'uiName',
                 replace(replace(elem->>'uiName', 'AeroFrom', 'Airport_A'),
                                                 'AeroTo',   'Airport_B'),
               'dbName',
                 replace(replace(elem->>'dbName', 'AeroFrom', 'Airport_A'),
                                                 'AeroTo',   'Airport_B'),
               'botKey',
                 replace(replace(elem->>'botKey', 'aerofrom', 'airport_a'),
                                                 'aeroto',   'airport_b')
             )
        ORDER BY ord
      )
      FROM jsonb_array_elements(cities) WITH ORDINALITY AS t(elem, ord)
    ),
    cities
  )
  WHERE country_key = 'Peru';

  SELECT jsonb_array_length(cities) INTO v_n_after
  FROM public.country_config WHERE country_key = 'Peru';

  RAISE NOTICE 'Mig 84 [country_config Peru]: cities n_before=% n_after=% (esperado igual)',
    v_n_before, v_n_after;
END
$rename_cities$;

-- ── C. bot_rules.cities (text[]) — Peru ────────────────────────────────
-- Reemplazo string a string en cada elemento del array, deduplicando.
-- ARRAY(SELECT DISTINCT ...) garantiza que aunque mig 79 haya dejado
-- ambos AeroFrom y otro alias, no terminemos con duplicados.

DO $rename_bot_rules$
DECLARE
  v_updated bigint;
BEGIN
  WITH upd AS (
    UPDATE public.bot_rules br
    SET cities = ARRAY(
      SELECT DISTINCT
        CASE c
          WHEN 'Lima_AeroFrom'     THEN 'Lima_Airport_A'
          WHEN 'Lima_AeroTo'       THEN 'Lima_Airport_B'
          WHEN 'Trujillo_AeroFrom' THEN 'Trujillo_Airport_A'
          WHEN 'Trujillo_AeroTo'   THEN 'Trujillo_Airport_B'
          WHEN 'Arequipa_AeroFrom' THEN 'Arequipa_Airport_A'
          WHEN 'Arequipa_AeroTo'   THEN 'Arequipa_Airport_B'
          ELSE c
        END
      FROM unnest(br.cities) AS c
    )
    WHERE br.country = 'Peru'
      AND (
        'Lima_AeroFrom'     = ANY(br.cities) OR
        'Lima_AeroTo'       = ANY(br.cities) OR
        'Trujillo_AeroFrom' = ANY(br.cities) OR
        'Trujillo_AeroTo'   = ANY(br.cities) OR
        'Arequipa_AeroFrom' = ANY(br.cities) OR
        'Arequipa_AeroTo'   = ANY(br.cities)
      )
    RETURNING 1
  )
  SELECT count(*) INTO v_updated FROM upd;

  RAISE NOTICE 'Mig 84 [bot_rules]: % reglas con cities renombradas', v_updated;
END
$rename_bot_rules$;

-- ── D. pricing_observations.city — Peru ────────────────────────────────
-- Por si entraron filas con el naming viejo entre la aplicación de 80 y
-- esta mig. Idempotente: si no quedan filas con el naming viejo, el
-- UPDATE no hace nada.

DO $rename_pricing_obs$
DECLARE
  v_updated bigint;
BEGIN
  WITH upd AS (
    UPDATE public.pricing_observations po
    SET city = CASE city
      WHEN 'Lima_AeroFrom'     THEN 'Lima_Airport_A'
      WHEN 'Lima_AeroTo'       THEN 'Lima_Airport_B'
      WHEN 'Trujillo_AeroFrom' THEN 'Trujillo_Airport_A'
      WHEN 'Trujillo_AeroTo'   THEN 'Trujillo_Airport_B'
      WHEN 'Arequipa_AeroFrom' THEN 'Arequipa_Airport_A'
      WHEN 'Arequipa_AeroTo'   THEN 'Arequipa_Airport_B'
      ELSE city
    END
    WHERE po.country = 'Peru'
      AND po.city IN (
        'Lima_AeroFrom','Lima_AeroTo',
        'Trujillo_AeroFrom','Trujillo_AeroTo',
        'Arequipa_AeroFrom','Arequipa_AeroTo'
      )
    RETURNING 1
  )
  SELECT count(*) INTO v_updated FROM upd;

  RAISE NOTICE 'Mig 84 [pricing_observations]: % filas con city renombrada', v_updated;
END
$rename_pricing_obs$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
--
-- 1. airport_markers (esperado 3 filas con city_from/city_to en Airport_A/B):
--    SELECT country, base_city, city_from, city_to
--    FROM airport_markers WHERE country='Peru' ORDER BY base_city;
--    → Arequipa | Arequipa_Airport_A | Arequipa_Airport_B
--      Lima     | Lima_Airport_A     | Lima_Airport_B
--      Trujillo | Trujillo_Airport_A | Trujillo_Airport_B
--
-- 2. country_config Peru (esperado 10 cities, 6 splits con _Airport_A/B):
--    SELECT elem->>'dbName' AS dbname, elem->>'botKey' AS botkey
--    FROM country_config, jsonb_array_elements(cities) AS elem
--    WHERE country_key='Peru'
--      AND (elem->>'dbName' LIKE '%Airport_%' OR elem->>'dbName' LIKE '%Aero%')
--    ORDER BY 1;
--    → 6 filas Airport_A/B, 0 filas con AeroFrom/AeroTo.
--
-- 3. bot_rules Peru (0 reglas con AeroFrom/AeroTo en su cities):
--    SELECT COUNT(*) FROM bot_rules
--    WHERE country='Peru'
--      AND (
--        'Lima_AeroFrom'     = ANY(cities) OR
--        'Lima_AeroTo'       = ANY(cities) OR
--        'Trujillo_AeroFrom' = ANY(cities) OR
--        'Trujillo_AeroTo'   = ANY(cities) OR
--        'Arequipa_AeroFrom' = ANY(cities) OR
--        'Arequipa_AeroTo'   = ANY(cities)
--      );
--    → 0.
--
-- 4. pricing_observations Peru (0 filas con city = naming viejo):
--    SELECT COUNT(*) FROM pricing_observations
--    WHERE country='Peru' AND city IN (
--      'Lima_AeroFrom','Lima_AeroTo',
--      'Trujillo_AeroFrom','Trujillo_AeroTo',
--      'Arequipa_AeroFrom','Arequipa_AeroTo'
--    );
--    → 0.
-- ════════════════════════════════════════════════════════════════════════
