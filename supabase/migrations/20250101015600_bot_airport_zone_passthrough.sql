-- ════════════════════════════════════════════════════════════════════════
-- Migración 117 — Pasar el zone de aeropuerto en el sync del bot
--
-- CONTEXTO:
--   El Excel de direcciones del bot ahora trae filas de aeropuerto etiquetadas
--   con zone = 'Airport_A' / 'Airport_B' (+ City = Lima/Arequipa/Trujillo).
--   La intención: que esas direcciones solo alimenten el "punto A" y "punto B"
--   de aeropuerto de su ciudad (Lima_Airport_A / Lima_Airport_B / …) y NO se
--   mezclen con el CI convencional de la ciudad base.
--
--   La infra de ruteo YA existe:
--     · airport_markers (mig 78/82) define por ciudad zone_from_value='Airport_A'
--       → city_from='Lima_Airport_A', zone_to_value='Airport_B' → city_to.
--     · El trigger BEFORE INSERT trg_airport_route_pricing_obs (mig 83) re-rutea
--       pricing_observations.city según NEW.zone vs esos marcadores.
--
--   EL BUG: sync_bot_quotes (mig 113) ponía zone = NULL para todo lo que no
--   fuera TukTuk (`CASE WHEN category='TukTuk' THEN zone ELSE NULL END`). Como
--   el INSERT del bot tampoco trae point_a/point_b, el trigger se quedaba sin
--   NINGUNA señal de aeropuerto → toda cotización de aeropuerto del bot caía en
--   la ciudad base (Lima/Trujillo) y se mezclaba con el CI normal. Justo lo que
--   se quiere evitar. (Se confirmó en datos: Lima/Trujillo sin data bot de
--   aeropuerto; Arequipa_Airport_B con data bot pero zone NULL.)
--
-- APPROACH (sync_bot_quotes, CREATE OR REPLACE — única migración que la toca
-- después de 113):
--   1) Juntar al inicio los valores de zone que son señal de aeropuerto para el
--      país (zone_from_value/zone_to_value de airport_markers activos) en un
--      arreglo v_airport_zones. Config-driven: si el usuario renombra esos
--      valores en la pestaña Aeropuertos, el sync los respeta sin tocar código.
--   2) En el INSERT, pasar el zone también cuando es señal de aeropuerto:
--        CASE WHEN category='TukTuk'        THEN zone   -- distrito (mig 113)
--             WHEN zone = ANY(v_airport_zones) THEN zone -- aeropuerto (mig 117)
--             ELSE NULL END
--      El trigger de mig 83 hace el resto: city base + zone='Airport_A'
--      → city='Lima_Airport_A'. El zone queda persistido = 'Airport_A', igual
--      que la data MANUAL de aeropuerto ya existente (consistencia).
--
--   No se agrega gate que descarte filas: el zone ES la señal/“gate”. Una fila
--   sin zone de aeropuerto simplemente se queda en la ciudad base (curación del
--   Excel, igual criterio que el gate de TukTuk). Filas normales (zone NULL o
--   distrito que no matchea) siguen con zone=NULL → sin regresión.
--
-- VERIFICACIÓN:
--   Tras el próximo sync con el Excel etiquetado: las cotizaciones de aeropuerto
--   del bot caen en <Ciudad>_Airport_A / _Airport_B (no en la ciudad base) y el
--   dashboard las muestra separadas del CI convencional, como la data manual.
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
  v_airport_zones  text[];   -- ★ mig 117: señales de zone de aeropuerto del país
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
          jsonb_build_object('source', 'sync_bot_quotes_v117', 'limit', p_limit))
  RETURNING id INTO v_log_id;

  SELECT last_synced_at INTO v_watermark
  FROM bot_sync_watermark WHERE country = p_country;
  IF v_watermark IS NULL THEN
    v_watermark := '1970-01-01T00:00:00+00:00'::timestamptz;
  END IF;

  -- ★ mig 117 — valores de zone que son señal de aeropuerto para este país
  --   (config-driven desde airport_markers; respeta lo que el usuario edite en
  --   la pestaña Aeropuertos). Típicamente {Airport_A, Airport_B}.
  SELECT array_agg(DISTINCT z) INTO v_airport_zones
  FROM (
    SELECT zone_from_value AS z FROM airport_markers
      WHERE country = p_country AND active
    UNION
    SELECT zone_to_value   AS z FROM airport_markers
      WHERE country = p_country AND active
  ) s
  WHERE z IS NOT NULL AND z <> '';
  v_airport_zones := COALESCE(v_airport_zones, ARRAY[]::text[]);

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
    --   y (mig 117) para el ruteo de aeropuerto
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

  -- INSERT — zone para TukTuk (distrito, mig 113) y para aeropuerto (mig 117,
  -- señal que consume el trigger de ruteo). El resto sigue con zone=NULL.
  -- distance_km queda NULL (el bot no lo expone).
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
    CASE
      WHEN category = 'TukTuk'              THEN zone   -- distrito (mig 113)
      WHEN zone = ANY(v_airport_zones)      THEN zone   -- aeropuerto (mig 117)
      ELSE NULL
    END,
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

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN (no destructiva)
--   1) La función reporta v117 en el log:
--        SELECT notes->>'source' FROM bot_sync_log ORDER BY id DESC LIMIT 1;
--        -- esperás: sync_bot_quotes_v117 en el próximo run
--
--   2) Ruteo end-to-end (transacción, rollback): una fila tal como la insertaría
--      el sync para una dirección de aeropuerto del bot termina en la ciudad
--      _Airport_A por obra del trigger de mig 83:
--        BEGIN;
--        INSERT INTO pricing_observations
--          (country, city, observed_date, category, competition_name,
--           data_source, zone, distance_bracket, price_without_discount)
--        VALUES ('Peru','Lima',CURRENT_DATE,'Economy/Comfort','Yango',
--                'bot','Airport_A','Medium',20);
--        SELECT city, zone FROM pricing_observations
--          WHERE data_source='bot' AND zone='Airport_A'
--          ORDER BY id DESC LIMIT 1;     -- esperás: Lima_Airport_A | Airport_A
--        ROLLBACK;
-- ════════════════════════════════════════════════════════════════════════
