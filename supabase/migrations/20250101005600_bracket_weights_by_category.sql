-- ════════════════════════════════════════════════════════════════════════
-- Migración 56 — Pesos del promedio ponderado por categoría
--
-- POR QUÉ:
--   La tabla bracket_weights hoy es (country, city, bracket, weight).
--   Eso asume que TODAS las categorías de un país comparten los mismos
--   pesos. En la realidad, Economy y Bike tienen distribuciones de
--   distancia muy distintas — un viaje Bike típico es corto, un
--   Economy promedio es median/average. Forzar mismos pesos sesga el WA.
--
-- DISEÑO:
--   - Agregar columna `category` con DEFAULT 'all' (backfill implícito)
--   - Cambiar UNIQUE a (country, city, category, bracket)
--   - Re-crear freeze_pricing_wa con cascada:
--       (country, city, category) > (country, city, 'all')
--     > (country, 'all', category) > (country, 'all', 'all')
--     > defaults hardcoded
--   - validate_country_setup relaja el umbral mínimo
--
-- RETROCOMPAT:
--   Filas existentes quedan con category='all' → mismo comportamiento
--   que antes para Peru/Colombia. El operador puede agregar pesos
--   category-specific desde la UI cuando quiera.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── A. ALTER TABLE bracket_weights ────────────────────────────────────

ALTER TABLE bracket_weights
  ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'all';

-- Reemplazar UNIQUE viejo por uno que incluya category
ALTER TABLE bracket_weights
  DROP CONSTRAINT IF EXISTS bracket_weights_country_city_bracket_key;

-- Crear nuevo UNIQUE (idempotente)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bracket_weights_country_city_category_bracket_key'
  ) THEN
    ALTER TABLE bracket_weights
      ADD CONSTRAINT bracket_weights_country_city_category_bracket_key
      UNIQUE (country, city, category, bracket);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_bracket_weights_lookup
  ON bracket_weights (country, city, category, bracket);


-- ── B. freeze_pricing_wa con cascada por categoría ────────────────────

