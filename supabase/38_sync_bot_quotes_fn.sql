-- ════════════════════════════════════════════════════════════════════════
-- Migración 38 — Función sync_bot_quotes(country, limit)
--
-- Lee bot_quotes_remote (foreign table) desde el watermark, aplica
-- normalización + filtros del dashboard, e inserta en
-- pricing_observations.
--
-- Filtros aplicados (en este orden):
--   1. status = 'ok'
--   2. business_unit = 'ridehailing' (omite delivery)
--   3. country = parámetro p_country
--   4. timestamp_utc > watermark (incremental)
--   5. Match contra bot_rules — descarta filas sin regla matching
--   6. Tener al menos un precio (price_regular_value o price_discounted_value)
--   7. price_validation_rules — descarta outliers (precio mayor al threshold)
--
-- Devuelve un JSONB con stats:
--   { read, accepted, dropped, outliers, inserted, watermark }
-- ════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION sync_bot_quotes(
  p_country text DEFAULT 'Peru',
  p_limit   int  DEFAULT 50000
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path     = public
SET statement_timeout = '180s'   -- helioho responde lento, override role timeout
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
  WITH source AS (
    SELECT *
    FROM bot_quotes_remote
    WHERE country       = p_country
      AND timestamp_utc > v_watermark
      AND status        = 'ok'
      AND business_unit = 'ridehailing'
    ORDER BY timestamp_utc
    LIMIT p_limit
  ),
  normalized AS (
    SELECT
      s.*,
      -- normalize city → dbCity
      CASE lower(replace(replace(coalesce(s.city,''), ' ', '_'), '-', '_'))
        WHEN 'lima'              THEN 'Lima'
        WHEN 'trujillo'          THEN 'Trujillo'
        WHEN 'arequipa'          THEN 'Arequipa'
        WHEN 'lima_airport'      THEN 'Lima_Airport'
        WHEN 'trujillo_airport'  THEN 'Trujillo_Airport'
        WHEN 'arequipa_airport'  THEN 'Arequipa_Airport'
        WHEN 'bogota'            THEN 'Bogota'
        WHEN 'medellin'          THEN 'Medellin'
        WHEN 'cali'              THEN 'Cali'
        ELSE s.city
      END AS db_city,
      -- normalize bracket
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

  -- 5. Filtrar outliers (precio mayor al threshold de price_validation_rules)
  WITH outliers AS (
    DELETE FROM _bot_batch b
    USING (
      SELECT DISTINCT ON (b.timestamp_utc, b.country, b.db_city, b.competition_name)
        b.timestamp_utc, b.country, b.db_city, b.competition_name, pvr.max_price
      FROM _bot_batch b
      JOIN price_validation_rules pvr
        ON  pvr.country = b.country
        AND (pvr.city = b.db_city OR pvr.city = 'all')
        AND (pvr.category = b.category OR pvr.category = 'all')
        AND (pvr.competition = b.competition_name OR pvr.competition = 'all')
      ORDER BY b.timestamp_utc, b.country, b.db_city, b.competition_name,
               (pvr.city = b.db_city) DESC,
               (pvr.category = b.category) DESC,
               (pvr.competition = b.competition_name) DESC
    ) f
    WHERE b.timestamp_utc    = f.timestamp_utc
      AND b.country          = f.country
      AND b.db_city          = f.db_city
      AND b.competition_name = f.competition_name
      AND b.effective_price  > f.max_price
    RETURNING 1
  )
  SELECT count(*) INTO v_outliers FROM outliers;

  -- 6. INSERT en pricing_observations
  INSERT INTO pricing_observations (
    country, city, observed_date, observed_time, category, competition_name,
    recommended_price, price_with_discount, price_without_discount,
    eta_min, surge, distance_bracket, data_source
  )
  SELECT
    country,
    db_city,
    timestamp_local::date,
    timestamp_local::time,
    category,
    competition_name,
    price_regular_value,         -- precio de bandera
    price_discounted_value,      -- precio con descuento (si hay)
    price_regular_value,         -- alias para compatibilidad con queries existentes
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
  'Sync incremental desde la BD del bot (via FDW) hacia pricing_observations. Aplica botRules + price_validation_rules. Devuelve stats en JSONB. Usa watermark para no re-leer filas.';


-- ════════════════════════════════════════════════════════════════════════
-- probe_bot_quotes() — para el botón "Probar conexión FDW" en la UI.
-- Igual que un SELECT * LIMIT 3 pero con statement_timeout extendido.
-- ════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION probe_bot_quotes()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path       = public
SET statement_timeout = '60s'
AS $$
DECLARE
  v_count int;
  v_sample jsonb;
BEGIN
  SELECT count(*) INTO v_count FROM bot_quotes_remote;
  SELECT jsonb_agg(row_to_json(t)) INTO v_sample
    FROM (SELECT * FROM bot_quotes_remote LIMIT 3) t;
  RETURN jsonb_build_object(
    'ok',         true,
    'total_rows', v_count,
    'sample',     COALESCE(v_sample, '[]'::jsonb)
  );
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION probe_bot_quotes() TO authenticated;

COMMENT ON FUNCTION probe_bot_quotes IS
  'Smoke test del FDW. Devuelve count(*) + 3 filas de muestra. statement_timeout extendido a 60s para tolerar la lentitud de helioho.st.';
