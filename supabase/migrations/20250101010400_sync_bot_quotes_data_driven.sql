-- ════════════════════════════════════════════════════════════════════════
-- Migración 64 — sync_bot_quotes data-driven (multi-país escalable)
--
-- PROBLEMA QUE RESUELVE:
--   La versión anterior de sync_bot_quotes (mig 38) tenía un CASE
--   lower(s.city) hardcoded que solo mapeaba ciudades de Peru y Colombia:
--       WHEN 'lima' THEN 'Lima'
--       WHEN 'bogota' THEN 'Bogota'
--       ...
--   Cualquier país nuevo onboardeado vía wizard (Bolivia, Nepal, etc.)
--   no encontraba match y caía al ELSE s.city → datos basura llegaban a
--   pricing_observations (ej: city='la_paz' en vez de 'La_Paz') y se
--   perdían en el join con bot_rules (que usa db_city).
--
-- SOLUCIÓN:
--   Leer el mapping desde country_config.cities (jsonb). Cada ciudad
--   onboardeada tiene { uiName, dbName, botKey } — el botKey es lo que
--   manda el bot, dbName es lo que va a la DB.
--
--   Cascada de resolución (en orden):
--     1. country_config.cities lookup por botKey/dbName lowercase
--     2. Hardcoded CASE legacy (Perú/Colombia) — para compat con países
--        que existen en COUNTRY_CONFIG JS pero todavía no en DB
--     3. Raw city name (último recurso)
--
-- COMPAT:
--   - Si Peru/Colombia ya están en country_config (vía botón "Hacer
--     editable" del wizard), el paso 1 los resuelve y el legacy nunca se
--     ejecuta.
--   - Si NO están en country_config, sigue funcionando exactamente como
--     antes via paso 2.
--   - Países nuevos del wizard funcionan automáticamente sin tocar este
--     archivo.
--
-- VERIFICACIÓN POST-APLICACIÓN:
--   1. SELECT sync_bot_quotes('Peru', 10);  -- debe seguir funcionando
--   2. SELECT sync_bot_quotes('Bolivia', 10); -- antes daba 0 inserts
--      por mismatch de city; ahora debe encontrar matches si bot_rules
--      tiene reglas seedeadas.
-- ════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION sync_bot_quotes(
  p_country text DEFAULT 'Peru',
  p_limit   int  DEFAULT 50000
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path     = public, pg_temp
SET statement_timeout = '180s'
AS $$
DECLARE
  v_started_at timestamptz := now();
  v_log_id     bigint;
  v_watermark  timestamptz;
  v_max_ts     timestamptz;
  v_read       int := 0;
  v_matched    int := 0;
  v_inserted   int := 0;
  v_outliers   int := 0;
  v_dropped    int := 0;
  v_err        text;
BEGIN
  -- 1. Log entry
  INSERT INTO bot_sync_log (country, status, notes)
  VALUES (p_country, 'running', jsonb_build_object('mode', 'fdw', 'limit', p_limit))
  RETURNING id INTO v_log_id;

  -- 2. Watermark
  SELECT last_synced_at INTO v_watermark
  FROM bot_sync_watermark WHERE country = p_country;
  v_watermark := COALESCE(v_watermark, '1970-01-01'::timestamptz);

  -- 3. Pull + normalize en una temp table (evita N round-trips a fudobi)
  CREATE TEMP TABLE _bot_batch ON COMMIT DROP AS
  WITH
  -- City mapping data-driven desde country_config.cities (jsonb).
  -- Cada ciudad tiene { uiName, dbName, botKey, isVirtual, categories: [...] }.
  -- Indexamos por TODAS las variantes que el bot podría enviar:
  --   botKey (lo "oficial"), dbName.lower, uiName.lower (tolerancia).
  city_map AS (
    SELECT
      lower(coalesce(c->>'botKey', c->>'dbName', c->>'uiName')) AS bot_key,
      (c->>'dbName')::text AS db_name
    FROM country_config cc,
         jsonb_array_elements(cc.cities) c
    WHERE cc.country_key = p_country
      AND c ? 'dbName'
    UNION
    -- Variantes adicionales por dbName/uiName en lowercase
    SELECT
      lower(c->>'dbName') AS bot_key,
      (c->>'dbName')::text AS db_name
    FROM country_config cc,
         jsonb_array_elements(cc.cities) c
    WHERE cc.country_key = p_country
      AND c ? 'dbName'
    UNION
    SELECT
      lower(c->>'uiName') AS bot_key,
      (c->>'dbName')::text AS db_name
    FROM country_config cc,
         jsonb_array_elements(cc.cities) c
    WHERE cc.country_key = p_country
      AND c ? 'uiName'
      AND c ? 'dbName'
  ),
  source AS (
    SELECT *
    FROM bot_quotes_remote
    WHERE country               = p_country
      AND timestamp_utc         > v_watermark
      AND lower(status)         = 'ok'
      AND lower(business_unit)  = 'ridehailing'
    ORDER BY timestamp_utc
    LIMIT p_limit
  ),
  normalized AS (
    SELECT
      s.*,
      -- Normalizar bot city → dbCity con cascada:
      --   1. country_config lookup (data-driven, multi-país)
      --   2. Hardcoded legacy CASE para Peru/Colombia (si no están en DB)
      --   3. Raw city name (último recurso)
      COALESCE(
        (SELECT cm.db_name
         FROM city_map cm
         WHERE cm.bot_key = lower(replace(replace(coalesce(s.city,''), ' ', '_'), '-', '_'))
         LIMIT 1),
        CASE lower(replace(replace(coalesce(s.city,''), ' ', '_'), '-', '_'))
          WHEN 'lima'              THEN 'Lima'
          WHEN 'trujillo'          THEN 'Trujillo'
          WHEN 'arequipa'          THEN 'Arequipa'
          WHEN 'lima_airport'      THEN 'Lima_Airport'
          WHEN 'trujillo_airport'  THEN 'Trujillo_Airport'
          WHEN 'arequipa_airport'  THEN 'Arequipa_Airport'
          WHEN 'bogota'            THEN 'Bogota'
          WHEN 'bogotá'            THEN 'Bogota'
          WHEN 'cali'              THEN 'Cali'
          WHEN 'barranquilla'      THEN 'Barranquilla'
          WHEN 'baq'               THEN 'Barranquilla'
          ELSE NULL
        END,
        s.city
      ) AS db_city,
      -- normalize bracket (sin cambios desde mig 38)
      CASE lower(coalesce(s.distance_bracket,''))
        WHEN 'very short' THEN 'very_short'
        WHEN 'very long'  THEN 'very_long'
        WHEN 'short'      THEN 'short'
        WHEN 'median'     THEN 'median'
        WHEN 'average'    THEN 'average'
        WHEN 'long'       THEN 'long'
        ELSE NULLIF(lower(replace(s.distance_bracket, ' ', '_')), '')
      END AS norm_bracket,
      lower(coalesce(s.app, '')) AS app_lc,
      lower(coalesce(s.vehicle_category, '')) AS vc_lc,
      lower(coalesce(s.observed_vehicle_category, '')) AS ovc_lc,
      coalesce(s.price_regular_value, s.price_discounted_value) AS effective_price
    FROM source s
  )
  SELECT
    n.timestamp_utc,
    n.timestamp_local,
    n.country,
    n.db_city,
    n.norm_bracket,
    n.app_lc, n.vc_lc, n.ovc_lc,
    n.price_regular_value,
    n.price_discounted_value,
    n.effective_price,
    n.eta_mins,
    n.surge,
    br.competition_name,
    br.category
  FROM normalized n
  LEFT JOIN bot_rules br
    ON  br.country  = n.country
    AND br.active
    AND br.app      = n.app_lc
    AND br.vc       = n.vc_lc
    AND (br.ovc = '*' OR br.ovc = n.ovc_lc)
    AND (cardinality(br.cities) = 0 OR n.db_city = ANY(br.cities));

  GET DIAGNOSTICS v_read = ROW_COUNT;

  -- watermark del batch (antes de filtrar — se mueve aunque algunas filas se descarten)
  SELECT MAX(timestamp_utc) INTO v_max_ts FROM _bot_batch;

  -- 4. Filtrar filas sin regla o sin precio
  v_matched := (SELECT count(*) FROM _bot_batch WHERE competition_name IS NOT NULL AND effective_price IS NOT NULL);
  v_dropped := v_read - v_matched;

  DELETE FROM _bot_batch
  WHERE competition_name IS NULL
     OR effective_price  IS NULL;

  -- 5. Filtrar outliers
  DELETE FROM _bot_batch b
  WHERE EXISTS (
    SELECT 1 FROM price_validation_rules pvr
    WHERE pvr.country = b.country
      AND (pvr.city        = b.db_city          OR pvr.city = 'all')
      AND (pvr.category    = b.category         OR pvr.category = 'all')
      AND (pvr.competition = b.competition_name OR pvr.competition = 'all')
      AND b.effective_price > pvr.max_price
  );
  GET DIAGNOSTICS v_outliers = ROW_COUNT;

  -- 6. INSERT en pricing_observations
  INSERT INTO pricing_observations (
    country, city, observed_date, observed_time, category, competition_name,
    recommended_price, price_with_discount, price_without_discount,
    eta_min, surge, distance_bracket, data_source
  )
  SELECT
    country,
    db_city,
    (timestamp_utc AT TIME ZONE COALESCE(timezone, 'UTC'))::date AS observed_date,
    (timestamp_utc AT TIME ZONE COALESCE(timezone, 'UTC'))::time AS observed_time,
    category,
    competition_name,
    price_regular_value,
    price_discounted_value,
    price_regular_value,
    eta_mins,
    surge,
    norm_bracket,
    'bot'
  FROM _bot_batch;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  -- 7. Actualizar watermark
  IF v_max_ts IS NOT NULL THEN
    INSERT INTO bot_sync_watermark (country, last_synced_at, updated_at)
    VALUES (p_country, v_max_ts, now())
    ON CONFLICT (country) DO UPDATE
      SET last_synced_at = EXCLUDED.last_synced_at,
          updated_at     = now();
  END IF;

  -- 8. Cerrar log
  UPDATE bot_sync_log SET
    status         = 'ok',
    finished_at    = now(),
    read_count     = v_read,
    inserted_count = v_inserted,
    dropped_count  = v_dropped,
    outlier_count  = v_outliers
  WHERE id = v_log_id;

  RETURN jsonb_build_object(
    'ok', true,
    'mode', 'fdw',
    'country', p_country,
    'stats', jsonb_build_object(
      'read', v_read,
      'matched', v_matched,
      'dropped', v_dropped,
      'outliers', v_outliers,
      'inserted', v_inserted
    ),
    'watermark', v_max_ts
  );

EXCEPTION WHEN OTHERS THEN
  v_err := SQLERRM;
  UPDATE bot_sync_log SET
    status      = 'error',
    finished_at = now(),
    error_msg   = v_err,
    read_count     = v_read,
    inserted_count = v_inserted,
    dropped_count  = v_dropped,
    outlier_count  = v_outliers
  WHERE id = v_log_id;
  RETURN jsonb_build_object('ok', false, 'error', v_err, 'log_id', v_log_id);
END;
$$;

GRANT EXECUTE ON FUNCTION sync_bot_quotes(text, int) TO authenticated;

COMMENT ON FUNCTION sync_bot_quotes IS
  'Sync incremental desde el bot via FDW. v2 (mig 64): mapping de city es data-driven desde country_config.cities. Legacy hardcoded CASE preservado como fallback para Peru/Colombia que aún no están en country_config.';

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
--
-- 1. Para un país onboardeado vía wizard (ej: Bolivia):
--      SELECT cities FROM country_config WHERE country_key = 'Bolivia';
--    → debe devolver un array con {uiName, dbName, botKey}.
--
-- 2. Correr la sync manualmente:
--      SELECT sync_bot_quotes('Bolivia', 100);
--    → si bot_rules está seedeado para Bolivia, debe insertar > 0 filas.
--
-- 3. Verificar que el mapping efectivamente resolvió:
--      SELECT DISTINCT city FROM pricing_observations
--      WHERE country = 'Bolivia' AND data_source = 'bot';
--    → ciudades en formato dbName (ej: 'La_Paz', no 'la_paz').
-- ════════════════════════════════════════════════════════════════════════
