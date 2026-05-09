-- ════════════════════════════════════════════════════════════════════════
-- Migración 49 — Log de combinaciones dropeadas en cada sync del bot
--
-- POR QUÉ:
--   El query directo o vía RPC contra bot_quotes_remote (FDW) timeouts
--   constantemente porque helioho.st es lento. Pero el sync mismo ya
--   conecta (con statement_timeout=180s) y procesa miles de rows. Si
--   en ese mismo procesamiento agregamos el cálculo de qué (app, vc,
--   ovc) NO matchearon una regla, queda gratis y la información va
--   directo a bot_sync_log.notes.
--
-- LECTURA POSTERIOR (instantánea, sin tocar FDW):
--   SELECT
--     started_at,
--     read_count, inserted_count, dropped_count,
--     notes->'dropped_combos' AS dropped_combos
--   FROM bot_sync_log
--   WHERE country = 'Colombia'
--   ORDER BY started_at DESC LIMIT 5;
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION sync_bot_quotes(
  p_country text DEFAULT 'Peru',
  p_limit   int  DEFAULT 5000
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET statement_timeout = '180s'
AS $func$
DECLARE
  v_watermark      timestamptz;
  v_max_ts         timestamptz;
  v_read           int := 0;
  v_matched        int := 0;
  v_dropped        int := 0;
  v_outliers       int := 0;
  v_inserted       int := 0;
  v_log_id         bigint;
  v_dropped_combos jsonb;
BEGIN
  -- Pre-checks
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'bot_sync_log') THEN
    RAISE EXCEPTION 'Tabla bot_sync_log no existe — corre migración 35';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'bot_quotes_remote' AND relkind = 'f') THEN
    RAISE EXCEPTION 'Foreign table bot_quotes_remote no existe — corre migración 36';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'bot_rules') THEN
    RAISE EXCEPTION 'Tabla bot_rules no existe — corre migración 37';
  END IF;

  INSERT INTO bot_sync_log (country, status, notes)
  VALUES (p_country, 'running',
          jsonb_build_object('source', 'sync_bot_quotes_v49', 'limit', p_limit))
  RETURNING id INTO v_log_id;

  SELECT last_synced_at INTO v_watermark
  FROM bot_sync_watermark WHERE country = p_country;
  IF v_watermark IS NULL THEN
    v_watermark := '1970-01-01T00:00:00+00:00'::timestamptz;
  END IF;

  CREATE TEMP TABLE _bot_batch ON COMMIT DROP AS
  WITH source AS (
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
        ELSE s.city
      END AS db_city,
      normalize_distance_bracket(s.distance_bracket) AS norm_bracket,
      lower(coalesce(s.app, '')) AS app_lc,
      lower(coalesce(s.vehicle_category, '')) AS vc_lc,
      lower(coalesce(s.observed_vehicle_category, '')) AS ovc_lc,
      coalesce(s.price_regular_value, s.price_discounted_value) AS effective_price
    FROM source s
  )
  SELECT
    n.timestamp_utc,
    n.timestamp_local,
    n.timezone,
    n.country,
    n.db_city,
    n.norm_bracket,
    n.distance_km,
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
  SELECT MAX(timestamp_utc) INTO v_max_ts FROM _bot_batch;

  v_matched := (SELECT count(*) FROM _bot_batch
                WHERE competition_name IS NOT NULL AND effective_price IS NOT NULL);
  v_dropped := v_read - v_matched;

  -- ★ NUEVO: capturar top 30 combinaciones (app, vc, ovc, db_city) que
  -- NO matchearon ninguna regla. Esto va al notes JSON del bot_sync_log
  -- y nos permite ajustar bot_rules sin necesidad de queries pesadas
  -- contra bot_quotes_remote después.
  SELECT jsonb_agg(combo) INTO v_dropped_combos
  FROM (
    SELECT jsonb_build_object(
      'app',     app_lc,
      'vc',      vc_lc,
      'ovc',     ovc_lc,
      'db_city', db_city,
      'n',       count(*)
    ) AS combo
    FROM _bot_batch
    WHERE competition_name IS NULL
    GROUP BY app_lc, vc_lc, ovc_lc, db_city
    ORDER BY count(*) DESC
    LIMIT 30
  ) sub;

  DELETE FROM _bot_batch
  WHERE competition_name IS NULL OR effective_price IS NULL;

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

  INSERT INTO pricing_observations (
    country, city, observed_date, observed_time, category, competition_name,
    recommended_price, price_with_discount, price_without_discount,
    eta_min, surge, distance_bracket, distance_km, data_source
  )
  SELECT
    country,
    db_city,
    (timestamp_utc AT TIME ZONE COALESCE(timezone, 'UTC'))::date,
    (timestamp_utc AT TIME ZONE COALESCE(timezone, 'UTC'))::time,
    category,
    competition_name,
    price_regular_value,
    price_discounted_value,
    price_regular_value,
    eta_mins,
    surge,
    norm_bracket,
    distance_km,
    'bot'
  FROM _bot_batch;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_max_ts IS NOT NULL THEN
    INSERT INTO bot_sync_watermark (country, last_synced_at, updated_at)
    VALUES (p_country, v_max_ts, now())
    ON CONFLICT (country) DO UPDATE
      SET last_synced_at = EXCLUDED.last_synced_at,
          updated_at     = now();
  END IF;

  -- Cerrar log con dropped_combos como info diagnóstica
  UPDATE bot_sync_log SET
    status         = 'ok',
    finished_at    = now(),
    read_count     = v_read,
    inserted_count = v_inserted,
    dropped_count  = v_dropped,
    outlier_count  = v_outliers,
    notes          = notes || jsonb_build_object(
      'dropped_combos', COALESCE(v_dropped_combos, '[]'::jsonb)
    )
  WHERE id = v_log_id;

  RETURN jsonb_build_object(
    'ok', true,
    'read', v_read,
    'matched', v_matched,
    'inserted', v_inserted,
    'dropped', v_dropped,
    'outliers', v_outliers,
    'watermark', v_max_ts,
    'dropped_combos', COALESCE(v_dropped_combos, '[]'::jsonb)
  );
EXCEPTION WHEN OTHERS THEN
  UPDATE bot_sync_log SET
    status      = 'error',
    finished_at = now(),
    error_msg   = SQLERRM
  WHERE id = v_log_id;
  RAISE;
END;
$func$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- DESPUÉS DE APLICAR:
--
-- 1. Triggerá una corrida del bot:
--    - Desde el dashboard: /upload → Bot DB Sync → "⚡ Disparar sync ahora"
--    - O desde GitHub Actions: workflow Bot Sync → Run workflow → main
--    - O server-side: SELECT sync_bot_quotes('Colombia', 5000);
--
-- 2. Esperá a que termine (~30-60s) y consultá el log:
--    SELECT
--      started_at,
--      read_count, inserted_count, dropped_count,
--      jsonb_pretty(notes->'dropped_combos') AS dropped_combos
--    FROM bot_sync_log
--    WHERE country = 'Colombia' AND status = 'ok'
--    ORDER BY started_at DESC LIMIT 1;
--
-- 3. dropped_combos te dice EXACTAMENTE qué (app, vc, ovc, db_city) está
--    siendo dropeado. Mandame ese JSON y patcheo bot_rules en segundos.
-- ════════════════════════════════════════════════════════════════════════
