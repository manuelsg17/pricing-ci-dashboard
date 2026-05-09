-- ════════════════════════════════════════════════════════════════════════
-- Migración 47 — Normalizar brackets variantes del bot a los 6 canónicos
--
-- SÍNTOMA:
--   La data del bot de Colombia entró pero el dashboard solo muestra
--   parcialmente. Inspeccionando pricing_observations vemos brackets
--   como `long_a`, `long_b`, `airport_short_a`, `median_zona_sur`,
--   `*_madrid`, `*_funza`, `medium` (typo) etc. que no son los 6
--   canónicos que el dashboard espera (very_short / short / median /
--   average / long / very_long).
--
-- CAUSA:
--   El bot externo (helioho.st / quotes_output) emite brackets con
--   sufijos zone-aware: A/B para sub-zonas, _zona_sur, prefijo
--   airport_, nombres de municipios satélite del área metro de Bogotá
--   (Madrid, Funza, Mosquera, Chía, etc.). Estos son útiles para
--   pricing en zonas específicas pero el dashboard tiene una taxonomía
--   plana de 6 brackets — debe colapsar las variantes al bracket base.
--
-- FIX:
--   A. Función normalize_distance_bracket(text) → text que mapea
--      cualquier variante a uno de los 6 canónicos o NULL si no se
--      puede inferir.
--   B. sync_bot_quotes() la usa al normalizar (en lugar del CASE
--      manual que solo cubría las exactas).
--   C. Backfill: UPDATE sobre pricing_observations existentes para
--      reclasificar las filas con brackets variantes.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── A. Normalizador IMMUTABLE ──────────────────────────────────────────
-- Reglas, en orden:
--   1. Quitar prefijo airport_   (airport_short_a → short_a)
--   2. Quitar sufijo de municipio satélite (madrid|funza|mosquera|
--      cota|chia|soacha|cajica|tenjo|sopo|sibate)
--      (long_b_madrid → long_b)
--   3. Quitar sufijo de zona (_zona_sur, _zona_norte, _zona_centro,
--      _norte, _sur, _centro, _este, _oeste)
--      (long_zona_sur → long)
--   4. Quitar sufijo A/B (long_a → long, long_b → long)
--   5. Mapear typos comunes (medium → median)
--   6. Match contra los 6 canónicos. Si no matchea → NULL.
--
-- IMMUTABLE permite indexar y usar en CHECK / generated columns si
-- alguien lo necesita después.

CREATE OR REPLACE FUNCTION normalize_distance_bracket(p_raw text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  s text;
BEGIN
  IF p_raw IS NULL OR trim(p_raw) = '' THEN
    RETURN NULL;
  END IF;

  -- Lowercase + reemplazar espacios/guiones por _
  s := lower(regexp_replace(p_raw, '[\s\-]+', '_', 'g'));

  -- 1. Strip prefijo airport_
  s := regexp_replace(s, '^airport_', '');

  -- 2. Strip sufijo de municipio satélite (puede aparecer múltiples
  --    veces si la data es muy granular; loop hasta estabilizar)
  s := regexp_replace(
    s,
    '_(madrid|funza|mosquera|cota|chia|soacha|cajica|tenjo|sopo|sibate)$',
    ''
  );

  -- 3. Strip sufijo de zona
  s := regexp_replace(
    s,
    '_(zona_sur|zona_norte|zona_centro|zona_este|zona_oeste|sur|norte|centro|este|oeste)$',
    ''
  );

  -- 4. Strip sufijo A/B
  s := regexp_replace(s, '_(a|b)$', '');

  -- 5. Typos comunes
  IF s = 'medium' THEN s := 'median'; END IF;
  IF s = 'very short' THEN s := 'very_short'; END IF;
  IF s = 'very long'  THEN s := 'very_long';  END IF;

  -- 6. Match canónico
  IF s IN ('very_short', 'short', 'median', 'average', 'long', 'very_long') THEN
    RETURN s;
  END IF;

  -- No es canónico ni reducible → NULL (visible en /rawdata pero
  -- excluido del dashboard, así no contamina las matrices)
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION normalize_distance_bracket(text) IS
  'Mapea variantes zone-aware del bot (long_a, *_zona_sur, airport_*, *_madrid, etc.) a uno de los 6 brackets canónicos. NULL si no se puede inferir.';


-- ── B. sync_bot_quotes usa la función ──────────────────────────────────
-- Reemplazamos solo la parte del CASE de bracket; el resto idéntico
-- a la versión de la migración 46.

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
          jsonb_build_object('source', 'sync_bot_quotes_v47', 'limit', p_limit))
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
      -- ★ NUEVO: usa normalize_distance_bracket en lugar del CASE manual
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


-- ── C. Backfill: re-clasificar filas existentes con bracket variante ───
-- Aplica normalize_distance_bracket a las filas que ya están en
-- pricing_observations. Usa una sola UPDATE con WHERE filtro para
-- minimizar bloat. Las filas que el normalizador devuelve NULL se
-- quedan en NULL (excluidas del dashboard).
--
-- Idempotente: re-correr este UPDATE no rompe nada porque
-- normalize_distance_bracket(canónico)=canónico y NULL=NULL.

UPDATE pricing_observations
SET distance_bracket = normalize_distance_bracket(distance_bracket)
WHERE distance_bracket IS NOT NULL
  AND distance_bracket NOT IN ('very_short', 'short', 'median', 'average', 'long', 'very_long');

-- Audit info
DO $$
DECLARE
  v_total int;
  v_null  int;
  v_canon int;
BEGIN
  SELECT count(*),
         count(*) FILTER (WHERE distance_bracket IS NULL),
         count(*) FILTER (WHERE distance_bracket IN ('very_short','short','median','average','long','very_long'))
  INTO v_total, v_null, v_canon
  FROM pricing_observations
  WHERE country = 'Colombia' AND data_source = 'bot';

  RAISE NOTICE 'Colombia bot rows tras backfill: total=% canónicos=% null=%',
               v_total, v_canon, v_null;
END $$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- Verificación post-aplicación:
--
--   SELECT distance_bracket, count(*)
--   FROM pricing_observations
--   WHERE country='Colombia' AND data_source='bot'
--   GROUP BY 1
--   ORDER BY 2 DESC;
--
-- Esperado: solo aparecen los 6 canónicos + NULL. Si aparece algo
-- como 'foo_zona_oeste' que no esté en el regex de la función,
-- agrégalo al regex de la sección 2 o 3 y re-aplica.
--
-- Tests rápidos:
--   SELECT normalize_distance_bracket('long_a');             -- 'long'
--   SELECT normalize_distance_bracket('airport_short_b');    -- 'short'
--   SELECT normalize_distance_bracket('median_zona_sur');    -- 'median'
--   SELECT normalize_distance_bracket('long_b_madrid');      -- 'long'
--   SELECT normalize_distance_bracket('medium');             -- 'median'
--   SELECT normalize_distance_bracket('something_weird');    -- NULL
-- ════════════════════════════════════════════════════════════════════════
