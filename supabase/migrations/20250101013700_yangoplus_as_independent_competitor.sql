-- ════════════════════════════════════════════════════════════════════════
-- Migración 97 — YangoPlus competidor independiente en Corp
--
-- CONTEXTO:
--   La mig 70/72 mapeaba 'YangoPlus' → 'YangoComfort+' como hipótesis
--   (precios similares ~7-10 S/). Stakeholder confirma 2026-05-27 que
--   son productos distintos. A partir de ahora YangoPlus es un
--   competidor first-class.
--
-- QUÉ HACE:
--   1. Reemplaza normalize_competitor_name(): 'yangoplus' → 'YangoPlus'
--      (antes devolvía 'YangoComfort+').
--   2. Agrega 'YangoPlus' al array competitors de country_config Peru
--      cities[Corp].categories[Corp]. Insertado después de YangoXL
--      para mantener orden Yango primero, Cabify después.
--
-- DATA HISTÓRICA:
--   Las filas previamente normalizadas como 'YangoComfort+' que en
--   realidad eran YangoPlus quedan irrecuperables — no hay forma de
--   distinguirlas de YangoComfort+ legítimas. El usuario puede:
--     a) Aceptar la pérdida y empezar a contar YangoPlus desde hoy.
--     b) Re-subir el/los Excel originales — el upsert_pricing_batch
--        (DELETE+INSERT por rango fecha+ciudad) las reemplaza
--        atómicamente.
--
-- COMPLEMENTO EN FRONTEND:
--   - src/lib/normalize.js debe alinear el alias yangoplus → YangoPlus
--     (espejo JS de esta función SQL).
--   - src/lib/constants.js debe agregar color para YangoPlus +
--     CORP_DISPLAY_NAMES 'YangoPlus' → 'Yango Plus'.
--   - CountryContext.jsx cache key debe bumpear v5 → v6.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── (A) Reemplazar la función normalize_competitor_name ────────────────
CREATE OR REPLACE FUNCTION public.normalize_competitor_name(
  raw  text,
  city text
) RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
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

  -- (2) Corp aliases — sólo si city='Corp'. Output pegado.
  IF city = 'Corp' THEN
    fp := regexp_replace(lc, '\s+', '', 'g');
    CASE fp
      WHEN 'yangoeconomy'        THEN RETURN 'YangoEconomy';
      WHEN 'yangocomfort'        THEN RETURN 'YangoComfort';
      WHEN 'yangocomfort+'       THEN RETURN 'YangoComfort+';
      WHEN 'yangocomfortplus'    THEN RETURN 'YangoComfort+';
      -- Mig 97: yangoplus ahora es competidor independiente, NO alias de Comfort+.
      WHEN 'yangoplus'           THEN RETURN 'YangoPlus';
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

-- ── (B) Agregar 'YangoPlus' al array Corp competitors en country_config ─
DO $add_yangoplus$
DECLARE
  v_before jsonb;
  v_after  jsonb;
BEGIN
  SELECT cat->'competitors' INTO v_before
  FROM country_config,
       jsonb_array_elements(cities) AS city_elem,
       jsonb_array_elements(city_elem->'categories') AS cat
  WHERE country_key = 'Peru'
    AND city_elem->>'dbName' = 'Corp'
    AND cat->>'dbName' = 'Corp';

  -- Reescribe el array completo con YangoPlus insertado después de YangoXL.
  -- Idempotente: si ya está, no se duplica.
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
                      '["YangoEconomy","YangoComfort","YangoComfort+","YangoPremier","YangoXL","YangoPlus","Cabify","CabifyLite","CabifyExtraComfort","CabifyXL"]'::jsonb
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

  SELECT cat->'competitors' INTO v_after
  FROM country_config,
       jsonb_array_elements(cities) AS city_elem,
       jsonb_array_elements(city_elem->'categories') AS cat
  WHERE country_key = 'Peru'
    AND city_elem->>'dbName' = 'Corp'
    AND cat->>'dbName' = 'Corp';

  RAISE NOTICE '[mig 97] competitors antes : %', v_before;
  RAISE NOTICE '[mig 97] competitors después: %', v_after;
END
$add_yangoplus$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
--   1. Función:
--      SELECT public.normalize_competitor_name('YangoPlus', 'Corp');
--      → 'YangoPlus'
--
--   2. country_config:
--      SELECT cat->'competitors'
--      FROM country_config,
--           jsonb_array_elements(cities) AS city_elem,
--           jsonb_array_elements(city_elem->'categories') AS cat
--      WHERE country_key='Peru' AND city_elem->>'dbName'='Corp' AND cat->>'dbName'='Corp';
--      → debe incluir "YangoPlus" después de "YangoXL"
--
--   3. Re-subir el Excel desde Upload — las nuevas filas YangoPlus van
--      a quedar con competition_name='YangoPlus' (no se aplastan más
--      a YangoComfort+).
-- ════════════════════════════════════════════════════════════════════════
