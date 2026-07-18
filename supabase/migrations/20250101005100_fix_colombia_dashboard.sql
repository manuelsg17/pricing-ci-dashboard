-- ════════════════════════════════════════════════════════════════════════
-- Migración 51 — Triple fix Colombia
--
-- PROBLEMAS QUE RESUELVE:
--
-- 1. freeze_pricing_wa() falla con
--    "null value in column distance_bracket of relation pricing_wa_frozen
--    violates not-null constraint". Aparece al guardar cambios en
--    /config (tabs Distancias y Pesos). La RPC copia desde
--    v_bracket_weekly_avg que ahora puede tener filas con
--    distance_bracket=NULL (mig 46 dejó de poner 'very_long' por
--    default cuando km es NULL).
--    FIX: AND v.distance_bracket IS NOT NULL en ambos INSERT.
--
-- 2. Bot data Colombia "invisible" en /dashboard pero visible en /rawdata.
--    Root cause: el bot emite (app, vc, ovc) que las 12 reglas de la
--    mig 45 no cubren. Especialmente:
--      - app='yango_api' (no 'yango') — el scraper Yango usa ese alias
--      - vc='moto_a' / 'moto_b' para Picap (sub-tiers)
--      - vc='yango_moto' / 'bike' para Yango Bike
--      - vc='bike' para InDrive Bike
--      - ovc='uber_x' o '*' para Uber Economy variantes
--    FIX: INSERT ON CONFLICT en bot_rules con tuplas adicionales.
--
-- 3. normalize_distance_bracket(text) devuelve NULL para variantes no
--    anticipadas. Esas filas quedan con bracket NULL en
--    pricing_observations → visibles en /rawdata pero descartadas por
--    usePricingData.js (continue si bracketKey falsy).
--    FIX: agregar fallback de "prefijo canónico" — si el string empieza
--    con uno de los 6 canónicos, devolverlo.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── FIX 1: freeze_pricing_wa con filtro IS NOT NULL ───────────────────

CREATE OR REPLACE FUNCTION freeze_pricing_wa(
  p_country text,
  p_label   text DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  cnt bigint := 0;
BEGIN
  -- a) Promedios por bracket — excluye filas con bracket NULL
  --    (bot data sin distance_km cae acá; congelar NULL no aporta y
  --    rompe el NOT NULL de pricing_wa_frozen)
  INSERT INTO pricing_wa_frozen (
    country, city, category, year, week,
    competition_name, distance_bracket,
    avg_price, observation_count, frozen_label
  )
  SELECT
    v.country, v.city, v.category, v.year, v.week,
    v.competition_name, v.distance_bracket,
    ROUND(
      (SUM(v.avg_price * v.observation_count) / NULLIF(SUM(v.observation_count), 0))::numeric,
      2
    ) AS avg_price,
    SUM(v.observation_count) AS observation_count,
    p_label
  FROM v_bracket_weekly_avg v
  WHERE v.country = p_country
    AND v.distance_bracket IS NOT NULL   -- ★ FIX
  GROUP BY v.country, v.city, v.category, v.year, v.week,
           v.competition_name, v.distance_bracket
  ON CONFLICT (country, city, category, year, week, competition_name, distance_bracket)
  DO NOTHING;

  GET DIAGNOSTICS cnt = ROW_COUNT;

  -- b) WA agregado (distance_bracket = '_wa')
  INSERT INTO pricing_wa_frozen (
    country, city, category, year, week,
    competition_name, distance_bracket,
    avg_price, observation_count, frozen_label
  )
  WITH per_bracket AS (
    SELECT
      v.country, v.city, v.category, v.year, v.week,
      v.competition_name, v.distance_bracket,
      SUM(v.avg_price * v.observation_count) / NULLIF(SUM(v.observation_count), 0) AS avg_price,
      SUM(v.observation_count) AS total_count
    FROM v_bracket_weekly_avg v
    WHERE v.country = p_country
      AND v.distance_bracket IS NOT NULL   -- ★ FIX
    GROUP BY v.country, v.city, v.category, v.year, v.week,
             v.competition_name, v.distance_bracket
  ),
  weights_resolved AS (
    SELECT
      pb.country, pb.city, pb.distance_bracket AS bracket,
      COALESCE(
        (SELECT bw.weight FROM bracket_weights bw
          WHERE bw.country = pb.country AND bw.city = pb.city
            AND bw.bracket = pb.distance_bracket LIMIT 1),
        (SELECT bw.weight FROM bracket_weights bw
          WHERE bw.country = pb.country AND bw.city = 'all'
            AND bw.bracket = pb.distance_bracket LIMIT 1),
        CASE pb.distance_bracket
          WHEN 'very_short' THEN 0.0983
          WHEN 'short'      THEN 0.1967
          WHEN 'median'     THEN 0.1939
          WHEN 'average'    THEN 0.1384
          WHEN 'long'       THEN 0.0750
          WHEN 'very_long'  THEN 0.2970
          ELSE 0
        END
      ) AS weight
    FROM per_bracket pb
  ),
  wa_rows AS (
    SELECT
      pb.country, pb.city, pb.category, pb.year, pb.week,
      pb.competition_name,
      '_wa' AS distance_bracket,
      ROUND(
        SUM(CASE WHEN pb.avg_price > 1 THEN pb.avg_price * wr.weight ELSE 0 END)
        / NULLIF(SUM(CASE WHEN pb.avg_price > 1 THEN wr.weight ELSE 0 END), 0)::numeric,
        2
      ) AS avg_price,
      SUM(pb.total_count) AS observation_count
    FROM per_bracket pb
    JOIN weights_resolved wr
      ON wr.country = pb.country
      AND wr.city   = pb.city
      AND wr.bracket = pb.distance_bracket
    GROUP BY pb.country, pb.city, pb.category, pb.year, pb.week, pb.competition_name
  )
  SELECT country, city, category, year, week, competition_name, distance_bracket,
         avg_price, observation_count, p_label
  FROM wa_rows
  WHERE avg_price IS NOT NULL
  ON CONFLICT (country, city, category, year, week, competition_name, distance_bracket)
  DO NOTHING;

  GET DIAGNOSTICS cnt = ROW_COUNT;
  RETURN cnt;