CREATE OR REPLACE FUNCTION freeze_pricing_wa(
  p_country text,
  p_label   text DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  cnt bigint := 0;
BEGIN
  -- a) Promedios por bracket (mismo IS NOT NULL guard que mig 52)
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
  WHERE v.country          = p_country
    AND v.country          IS NOT NULL
    AND v.city             IS NOT NULL
    AND v.category         IS NOT NULL
    AND v.competition_name IS NOT NULL
    AND v.distance_bracket IS NOT NULL
  GROUP BY v.country, v.city, v.category, v.year, v.week,
           v.competition_name, v.distance_bracket
  ON CONFLICT (country, city, category, year, week, competition_name, distance_bracket)
  DO NOTHING;

  GET DIAGNOSTICS cnt = ROW_COUNT;

  -- b) WA agregado con cascada por categoría
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
    WHERE v.country          = p_country
      AND v.country          IS NOT NULL
      AND v.city             IS NOT NULL
      AND v.category         IS NOT NULL
      AND v.competition_name IS NOT NULL
      AND v.distance_bracket IS NOT NULL
    GROUP BY v.country, v.city, v.category, v.year, v.week,
             v.competition_name, v.distance_bracket
  ),
  -- ★ CASCADA: 4 niveles de fallback + defaults hardcoded
  weights_resolved AS (
    SELECT
      pb.country, pb.city, pb.category, pb.distance_bracket AS bracket,
      COALESCE(
        -- (1) Match exacto: (country, city, category, bracket)
        (SELECT bw.weight FROM bracket_weights bw
          WHERE bw.country  = pb.country
            AND bw.city     = pb.city
            AND bw.category = pb.category
            AND bw.bracket  = pb.distance_bracket
          LIMIT 1),
        -- (2) Misma city, category='all'
        (SELECT bw.weight FROM bracket_weights bw
          WHERE bw.country  = pb.country
            AND bw.city     = pb.city
            AND bw.category = 'all'
            AND bw.bracket  = pb.distance_bracket
          LIMIT 1),
        -- (3) city='all', category exacta
        (SELECT bw.weight FROM bracket_weights bw
          WHERE bw.country  = pb.country
            AND bw.city     = 'all'
            AND bw.category = pb.category
            AND bw.bracket  = pb.distance_bracket
          LIMIT 1),
        -- (4) city='all', category='all'
        (SELECT bw.weight FROM bracket_weights bw
          WHERE bw.country  = pb.country
            AND bw.city     = 'all'
            AND bw.category = 'all'
            AND bw.bracket  = pb.distance_bracket
          LIMIT 1),
        -- (5) Defaults hardcoded (último recurso)
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
      ON wr.country  = pb.country
     AND wr.city     = pb.city
     AND wr.category = pb.category
     AND wr.bracket  = pb.distance_bracket
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


-- ── C. validate_country_setup relaja umbral mínimo de bracket_weights ─
-- Antes pedía ≥ 6 filas; ahora ≥ 6 con category='all' (cualquier extra
-- por categoría es bonus, no debería penalizar el setup mínimo).

CREATE OR REPLACE FUNCTION validate_country_setup(p_country text)
RETURNS TABLE (
  check_name      text,
  status          text,
  detail          text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_bot_rules         int;
  v_bracket_weights_all int;
  v_bracket_weights_cat int;
  v_distance_thresh   int;
  v_price_val_rules   int;
  v_watermark         timestamptz;
  v_pricing_obs       int;
BEGIN
  SELECT count(*) INTO v_bot_rules         FROM bot_rules           WHERE country = p_country AND active;
  SELECT count(*) INTO v_bracket_weights_all FROM bracket_weights   WHERE country = p_country AND category = 'all';
  SELECT count(*) INTO v_bracket_weights_cat FROM bracket_weights   WHERE country = p_country AND category != 'all';
  SELECT count(*) INTO v_distance_thresh   FROM distance_thresholds WHERE country = p_country;
  SELECT count(*) INTO v_price_val_rules   FROM price_validation_rules WHERE country = p_country;
  SELECT last_synced_at INTO v_watermark   FROM bot_sync_watermark  WHERE country = p_country;
  SELECT count(*) INTO v_pricing_obs       FROM pricing_observations WHERE country = p_country;

  RETURN QUERY VALUES
    ('bot_rules',           CASE WHEN v_bot_rules         >= 4 THEN 'ok' WHEN v_bot_rules         > 0 THEN 'warning' ELSE 'error' END,
                            format('%s reglas activas', v_bot_rules)),
    ('bracket_weights',     CASE WHEN v_bracket_weights_all >= 6 THEN 'ok' WHEN v_bracket_weights_all > 0 THEN 'warning' ELSE 'error' END,
                            format('%s pesos con category=all (mínimo 6) + %s pesos por categoría',
                                   v_bracket_weights_all, v_bracket_weights_cat)),
    ('distance_thresholds', CASE WHEN v_distance_thresh   > 0  THEN 'ok' ELSE 'error' END,
                            format('%s umbrales de distancia configurados', v_distance_thresh)),
    ('price_validation',    CASE WHEN v_price_val_rules   > 0  THEN 'ok' ELSE 'warning' END,
                            format('%s reglas de outlier configuradas', v_price_val_rules)),
    ('watermark',           CASE WHEN v_watermark         IS NOT NULL THEN 'ok' ELSE 'warning' END,
                            COALESCE(v_watermark::text, 'sin watermark — primera corrida procesará todo el histórico')),
    ('observations',        CASE WHEN v_pricing_obs       > 0  THEN 'ok' ELSE 'warning' END,
                            format('%s filas en pricing_observations', v_pricing_obs));
END;
$$;


COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- POST-APLICACIÓN:
--
-- 1. Verificar backfill: todas las filas existentes deberían tener
--    category='all':
--      SELECT country, category, count(*) FROM bracket_weights GROUP BY 1,2;
--
-- 2. Agregar pesos category-specific desde /config → Pesos:
--    selector de categoría (FASE 2.2 frontend, próximo commit).
--
-- 3. Re-correr freeze_pricing_wa('Colombia') para verificar que el
--    WA sigue produciendo los mismos resultados (con category='all'
--    queda 100% retrocompat).
-- ════════════════════════════════════════════════════════════════════════
