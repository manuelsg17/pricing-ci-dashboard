-- ════════════════════════════════════════════════════════════════════════
-- Migración 52 — Hardening multi-país preventivo
--
-- CONTEXTO:
--   Acabamos de tener varios bugs causados por assumptions hardcoded de
--   Perú al sumar Colombia (bracket NOT NULL, app='yango' vs 'yango_api',
--   etc.). Esta migración cierra brechas similares antes de sumar
--   Bolivia / Nepal / Venezuela / Zambia.
--
-- FIXES INCLUIDOS:
--
--   A. freeze_pricing_wa(): además de distance_bracket IS NOT NULL
--      (mig 51), agregar filtros defensivos para city, category,
--      competition_name. Si alguna fila trae NULL en cualquiera de esas
--      claves, no debe romper el snapshot.
--
--   B. RPC validate_country_setup(p_country) — devuelve checklist:
--      tiene cities? categories? bot_rules? bracket_weights?
--      distance_thresholds? price_validation_rules? watermark?
--      El operador la corre antes de habilitar un país y obtiene un
--      diagnóstico claro de qué le falta seedear.
--
--   C. RPC validate_fdw_schema() — verifica que bot_quotes_remote
--      expone las columnas que sync_bot_quotes asume. Si en el futuro
--      el bot externo cambia su schema (como pasó con distance_km que
--      nunca se expuso), esto lo detecta antes de la corrida.
--
--   D. RPC list_unmatched_combos(p_country, p_days) — wrapper más
--      simple sobre bot_sync_log.notes->'dropped_combos' para que la
--      UI pueda renderizar las combinaciones que no matchean reglas.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── A. freeze_pricing_wa con filtros defensivos completos ─────────────

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
  -- a) Promedios por bracket (defensivo: todos los keys NOT NULL)
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
    AND v.country          IS NOT NULL   -- ★ FIX 52
    AND v.city             IS NOT NULL   -- ★ FIX 52
    AND v.category         IS NOT NULL   -- ★ FIX 52
    AND v.competition_name IS NOT NULL   -- ★ FIX 52
    AND v.distance_bracket IS NOT NULL   -- mig 51
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
    WHERE v.country          = p_country
      AND v.country          IS NOT NULL   -- ★ FIX 52
      AND v.city             IS NOT NULL   -- ★ FIX 52
      AND v.category         IS NOT NULL   -- ★ FIX 52
      AND v.competition_name IS NOT NULL   -- ★ FIX 52
      AND v.distance_bracket IS NOT NULL
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


-- ── B. validate_country_setup ─────────────────────────────────────────
-- Checklist de configuración por país. El operador la corre antes de
-- promover un país a producción.

