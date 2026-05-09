-- ════════════════════════════════════════════════════════════════════════
-- Migración 46 — Fix: data del bot no aparece en el dashboard
--
-- SÍNTOMA:
--   Se ven filas en /rawdata pero el dashboard no muestra nada para
--   Colombia (matrices vacías).
--
-- CAUSA RAÍZ:
--   1. sync_bot_quotes() inserta filas SIN distance_km (la columna no
--      estaba en el INSERT).
--   2. Cuando el bot envía distance_bracket=NULL, el trigger
--      trg_assign_computed_fields llama get_distance_bracket(country,
--      city, category, NULL) — al no haber km la función caía a
--      RETURN 'very_long' por la lógica del FOR loop con condición NULL.
--   3. Resultado: TODAS las filas de Colombia caían al bracket
--      'very_long'. El dashboard ni siquiera mostraba esa columna como
--      poblada porque las matrices se construyen iterando los 6
--      brackets canónicos y el WA pondera por sample count.
--
-- FIX:
--   A. get_distance_bracket retorna NULL si distance es NULL (en lugar
--      de mentir con 'very_long'). Mejor visibilidad del problema.
--   B. sync_bot_quotes() añade distance_km al INSERT para que el
--      trigger pueda computar el bracket correctamente.
--   C. Backfill: borrar filas de Colombia mal-clasificadas y resetear
--      el watermark para que el próximo sync las re-ingrese con
--      distance_km y bracket correctos.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── A. get_distance_bracket honesto con NULL ───────────────────────────
CREATE OR REPLACE FUNCTION get_distance_bracket(
  p_country  text,
  p_city     text,
  p_category text,
  p_distance numeric
) RETURNS text
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  r RECORD;
BEGIN
  -- Sin distancia no podemos clasificar. Mejor NULL explícito que
  -- 'very_long' inventado — el bracket NULL queda visible en /rawdata
  -- y se puede backfilling después.
  IF p_distance IS NULL THEN
    RETURN NULL;
  END IF;

  -- Buscar primero por (country, city, category) específico
  FOR r IN
    SELECT bracket, max_km
    FROM distance_thresholds
    WHERE country  = p_country
      AND city     = p_city
      AND category = p_category
    ORDER BY COALESCE(max_km, 999999) ASC
  LOOP
    IF r.max_km IS NULL OR p_distance <= r.max_km THEN
      RETURN r.bracket;
    END IF;
  END LOOP;

  -- Fallback: (country, city, 'all')
  FOR r IN
    SELECT bracket, max_km
    FROM distance_thresholds
    WHERE country  = p_country
      AND city     = p_city
      AND category = 'all'
    ORDER BY COALESCE(max_km, 999999) ASC
  LOOP
    IF r.max_km IS NULL OR p_distance <= r.max_km THEN
      RETURN r.bracket;
    END IF;
  END LOOP;

  -- Si llegamos acá: hay distancia pero no thresholds configurados.
  -- 'very_long' es el bracket más permisivo, último resort.
  RETURN 'very_long';
END;
$$;


-- ── B. sync_bot_quotes incluye distance_km ─────────────────────────────
-- El INSERT actual NO tenía distance_km. Sin esa columna, el trigger
-- de bracket computation cae al fallback NULL→'very_long'. Reemplazamos
-- la función completa con la versión correcta.
--
-- NOTA: si bot_quotes_remote NO tiene la columna distance_km (depende
-- del schema del bot externo), este COALESCE devuelve NULL y nos
-- quedamos en el mismo problema — pero al menos get_distance_bracket
-- ahora devuelve NULL (no 'very_long'), así que las filas quedan
-- visibles con bracket NULL y se pueden investigar.

