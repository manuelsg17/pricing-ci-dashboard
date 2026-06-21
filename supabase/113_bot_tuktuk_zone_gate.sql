-- ════════════════════════════════════════════════════════════════════════
-- Migración 113 — Gate de TukTuk en el sync del bot: main_category + zone
--
-- CONTEXTO:
--   El bot de TukTuk muestreaba rutas largas (long/very_long) que no reflejan
--   el uso real (TukTuk opera intra-distrito, viajes cortos) e inflaban el
--   promedio (avg 7.61 vs ~4 real). Además NUNCA traía el distrito → la data
--   del bot no se podía filtrar por zona.
--
--   La fuente del bot (un Excel de rutas) ahora trae dos columnas que ya
--   existen en bot_quotes_remote pero el sync no usaba:
--     · main_category  → la categoría con la que se DISEÑÓ la ruta
--     · zone           → el distrito de la ruta de TukTuk
--
-- APPROACH (sync_bot_quotes, CREATE OR REPLACE):
--   1) Arrastrar main_category y zone al batch temporal.
--   2) GATE TukTuk: descartar filas category='TukTuk' que NO cumplan
--      AMBOS factores → main_category=tuktuk Y zone con distrito.
--      (Las demás categorías quedan igual que antes.)
--   3) Insertar zone en pricing_observations SOLO para TukTuk (no regresiona
--      otras categorías, que siguen con zone=NULL).
--
-- VERIFICACIÓN:
--   Tras el primer sync con el Excel curado: las filas TukTuk del bot traen
--   distrito (Comas/SJM/Chorrillos/VES/SJL/Ventanilla/Carabayllo) y el
--   selector de Zona del dashboard se puebla también con data del bot.
--
-- NOTA: mientras el Excel no tenga main_category=tuktuk + zone, NO entran
--   filas TukTuk nuevas del bot — es exactamente el gate pedido.
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
  v_tuktuk_gated   int := 0;
  v_inserted       int := 0;
  v_log_id         bigint;
  v_dropped_combos jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'bot_sync_log') THEN
    RAISE EXCEPTION 'bot_sync_log no existe — corre migración 35';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'bot_quotes_remote' AND relkind = 'f') THEN
    RAISE EXCEPTION 'bot_quotes_remote no existe — corre migración 36';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'bot_rules') THEN
    RAISE EXCEPTION 'bot_rules no existe — corre migración 37';
  END IF;

  INSERT INTO bot_sync_log (country, status, notes)
  VALUES (p_country, 'running',
          jsonb_build_object('source', 'sync_bot_quotes_v113', 'limit', p_limit))
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
    -- ★ NO incluir distance_km — bot_quotes_remote no lo expone
    n.app_lc, n.vc_lc, n.ovc_lc,
    n.price_regular_value,
    n.price_discounted_value,
    n.effective_price,
    n.eta_mins,
    n.surge,
    -- ★ mig 113: arrastrar main_category + zone para el gate de TukTuk
    nullif(trim(replace(lower(coalesce(n.main_category,'')), ' ', '')), '') AS main_cat_lc,
    nullif(trim(coalesce(n.zone, '')), '')                                  AS zone,
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

  -- Capturar dropped combos para diagnóstico (mig 49)
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

  -- ★ mig 113 — GATE de TukTuk: solo entran rutas curadas (main_category=tuktuk)
  --   CON distrito (zone). Si falta cualquiera de los dos factores, se descarta.
  --   coalesce() es obligatorio: sin él, main_cat_lc NULL volvería el predicado
  --   NULL (lógica de 3 valores) y la fila NO se borraría (DELETE WHERE NULL
  --   no borra) → una fila TukTuk sin main_category se colaría.
  DELETE FROM _bot_batch
  WHERE category = 'TukTuk'
    AND NOT (coalesce(main_cat_lc, '') = 'tuktuk' AND zone IS NOT NULL);
  GET DIAGNOSTICS v_tuktuk_gated = ROW_COUNT;

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

  -- INSERT — zone solo para TukTuk (no regresiona otras categorías, que
  -- siguen con zone=NULL); distance_km queda NULL (el bot no lo expone).
  INSERT INTO pricing_observations (
    country, city, observed_date, observed_time, category, competition_name,
    recommended_price, price_with_discount, price_without_discount,
    eta_min, surge, distance_bracket, zone, data_source
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
    CASE WHEN category = 'TukTuk' THEN zone ELSE NULL END,
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

  UPDATE bot_sync_log SET
    status         = 'ok',
    finished_at    = now(),
    read_count     = v_read,
    inserted_count = v_inserted,
    dropped_count  = v_dropped,
    outlier_count  = v_outliers,
    notes          = notes || jsonb_build_object(
      'dropped_combos', COALESCE(v_dropped_combos, '[]'::jsonb),
      'tuktuk_gated',   v_tuktuk_gated
    )
  WHERE id = v_log_id;

  RETURN jsonb_build_object(
    'ok', true,
    'read', v_read,
    'matched', v_matched,
    'inserted', v_inserted,
    'dropped', v_dropped,
    'outliers', v_outliers,
    'tuktuk_gated', v_tuktuk_gated,
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