END;
$$;


-- ── FIX 2: normalize_distance_bracket con fallback de prefijo ─────────
-- Si después de aplicar todas las strip reglas el string no matchea uno
-- de los 6 canónicos, intentar matchear como prefijo. Esto cubre cualquier
-- sufijo zone-aware que no esté en el regex (p.ej. nuevas zonas o typos
-- que aparezcan en data nueva).

CREATE OR REPLACE FUNCTION normalize_distance_bracket(p_raw text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  s text;
  canonical text;
BEGIN
  IF p_raw IS NULL OR trim(p_raw) = '' THEN
    RETURN NULL;
  END IF;

  s := lower(regexp_replace(p_raw, '[\s\-]+', '_', 'g'));
  s := regexp_replace(s, '^airport_', '');
  s := regexp_replace(s, '_(madrid|funza|mosquera|cota|chia|soacha|cajica|tenjo|sopo|sibate)$', '');
  s := regexp_replace(s, '_(zona_sur|zona_norte|zona_centro|zona_este|zona_oeste|sur|norte|centro|este|oeste)$', '');
  s := regexp_replace(s, '_(a|b)$', '');

  IF s = 'medium'     THEN s := 'median'; END IF;
  IF s = 'very short' THEN s := 'very_short'; END IF;
  IF s = 'very long'  THEN s := 'very_long'; END IF;

  IF s IN ('very_short', 'short', 'median', 'average', 'long', 'very_long') THEN
    RETURN s;
  END IF;

  -- ★ NUEVO: fallback de prefijo. Probar very_long ANTES de long para
  -- que 'very_long_xxx' no matchee 'long'. Misma lógica con very_short.
  FOREACH canonical IN ARRAY ARRAY['very_short', 'very_long', 'short', 'median', 'average', 'long'] LOOP
    IF s LIKE canonical || '%' THEN
      RETURN canonical;
    END IF;
  END LOOP;

  RETURN NULL;
END;
$$;


-- ── FIX 3: Bot rules adicionales para Colombia ────────────────────────
-- Cubre los (app, vc, ovc) que el bot real emite y que las 12 reglas
-- iniciales no anticipaban. ON CONFLICT idempotente: re-correr no rompe.

INSERT INTO bot_rules (country, app, vc, ovc, competition_name, category, cities, active) VALUES
  -- Yango con app='yango_api' (el scraper Yango usa este alias, igual que Perú)
  ('Colombia', 'yango_api', 'economy',    'economy',  'Yango',   'Economy', '{}', true),
  ('Colombia', 'yango_api', 'comfort',    'comfort',  'Yango',   'Comfort', '{}', true),
  ('Colombia', 'yango_api', 'moto',       '*',        'Yango',   'Bike',    '{}', true),
  ('Colombia', 'yango_api', 'yango_moto', '*',        'Yango',   'Bike',    '{}', true),
  ('Colombia', 'yango_api', 'bike',       '*',        'Yango',   'Bike',    '{}', true),
  -- Yango Bike variantes con app='yango'
  ('Colombia', 'yango',     'yango_moto', '*',        'Yango',   'Bike',    '{}', true),
  ('Colombia', 'yango',     'bike',       '*',        'Yango',   'Bike',    '{}', true),
  -- InDrive Bike variantes
  ('Colombia', 'indrive',   'bike',       '*',        'InDrive', 'Bike',    '{}', true),
  -- InDrive Comfort sin acento (variante regional)
  ('Colombia', 'indrive',   'comfort',    'comfort',  'InDrive', 'Comfort', '{}', true),
  -- Picap tiers (moto_a/moto_b son sub-tiers Picap)
  ('Colombia', 'picap',     'moto_a',     '*',        'Picap',   'Bike',    '{}', true),
  ('Colombia', 'picap',     'moto_b',     '*',        'Picap',   'Bike',    '{}', true),
  ('Colombia', 'picap',     'bike',       '*',        'Picap',   'Bike',    '{}', true),
  -- Didi Economy variante regional ('economy' como ovc en lugar de 'express')
  ('Colombia', 'didi',      'economy',    'economy',  'Didi',    'Economy', '{}', true),
  -- Uber variantes Economy
  ('Colombia', 'uber',      'economy',    'uber_x',   'Uber',    'Economy', '{}', true),
  ('Colombia', 'uber',      'economy',    '*',        'Uber',    'Economy', '{}', true)
ON CONFLICT (country, app, vc, ovc) DO UPDATE
  SET active           = true,
      competition_name = EXCLUDED.competition_name,
      category         = EXCLUDED.category,
      cities           = EXCLUDED.cities;


-- ── Backfill: re-procesar pricing_observations con nuevo normalizer ───
-- Las filas que ya están en pricing_observations con bracket NULL pueden
-- recuperarse si vinieron de una variante que ahora SÍ matchea con el
-- fallback de prefijo. Aplicamos solo si hay raw_bracket guardado en
-- distance_km (no aplica) — en realidad las filas con bracket NULL ya
-- no tienen el raw original. Solo podemos:
--   a) Re-correr sync_bot_quotes con watermark viejo (manual)
--   b) Refrescar el normalize de filas no canónicas (poco probable que
--      queden no canónicas tras mig 47)

