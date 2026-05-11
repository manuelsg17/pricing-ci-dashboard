-- ════════════════════════════════════════════════════════════════════════
-- Migración 53 — Bot health monitoring + re-sync seguro
--
-- INCLUYE:
--   A. Fix bug en validate_fdw_schema() — el OUT param `column_name`
--      colisionaba con `information_schema.columns.column_name`
--      ("column reference is ambiguous"). Renombrado a `col`.
--
--   B. get_bot_health(country) — combina dropped_combos del último log
--      + watermark + obs por data_source en las últimas 24h. Una sola
--      RPC que el UI BotDbSync puede llamar.
--
--   C. reset_bot_watermark(country, days_back) — RPC SEGURA para
--      retroceder el watermark de un país sin tocar pricing_observations.
--      La siguiente corrida re-pedirá al FDW desde esa fecha y
--      matcheará las filas con las reglas actuales. NO borra data.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── A. Fix validate_fdw_schema (renombrar OUT param) ──────────────────

DROP FUNCTION IF EXISTS validate_fdw_schema();

CREATE FUNCTION validate_fdw_schema()
RETURNS TABLE (
  col      text,      -- ★ FIX: renombrado de 'column_name' para evitar
                      --       colisión con information_schema.columns.column_name
  present  boolean
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
    col := v_col;
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns ic
      WHERE ic.table_name  = 'bot_quotes_remote'
        AND ic.column_name = v_col   -- ic.column_name (no ambiguo)
    ) INTO present;
    RETURN NEXT;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION validate_fdw_schema() TO authenticated;

COMMENT ON FUNCTION validate_fdw_schema() IS
  'Verifica que el FDW bot_quotes_remote expone las columnas que sync_bot_quotes asume. Correr después de re-deployar el bot externo.';


-- ── B. get_bot_health(country) ────────────────────────────────────────
-- Health-check completo del pipeline del bot para un país. Devuelve un
-- jsonb con: watermark, último sync (status/contadores), dropped_combos
-- del último ok, y count de obs por data_source en últimas 24h.

CREATE OR REPLACE FUNCTION get_bot_health(p_country text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_watermark      timestamptz;
  v_last_run       jsonb;
  v_dropped        jsonb;
  v_obs_24h        jsonb;
BEGIN
  SELECT last_synced_at INTO v_watermark
  FROM bot_sync_watermark WHERE country = p_country;

  SELECT jsonb_build_object(
    'started_at',     started_at,
    'finished_at',    finished_at,
    'status',         status,
    'read_count',     read_count,
    'inserted_count', inserted_count,
    'dropped_count',  dropped_count,
    'outlier_count',  outlier_count,
    'error_msg',      error_msg
  ) INTO v_last_run
  FROM bot_sync_log
  WHERE country = p_country
  ORDER BY started_at DESC LIMIT 1;

  -- Combos dropeados de la última corrida OK
  SELECT notes->'dropped_combos' INTO v_dropped
  FROM bot_sync_log
  WHERE country = p_country AND status = 'ok'
  ORDER BY started_at DESC LIMIT 1;

  -- Conteo de obs por fuente últimas 24h
  SELECT jsonb_object_agg(data_source, n) INTO v_obs_24h
  FROM (
    SELECT data_source, count(*) AS n
    FROM pricing_observations
    WHERE country       = p_country
      AND observed_date > current_date - interval '1 day'
    GROUP BY data_source
  ) sub;

  RETURN jsonb_build_object(
    'country',        p_country,
    'watermark',      v_watermark,
    'last_run',       COALESCE(v_last_run, 'null'::jsonb),
    'dropped_combos', COALESCE(v_dropped, '[]'::jsonb),
    'obs_24h',        COALESCE(v_obs_24h, '{}'::jsonb)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION get_bot_health(text) TO authenticated;

COMMENT ON FUNCTION get_bot_health(text) IS
  'Health-check del pipeline del bot para un país. Devuelve watermark, último sync, dropped_combos y obs por data_source. Una sola RPC para el panel BotDbSync.';


-- ── C. reset_bot_watermark(country, days_back) ────────────────────────
-- Retrocede el watermark de un país N días para forzar re-procesamiento
-- de filas que se dropearon antes (porque las reglas/normalizers han
-- mejorado). NO borra pricing_observations — son inserciones idempotentes
-- vía ON CONFLICT en las tablas destino (asumiendo PK definido).
--
-- SAFETY: p_days_back acotado a [0, 90] para evitar timeouts del FDW.
-- Requiere confirmación del operador (no se ejecuta automáticamente).

CREATE OR REPLACE FUNCTION reset_bot_watermark(
  p_country   text,
  p_days_back int
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_old timestamptz;
  v_new timestamptz;
BEGIN
  IF p_days_back IS NULL OR p_days_back < 0 OR p_days_back > 90 THEN
    RAISE EXCEPTION 'p_days_back debe estar en [0, 90] — recibido: %', p_days_back;
  END IF;

  SELECT last_synced_at INTO v_old
  FROM bot_sync_watermark WHERE country = p_country;

  IF v_old IS NULL THEN
    RETURN jsonb_build_object(
      'ok',      false,
      'reason',  'sin watermark para este país — la próxima corrida procesará todo el histórico'
    );
  END IF;

  v_new := GREATEST(
    v_old - (p_days_back || ' days')::interval,
    '1970-01-01T00:00:00+00:00'::timestamptz
  );

  UPDATE bot_sync_watermark
  SET last_synced_at = v_new,
      updated_at     = now()
  WHERE country = p_country;

  RETURN jsonb_build_object(
    'ok',       true,
    'country',  p_country,
    'old',      v_old,
    'new',      v_new,
    'note',     'Watermark retrocedido. La próxima corrida re-pedirá filas desde la nueva fecha.'
  );
END;
$$;

GRANT EXECUTE ON FUNCTION reset_bot_watermark(text, int) TO authenticated;

COMMENT ON FUNCTION reset_bot_watermark(text, int) IS
  'Retrocede el watermark de un país N días (0-90) para forzar re-procesamiento. NO borra pricing_observations. Útil cuando las bot_rules cambiaron y querés re-clasificar filas históricas.';


COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- USAR ASÍ:
--
--   -- Health check completo:
--   SELECT jsonb_pretty(get_bot_health('Colombia'));
--
--   -- Re-procesar últimos 30 días (sin borrar data):
--   SELECT reset_bot_watermark('Colombia', 30);
--   -- Luego: disparar sync desde dashboard o CLI.
-- ════════════════════════════════════════════════════════════════════════
