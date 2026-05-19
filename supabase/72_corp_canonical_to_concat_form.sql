-- ════════════════════════════════════════════════════════════════════════
-- Migración 72 — Convención canónica Corp: pegados (matchea Excel)
--
-- POR QUÉ:
--   Tras el fiasco de aplastamiento Premier/Comfort+ → 'Yango' por cache
--   stale del frontend (mig 68-71), el product owner decidió cambiar la
--   convención canónica:
--     - ANTES: 'Yango Premier', 'Cabify Extra Comfort' (con espacios).
--     - AHORA: 'YangoPremier', 'CabifyExtraComfort' (pegados, matchean
--               el Excel original — la fuente de verdad real).
--
--   Beneficios:
--     - Excel del hub_expert entra sin transformación → menos puntos de falla.
--     - Una sola convención canónica para el sistema completo.
--     - Si el frontend está cacheado o un script externo escribe, la DB
--       guarda exactamente lo que mandó (sin transformaciones intermedias).
--
--   Para mostrar "Yango Premier" con espacio en la UI, hay
--   prettyCompetitor() en src/lib/normalize.js — separa storage de display.
--
-- QUE HACE ESTA MIGRACIÓN:
--   (A) Reemplaza normalize_competitor_name(raw, city) SQL — ahora
--       devuelve pegados para Corp.
--   (B) Backfill: pricing_observations Corp filas con espacios → pegados.
--   (C) UPDATE country_config.Peru.cities.Corp.categories.Corp.competitors
--       (jsonb) para que matchee la nueva convención.
--   (D) NOTICE con el estado final.
--
-- TRIGGER NORMALIZE (mig 70) Y GUARD STRICT (mig 71) SIGUEN ACTIVOS.
--   El guard sigue rechazando 'Yango' anónimo en Corp — eso NO cambia
--   con la nueva convención (Yango anónimo nunca fue válido en Corp).
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── (A) Reemplazar función SQL normalize_competitor_name ────────────────
CREATE OR REPLACE FUNCTION public.normalize_competitor_name(
  raw  text,
  city text
) RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  trimmed text;
  lc      text;
  fp      text;
BEGIN
  IF raw IS NULL THEN RETURN NULL; END IF;
  trimmed := btrim(raw);
  IF trimmed = '' THEN RETURN trimmed; END IF;
  lc := lower(trimmed);

  -- (1) Casing universal — siempre aplica
  CASE lc
    WHEN 'uber'    THEN RETURN 'Uber';
    WHEN 'yango'   THEN RETURN 'Yango';
    WHEN 'didi'    THEN RETURN 'Didi';
    WHEN 'indrive' THEN RETURN 'InDrive';
    WHEN 'cabify'  THEN RETURN 'Cabify';
    ELSE
      -- continúa
  END CASE;

  -- (2) Corp aliases — sólo si city='Corp'. Output PEGADO (nueva convención).
  IF city = 'Corp' THEN
    fp := regexp_replace(lc, '\s+', '', 'g');
    CASE fp
      WHEN 'yangoeconomy'        THEN RETURN 'YangoEconomy';
      WHEN 'yangocomfort'        THEN RETURN 'YangoComfort';
      WHEN 'yangocomfort+'       THEN RETURN 'YangoComfort+';
      WHEN 'yangocomfortplus'    THEN RETURN 'YangoComfort+';
      WHEN 'yangoplus'           THEN RETURN 'YangoComfort+';
      WHEN 'yangopremier'        THEN RETURN 'YangoPremier';
      WHEN 'yangoxl'             THEN RETURN 'YangoXL';
      WHEN 'cabifylite'          THEN RETURN 'CabifyLite';
      WHEN 'cabifyextracomfort'  THEN RETURN 'CabifyExtraComfort';
      WHEN 'cabifyxl'            THEN RETURN 'CabifyXL';
      ELSE
        -- continúa con passthrough
    END CASE;
  END IF;

  -- (3) Pass-through
  RETURN trimmed;
END;
$$;