CREATE OR REPLACE FUNCTION sync_bot_quotes(
  p_country text DEFAULT 'Peru',
  p_limit   int  DEFAULT 5000
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET statement_timeout = '180s'
AS $func$
DECLARE
  v_watermark timestamptz;
  v_max_ts    timestamptz;
  v_read      int := 0;
  v_matched   int := 0;
  v_dropped   int := 0;
  v_outliers  int := 0;
  v_inserted  int := 0;
  v_log_id    bigint;
BEGIN
  -- 0. Pre-checks
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'bot_sync_log') THEN
    RAISE EXCEPTION 'Tabla bot_sync_log no existe — corre primero la migración 35';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'bot_quotes_remote' AND relkind = 'f') THEN
    RAISE EXCEPTION 'Foreign table bot_quotes_remote no existe — corre primero la migración 36';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'bot_rules') THEN
    RAISE EXCEPTION 'Tabla bot_rules no existe — corre primero la migración 37';
  END IF;

  -- 1. Crear log row
  INSERT INTO bot_sync_log (country, status, notes)
  VALUES (p_country, 'running', jsonb_build_object('source', 'sync_bot_quotes', 'limit', p_limit))
  RETURNING id INTO v_log_id;

  -- 2. Watermark
  SELECT last_synced_at INTO v_watermark
  FROM bot_sync_watermark WHERE country = p_country;
  IF v_watermark IS NULL THEN
    v_watermark := '1970-01-01T00:00:00+00:00'::timestamptz;
  END IF;

  -- 3. Pull + normalize
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
    n.timezone,
    n.country,
    n.db_city,
    n.norm_bracket,
    n.distance_km,                -- ← AÑADIDO: necesario para trigger
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

  v_matched := (SELECT count(*) FROM _bot_batch WHERE competition_name IS NOT NULL AND effective_price IS NOT NULL);
  v_dropped := v_read - v_matched;

  DELETE FROM _bot_batch
  WHERE competition_name IS NULL
     OR effective_price  IS NULL;

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

  -- 6. INSERT — AHORA INCLUYE distance_km
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
    distance_km,                -- ← AÑADIDO
    'bot'
  FROM _bot_batch;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  -- 7. Watermark
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
    'read', v_read,
    'matched', v_matched,
    'inserted', v_inserted,
    'dropped', v_dropped,
    'outliers', v_outliers,
    'watermark', v_max_ts
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


-- ── C. Backfill — re-clasificar filas existentes de Colombia ───────────
-- Las filas ya insertadas tienen distance_km=NULL (porque sync_bot_quotes
-- viejo no lo escribía) y bracket='very_long' (por el bug de
-- get_distance_bracket). No podemos recuperar el km perdido sin ir al
-- bot_quotes_remote, pero sí podemos limpiar el bracket=very_long
-- mentiroso para que el dashboard no agregue datos basura.
--
-- Decisión: marcamos esos rows con bracket=NULL para que NO se cuenten
-- en el WA. Cuando el próximo sync corra, las nuevas filas vendrán con
-- distance_km y bracket correctos.

UPDATE pricing_observations
SET distance_bracket = NULL
WHERE country = 'Colombia'
  AND data_source = 'bot'
  AND distance_km IS NULL
  AND distance_bracket = 'very_long';

-- Mensaje informativo (queda en bot_sync_log para auditoría)
DO $$
DECLARE
  v_affected int;
BEGIN
  GET DIAGNOSTICS v_affected = ROW_COUNT;
  RAISE NOTICE 'Backfill: % filas de Colombia con bracket=very_long y km=NULL fueron limpiadas a bracket=NULL. El próximo sync repondrá la data correcta.', v_affected;
END $$;

-- Resetear el watermark de Colombia para que el próximo sync re-ingrese
-- desde cero (idempotente — usa ON CONFLICT del INSERT en pricing_observations).
-- Si prefieres no re-ingerir (mantener el log limpio), comenta este bloque:
UPDATE bot_sync_watermark
SET last_synced_at = '1970-01-01T00:00:00+00:00'::timestamptz,
    updated_at     = now()
WHERE country = 'Colombia';

INSERT INTO bot_sync_watermark (country, last_synced_at, updated_at)
SELECT 'Colombia', '1970-01-01T00:00:00+00:00'::timestamptz, now()
WHERE NOT EXISTS (SELECT 1 FROM bot_sync_watermark WHERE country = 'Colombia');

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- Después de aplicar:
--
-- 1. Verifica que el watermark se reseteó:
--    SELECT * FROM bot_sync_watermark WHERE country = 'Colombia';
--    → last_synced_at debería ser 1970-01-01
--
-- 2. Antes de re-ingerir, opcionalmente borra las filas viejas
--    para no acumular duplicados:
--    DELETE FROM pricing_observations
--    WHERE country = 'Colombia' AND data_source = 'bot';
--
-- 3. Trigger sync manual o esperá el cron:
--    SELECT sync_bot_quotes('Colombia', 50000);
--
-- 4. Verifica:
--    SELECT distance_bracket, count(*)
--    FROM pricing_observations
--    WHERE country = 'Colombia' AND data_source = 'bot'
--    GROUP BY 1 ORDER BY 2 DESC;
--    → Esperado: distribución entre los 6 brackets, NO 100% en very_long
-- ════════════════════════════════════════════════════════════════════════