UPDATE pricing_observations
SET distance_bracket = normalize_distance_bracket(distance_bracket)
WHERE distance_bracket IS NOT NULL
  AND distance_bracket NOT IN ('very_short', 'short', 'median', 'average', 'long', 'very_long')
  AND country = 'Colombia'
  AND data_source = 'bot';

-- Audit + reset watermark Colombia para re-procesar últimas 48h
DO $$
DECLARE
  v_total int; v_null int; v_canon int;
  v_rules_count int;
BEGIN
  SELECT count(*),
         count(*) FILTER (WHERE distance_bracket IS NULL),
         count(*) FILTER (WHERE distance_bracket IN ('very_short','short','median','average','long','very_long'))
    INTO v_total, v_null, v_canon
  FROM pricing_observations
  WHERE country = 'Colombia' AND data_source = 'bot';

  SELECT count(*) INTO v_rules_count FROM bot_rules WHERE country = 'Colombia' AND active;

  RAISE NOTICE 'Colombia bot: total=% canónicos=% null=% | reglas activas=%',
               v_total, v_canon, v_null, v_rules_count;
END $$;

-- Retroceder watermark de Colombia 7 días para re-pedir al FDW las
-- filas que se dropearon previamente (ahora matchearán las reglas nuevas).
UPDATE bot_sync_watermark
SET last_synced_at = GREATEST(
      last_synced_at - interval '7 days',
      '1970-01-01T00:00:00+00:00'::timestamptz
    ),
    updated_at = now()
WHERE country = 'Colombia';

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- POST-APLICACIÓN:
--
-- 1. Disparar sync Colombia (UI Bot DB Sync, GitHub Actions o
--    SELECT sync_bot_quotes('Colombia', 5000)).
--    El watermark fue retrocedido 7d arriba, así que esta corrida re-
--    pide al FDW las filas dropeadas previamente.
--
-- 2. Verificar:
--    SELECT competition_name, count(*)
--    FROM pricing_observations
--    WHERE country='Colombia' AND data_source='bot'
--      AND observed_date > current_date - interval '7 days'
--    GROUP BY 1 ORDER BY 2 DESC;
--    → Debería aparecer Yango, Didi, InDrive, Uber, Picap.
--
-- 3. Revisar dropped_combos del último sync:
--    SELECT jsonb_pretty(notes->'dropped_combos')
--    FROM bot_sync_log
--    WHERE country='Colombia' AND status='ok'
--    ORDER BY started_at DESC LIMIT 1;
--    → Si todavía aparecen combos dropeadas, agregarlas a bot_rules.
--
-- 4. Probar /config tabs Distancias/Pesos → guardar cambios.
--    → Ya no debería aparecer el error de pricing_wa_frozen.
-- ════════════════════════════════════════════════════════════════════════