CREATE OR REPLACE FUNCTION validate_country_setup(p_country text)
RETURNS TABLE (
  check_name      text,
  status          text,   -- 'ok' | 'warning' | 'error'
  detail          text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_bot_rules         int;
  v_bracket_weights   int;
  v_distance_thresh   int;
  v_price_val_rules   int;
  v_watermark         timestamptz;
  v_pricing_obs       int;
BEGIN
  SELECT count(*) INTO v_bot_rules         FROM bot_rules           WHERE country = p_country AND active;
  SELECT count(*) INTO v_bracket_weights   FROM bracket_weights     WHERE country = p_country;
  SELECT count(*) INTO v_distance_thresh   FROM distance_thresholds WHERE country = p_country;
  SELECT count(*) INTO v_price_val_rules   FROM price_validation_rules WHERE country = p_country;
  SELECT last_synced_at INTO v_watermark   FROM bot_sync_watermark  WHERE country = p_country;
  SELECT count(*) INTO v_pricing_obs       FROM pricing_observations WHERE country = p_country;

  RETURN QUERY VALUES
    ('bot_rules',           CASE WHEN v_bot_rules         >= 4 THEN 'ok' WHEN v_bot_rules         > 0 THEN 'warning' ELSE 'error' END,
                            format('%s reglas activas', v_bot_rules)),
    ('bracket_weights',     CASE WHEN v_bracket_weights   >= 6 THEN 'ok' WHEN v_bracket_weights   > 0 THEN 'warning' ELSE 'error' END,
                            format('%s pesos configurados (mínimo 6: uno por bracket)', v_bracket_weights)),
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

GRANT EXECUTE ON FUNCTION validate_country_setup(text) TO authenticated;

COMMENT ON FUNCTION validate_country_setup(text) IS
  'Devuelve checklist de setup para un país. Útil antes de promover un país a producción o cuando se sospecha de config faltante.';


-- ── C. validate_fdw_schema ────────────────────────────────────────────
-- Verifica que bot_quotes_remote expone las columnas que sync_bot_quotes
-- asume. Si el bot externo cambia schema, esto lo detecta.

CREATE OR REPLACE FUNCTION validate_fdw_schema()
RETURNS TABLE (
  column_name text,
  present     boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_required text[] := ARRAY[
    'country', 'timestamp_utc', 'timestamp_local', 'timezone',
    'status', 'business_unit', 'city',
    'app', 'vehicle_category', 'observed_vehicle_category',
    'price_regular_value', 'price_discounted_value',
    'eta_mins', 'surge', 'distance_bracket'
  ];
  v_col text;
BEGIN
  FOREACH v_col IN ARRAY v_required LOOP
    column_name := v_col;
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'bot_quotes_remote'
        AND column_name = v_col
    ) INTO present;
    RETURN NEXT;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION validate_fdw_schema() TO authenticated;

COMMENT ON FUNCTION validate_fdw_schema() IS
  'Verifica que el FDW bot_quotes_remote expone las columnas que sync_bot_quotes asume. Correr después de re-deployar el bot externo.';


-- ── D. list_unmatched_combos ──────────────────────────────────────────
-- Devuelve las top combinaciones (app, vc, ovc, city) que no matchearon
-- ninguna regla en los últimos N días, agregando varios sync_log
-- entries. UI puede mostrarlas con un botón "agregar como regla".

CREATE OR REPLACE FUNCTION list_unmatched_combos(
  p_country text,
  p_days    int DEFAULT 2
) RETURNS TABLE (
  app      text,
  vc       text,
  ovc      text,
  db_city  text,
  total_n  bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH combos AS (
    SELECT (combo->>'app')     AS app,
           (combo->>'vc')      AS vc,
           (combo->>'ovc')     AS ovc,
           (combo->>'db_city') AS db_city,
           ((combo->>'n')::bigint) AS n
    FROM bot_sync_log,
         LATERAL jsonb_array_elements(notes->'dropped_combos') AS combo
    WHERE country = p_country
      AND status  = 'ok'
      AND started_at > NOW() - (p_days || ' days')::interval
      AND notes ? 'dropped_combos'
  )
  SELECT app, vc, ovc, db_city, SUM(n) AS total_n
  FROM combos
  GROUP BY app, vc, ovc, db_city
  ORDER BY SUM(n) DESC
  LIMIT 50;
$$;

GRANT EXECUTE ON FUNCTION list_unmatched_combos(text, int) TO authenticated;

COMMENT ON FUNCTION list_unmatched_combos(text, int) IS
  'Agrega los dropped_combos del bot_sync_log de los últimos N días por país. UI puede mostrarlos con un click-to-add a bot_rules.';


COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- USAR ASÍ:
--
--   -- Antes de habilitar un país, correr:
--   SELECT * FROM validate_country_setup('Bolivia');
--   -- Si aparece 'error' → seedear esa tabla primero.
--
--   -- Después de cualquier cambio en el bot externo:
--   SELECT * FROM validate_fdw_schema();
--
--   -- Para diagnosticar drops sin tocar FDW (rápido):
--   SELECT * FROM list_unmatched_combos('Colombia', 7);
-- ════════════════════════════════════════════════════════════════════════