COMMENT ON FUNCTION public.normalize_competitor_name(text, text) IS
  'Normaliza competition_name. Espejo SQL de src/lib/normalize.js normalizeCompetitorName. Convención: pegados sin espacios para Corp (matchea Excel). Si modificás uno, modificá el otro y los tests JS.';

-- ── (B) Backfill: pricing_observations Corp con espacios → pegados ──────
DO $backfill$
DECLARE
  v_changed int;
BEGIN
  WITH updated AS (
    UPDATE public.pricing_observations
       SET competition_name = public.normalize_competitor_name(competition_name, city)
     WHERE country = 'Peru'
       AND city    = 'Corp'
       AND competition_name <> public.normalize_competitor_name(competition_name, city)
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_changed FROM updated;
  RAISE NOTICE '[mig 72] Backfill Corp espacios→pegados: % filas re-normalizadas.', v_changed;
END
$backfill$;

-- ── (C) UPDATE country_config: cities.Corp.categories.Corp.competitors ───
-- Reemplaza el array de competitors dentro del jsonb cities. Lógica:
-- recorre cities, encuentra la ciudad Corp, encuentra su categoría Corp,
-- reemplaza el array competitors con la versión pegada.
DO $cfg$
DECLARE
  v_cities jsonb;
  v_updated jsonb;
BEGIN
  SELECT cities INTO v_cities
    FROM country_config
   WHERE country_key = 'Peru';

  IF v_cities IS NULL THEN
    RAISE NOTICE '[mig 72] country_config Peru no encontrado — skip update jsonb.';
    RETURN;
  END IF;

  -- Map sobre cities[] reemplazando solo la entry con dbName='Corp'
  WITH cities_arr AS (
    SELECT jsonb_array_elements(v_cities) AS city
  ),
  remapped AS (
    SELECT
      CASE
        WHEN city->>'dbName' = 'Corp' THEN
          jsonb_set(
            city,
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
              )
              FROM jsonb_array_elements(city->'categories') cat
            )
          )
        ELSE city
      END AS new_city
    FROM cities_arr
  )
  SELECT jsonb_agg(new_city) INTO v_updated FROM remapped;

  UPDATE country_config
     SET cities = v_updated
   WHERE country_key = 'Peru';

  RAISE NOTICE '[mig 72] country_config.Peru.cities.Corp.competitors actualizado a pegados.';
END
$cfg$;

-- ── (D) Verificación final ──────────────────────────────────────────────
DO $verify$
DECLARE
  v_state text;
BEGIN
  SELECT string_agg(competition_name || '=' || n, ', ' ORDER BY n DESC)
    INTO v_state
    FROM (
      SELECT competition_name, COUNT(*) AS n
        FROM pricing_observations
       WHERE country='Peru' AND city='Corp'
       GROUP BY competition_name
       ORDER BY n DESC
       LIMIT 20
    ) s;
  RAISE NOTICE '[mig 72] Estado final Corp: %', v_state;
  RAISE NOTICE '[mig 72] Convención canónica ahora es PEGADA (matchea Excel). Para UI, usar prettyCompetitor() de normalize.js.';
END
$verify$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- DESPUÉS DE APLICAR ESTA MIGRACIÓN:
--
-- 1. La DB queda alineada con el Excel: 'YangoPremier' (pegado), no
--    'Yango Premier' (con espacio).
--
-- 2. Hacer hard reload del browser para cargar el nuevo frontend (constants.js
--    y normalize.js ya tienen la nueva convención).
--
-- 3. Re-subir el Excel. Ahora no hay transformación intermedia —
--    'YangoPremier' del Excel entra como 'YangoPremier' a la DB.
--
-- 4. Verificar:
--    SELECT competition_name, COUNT(*) FROM pricing_observations
--    WHERE country='Peru' AND city='Corp'
--    GROUP BY competition_name ORDER BY 2 DESC;
--
--    Esperado: YangoEconomy, YangoComfort, YangoComfort+, YangoPremier,
--    YangoXL, Cabify, CabifyLite, CabifyExtraComfort, CabifyXL.
-- ════════════════════════════════════════════════════════════════════════
