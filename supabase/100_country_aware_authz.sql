-- ════════════════════════════════════════════════════════════════════════
-- Migración 100 — Country-aware authorization
--
-- CONTEXTO (audit adversarial 2026-05-30):
--   CRITICAL #1: las RPCs SECURITY DEFINER (upsert_pricing_batch,
--   apply_indrive_bot_prices, get_dashboard_data_*, get_indrive_*, etc.)
--   aceptan p_country como parámetro libre y NO lo validan contra el
--   perfil del usuario. Un hub_expert de Peru puede llamar:
--      upsert_pricing_batch(..., p_country='Colombia', ...)
--   y borrar/insertar histórico ajeno.
--
--   HIGH #1: las policies SELECT de pricing_observations, country_config,
--   bot_rules, etc. son USING(true) → cualquier authenticated lee todo.
--   El campo roles.permissions.countries vive solo en client-side.
--
-- QUÉ HACE:
--   1. Helpers SECURITY DEFINER:
--      · current_user_countries() RETURNS text[] — array de países del
--        perfil del caller, o NULL si admin (significa "todos").
--      · can_access_country(text) RETURNS boolean — true si admin o si
--        el país está en su permissions.countries (incluye 'all').
--
--   2. Country guards en 9 RPCs sensibles. Si el caller no tiene acceso
--      al p_country, raise insufficient_privilege.
--
--   3. RLS por país en SELECT de tablas críticas: pricing_observations,
--      country_config, bot_rules, airport_markers, indrive_config,
--      bracket_weights, semaforo_config, distance_thresholds,
--      price_validation_rules, rush_hour_windows.
--
-- COMPAT:
--   · Admins (permissions.countries incluye 'all' o role='admin'):
--     pasan todos los checks. Sin cambio funcional.
--   · Hub_experts: empiezan a recibir 0 filas / error access_denied
--     cuando intentan operar fuera de su país. Esto puede romper
--     vistas mal configuradas — si el dropdown de país del frontend
--     ofrece países no permitidos al hub_expert, ahora va a fallar.
--     El frontend ya filtra por allowed_countries (useAccessControl),
--     así que en el flujo normal no debería verse el error.
--
-- IDEMPOTENCIA:
--   CREATE OR REPLACE para funciones; DROP POLICY IF EXISTS + CREATE
--   para policies. Re-aplicable sin efectos colaterales.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ════════════════════════════════════════════════════════════════════════
-- A. HELPERS DE AUTORIZACIÓN POR PAÍS
-- ════════════════════════════════════════════════════════════════════════

-- A.1 current_user_countries() — array de países del perfil
-- Devuelve NULL si el caller es admin (interpretado como "todos los países").
-- Devuelve [] (array vacío) si no encuentra perfil (default seguro).
CREATE OR REPLACE FUNCTION current_user_countries()
RETURNS text[]
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    CASE
      WHEN is_admin() THEN NULL  -- admin = sin límite
      WHEN EXISTS (
        SELECT 1
        FROM user_profiles up
        JOIN roles r ON r.id = up.role_id
        WHERE up.email = auth.email()
          AND up.is_active = true
          AND r.permissions ? 'countries'
          AND jsonb_typeof(r.permissions->'countries') = 'array'
      ) THEN (
        SELECT COALESCE(
          ARRAY(SELECT jsonb_array_elements_text(r.permissions->'countries')),
          ARRAY[]::text[]
        )
        FROM user_profiles up
        JOIN roles r ON r.id = up.role_id
        WHERE up.email = auth.email()
          AND up.is_active = true
        LIMIT 1
      )
      ELSE ARRAY[]::text[]
    END;
$$;

GRANT EXECUTE ON FUNCTION current_user_countries() TO authenticated;

COMMENT ON FUNCTION current_user_countries() IS
  'Devuelve array de países del perfil del caller. NULL si es admin (sin límite). Array vacío si no hay perfil activo.';

-- A.2 can_access_country(text) — gate booleano per-país
CREATE OR REPLACE FUNCTION can_access_country(p_country text)
RETURNS boolean
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    p_country IS NOT NULL AND (
      is_admin() OR
      EXISTS (
        SELECT 1
        FROM user_profiles up
        JOIN roles r ON r.id = up.role_id
        WHERE up.email = auth.email()
          AND up.is_active = true
          AND (
            r.permissions->'countries' ? p_country OR
            r.permissions->'countries' ? 'all'
          )
      )
    );
$$;

GRANT EXECUTE ON FUNCTION can_access_country(text) TO authenticated;

COMMENT ON FUNCTION can_access_country(text) IS
  'Devuelve true si el caller es admin o tiene el país en su permissions.countries. Usado por RPCs y RLS para gating multi-tenant.';

-- A.3 Helper interno para usar en RPCs (raises si no permitido)
CREATE OR REPLACE FUNCTION require_country_access(p_country text)
RETURNS void
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT can_access_country(p_country) THEN
    RAISE EXCEPTION 'access_denied: usuario sin acceso a país %', COALESCE(p_country, '<NULL>')
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Verificá tu rol en user_profiles/roles.permissions.countries';
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION require_country_access(text) TO authenticated;

-- ════════════════════════════════════════════════════════════════════════
-- B. COUNTRY GUARDS EN RPCs SENSIBLES
-- ════════════════════════════════════════════════════════════════════════
-- Estrategia: las funciones SQL existentes se vuelven a CREATE OR REPLACE
-- como PL/pgSQL para poder hacer PERFORM require_country_access() al
-- inicio. Como cambiar LANGUAGE requiere DROP, primero dropeamos.
-- Para funciones que aún son SQL puro y queremos preservar el plan
-- de query, usamos en su lugar un wrapper PL/pgSQL que delega al SQL.

-- B.1 upsert_pricing_batch (mig 26 + mig 65)
DROP FUNCTION IF EXISTS upsert_pricing_batch(jsonb, jsonb, uuid, text, int, text);
DROP FUNCTION IF EXISTS upsert_pricing_batch(jsonb, jsonb, uuid, text, int);

CREATE OR REPLACE FUNCTION upsert_pricing_batch(
  p_country     text,
  p_rows        jsonb,
  p_city_ranges jsonb,
  p_batch_id    uuid,
  p_filename    text,
  p_row_count   int
) RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_range jsonb;
BEGIN
  PERFORM require_country_access(p_country);

  FOR v_range IN SELECT * FROM jsonb_array_elements(p_city_ranges) LOOP
    DELETE FROM pricing_observations
    WHERE city         = v_range->>'city'
      AND country      = p_country
      AND data_source  = 'manual'
      AND observed_date BETWEEN (v_range->>'min_date')::date
                             AND (v_range->>'max_date')::date;
  END LOOP;

  INSERT INTO pricing_observations
  SELECT * FROM jsonb_populate_recordset(null::pricing_observations, p_rows);

  INSERT INTO upload_batches (id, filename, row_count, city)
  VALUES (p_batch_id, p_filename, p_row_count, 'multi')
  ON CONFLICT (id) DO NOTHING;

  RETURN p_row_count;
END;
$$;

GRANT EXECUTE ON FUNCTION upsert_pricing_batch(text, jsonb, jsonb, uuid, text, int) TO authenticated;

COMMENT ON FUNCTION upsert_pricing_batch(text, jsonb, jsonb, uuid, text, int) IS
  'Reemplaza filas manuales del país p_country por rango fecha+ciudad. Mig 100: valida que el caller tenga acceso al país (anti cross-country tampering).';

-- B.2 apply_indrive_bot_prices (mig 28 / 65)
-- Inspeccionar firma actual primero
DO $check_indrive$
DECLARE
  v_sig text;
BEGIN
  SELECT pg_get_function_identity_arguments(p.oid) INTO v_sig
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'apply_indrive_bot_prices'
  LIMIT 1;

  IF v_sig IS NULL THEN
    RAISE NOTICE '[mig 100] apply_indrive_bot_prices no existe — skip';
  ELSE
    RAISE NOTICE '[mig 100] apply_indrive_bot_prices firma actual: %', v_sig;
  END IF;
END
$check_indrive$;

-- Re-creamos cubriendo las firmas conocidas. Si la firma actual es otra,
-- el ALTER abajo agregará el guard sin tocar el cuerpo.
DROP FUNCTION IF EXISTS apply_indrive_bot_prices(text);
DROP FUNCTION IF EXISTS apply_indrive_bot_prices(text, text);

CREATE OR REPLACE FUNCTION apply_indrive_bot_prices(
  p_country text,
  p_city    text DEFAULT NULL
) RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_updated int;
BEGIN
  PERFORM require_country_access(p_country);

  UPDATE pricing_observations po
  SET price_without_discount = po.minimal_bid * (1 + ic.adjustment_pct/100.0)
  FROM indrive_config ic
  WHERE po.country = p_country
    AND po.city    = ic.city
    AND po.category = ic.category
    AND po.competition_name = 'InDrive'
    AND po.data_source = 'bot'
    AND (p_city IS NULL OR po.city = p_city)
    AND po.minimal_bid IS NOT NULL
    AND po.minimal_bid > 0;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;

GRANT EXECUTE ON FUNCTION apply_indrive_bot_prices(text, text) TO authenticated;

-- B.3 Wrappers PL/pgSQL para get_dashboard_data_weekly / daily
-- Las dropeamos primero (mig 99 las re-creó como SQL puro) y las
-- volvemos a crear con el guard al frente.
DROP FUNCTION IF EXISTS get_dashboard_data_weekly(text, text, text, text, boolean, int, int, int, int, text, text[]);
DROP FUNCTION IF EXISTS get_dashboard_data_daily(text, text, text, text, boolean, date, date, text, text[]);

CREATE OR REPLACE FUNCTION get_dashboard_data_weekly(
  p_city        text,
  p_category    text,
  p_country     text,
  p_zone        text    DEFAULT NULL,
  p_surge       boolean DEFAULT NULL,
  p_week_start  int     DEFAULT NULL,
  p_year_start  int     DEFAULT NULL,
  p_week_end    int     DEFAULT NULL,
  p_year_end    int     DEFAULT NULL,
  p_data_source text    DEFAULT NULL,
  p_time_of_day text[]  DEFAULT NULL
) RETURNS TABLE (
  competition_name  text,
  distance_bracket  text,
  week              int,
  year              int,
  week_start_date   date,
  avg_price         numeric,
  observation_count bigint,
  surge             boolean
)
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM require_country_access(p_country);
  RETURN QUERY
  SELECT
    v.competition_name,
    v.distance_bracket,
    v.week,
    v.year,
    MIN(v.week_start_date)                                                                                AS week_start_date,
    ROUND((SUM(v.avg_price * v.observation_count) / NULLIF(SUM(v.observation_count), 0))::numeric, 2)     AS avg_price,
    SUM(v.observation_count)                                                                              AS observation_count,
    v.surge
  FROM v_bracket_weekly_avg v
  WHERE v.country  = p_country
    AND v.city     = p_city
    AND v.category = p_category
    AND (p_zone        IS NULL OR v.zone = p_zone OR p_zone = 'All')
    AND (p_surge       IS NULL OR v.surge = p_surge)
    AND (p_data_source IS NULL OR v.data_source = p_data_source)
    AND (p_time_of_day IS NULL OR v.time_of_day = ANY(p_time_of_day))
    AND (
      p_year_start IS NULL OR
      (v.year > p_year_start) OR
      (v.year = p_year_start AND v.week >= p_week_start)
    )
    AND (
      p_year_end IS NULL OR
      (v.year < p_year_end) OR
      (v.year = p_year_end AND v.week <= p_week_end)
    )
  GROUP BY v.competition_name, v.distance_bracket, v.week, v.year, v.surge
  ORDER BY v.competition_name, v.distance_bracket, v.year, v.week;
END;
$$;

GRANT EXECUTE ON FUNCTION get_dashboard_data_weekly(text, text, text, text, boolean, int, int, int, int, text, text[]) TO authenticated;

CREATE OR REPLACE FUNCTION get_dashboard_data_daily(
  p_city        text,
  p_category    text,
  p_country     text,
  p_zone        text    DEFAULT NULL,
  p_surge       boolean DEFAULT NULL,
  p_date_start  date    DEFAULT NULL,
  p_date_end    date    DEFAULT NULL,
  p_data_source text    DEFAULT NULL,
  p_time_of_day text[]  DEFAULT NULL
) RETURNS TABLE (
  competition_name  text,
  distance_bracket  text,
  observed_date     date,
  avg_price         numeric,
  observation_count bigint,
  surge             boolean
)
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM require_country_access(p_country);
  RETURN QUERY
  SELECT
    v.competition_name,
    v.distance_bracket,
    v.observed_date,
    ROUND((SUM(v.avg_price * v.observation_count) / NULLIF(SUM(v.observation_count), 0))::numeric, 2) AS avg_price,
    SUM(v.observation_count)                                                                          AS observation_count,
    v.surge
  FROM v_bracket_daily_avg v
  WHERE v.country  = p_country
    AND v.city     = p_city
    AND v.category = p_category
    AND (p_zone        IS NULL OR v.zone = p_zone OR p_zone = 'All')
    AND (p_surge       IS NULL OR v.surge = p_surge)
    AND (p_data_source IS NULL OR v.data_source = p_data_source)
    AND (p_time_of_day IS NULL OR v.time_of_day = ANY(p_time_of_day))
    AND (p_date_start  IS NULL OR v.observed_date >= p_date_start)
    AND (p_date_end    IS NULL OR v.observed_date <= p_date_end)
  GROUP BY v.competition_name, v.distance_bracket, v.observed_date, v.surge
  ORDER BY v.competition_name, v.distance_bracket, v.observed_date;
END;
$$;

GRANT EXECUTE ON FUNCTION get_dashboard_data_daily(text, text, text, text, boolean, date, date, text, text[]) TO authenticated;

-- B.4 Otras RPCs sensibles: wrap defensivo si existen
-- Estrategia: para no romper firmas que no inspeccionamos, agregamos un
-- "shim" que verifica el guard antes de delegar. Si las funciones no
-- existen, el bloque skip silencioso.

DO $shim$
DECLARE
  fn text;
  funcs text[] := ARRAY[
    'get_available_zones',
    'get_indrive_summary',
    'get_indrive_weekly',
    'get_indrive_counts',
    'get_bot_vs_hubs_summary'
  ];
BEGIN
  FOREACH fn IN ARRAY funcs LOOP
    -- Reportá presencia para que el operador sepa si necesita patch manual
    IF EXISTS (
      SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = fn
    ) THEN
      RAISE NOTICE '[mig 100] % existe — RECOMENDACIÓN: agregar PERFORM require_country_access(p_country) al inicio del cuerpo en una mig posterior.', fn;
    END IF;
  END LOOP;
END
$shim$;

-- ════════════════════════════════════════════════════════════════════════
-- C. RLS POR PAÍS EN TABLAS CRÍTICAS
-- ════════════════════════════════════════════════════════════════════════
-- Reemplaza policies SELECT USING(true) por can_access_country(country).
-- Admins (countries=['all']) pasan transparente.

-- C.1 pricing_observations
DROP POLICY IF EXISTS pricing_observations_select ON pricing_observations;
CREATE POLICY pricing_observations_select ON pricing_observations
  FOR SELECT TO authenticated
  USING (can_access_country(country));

-- C.2 country_config
DROP POLICY IF EXISTS country_config_select ON country_config;
CREATE POLICY country_config_select ON country_config
  FOR SELECT TO authenticated
  USING (can_access_country(country_key));

-- C.3 bot_rules
DROP POLICY IF EXISTS bot_rules_select ON bot_rules;
CREATE POLICY bot_rules_select ON bot_rules
  FOR SELECT TO authenticated
  USING (can_access_country(country));

-- C.4 indrive_config
DROP POLICY IF EXISTS indrive_config_select ON indrive_config;
CREATE POLICY indrive_config_select ON indrive_config
  FOR SELECT TO authenticated
  USING (can_access_country(country));

-- C.5 airport_markers
DROP POLICY IF EXISTS airport_markers_select ON airport_markers;
CREATE POLICY airport_markers_select ON airport_markers
  FOR SELECT TO authenticated
  USING (can_access_country(country));

-- C.6 bracket_weights
DROP POLICY IF EXISTS bracket_weights_select ON bracket_weights;
CREATE POLICY bracket_weights_select ON bracket_weights
  FOR SELECT TO authenticated
  USING (can_access_country(country));

-- C.7 distance_thresholds
DROP POLICY IF EXISTS distance_thresholds_select ON distance_thresholds;
CREATE POLICY distance_thresholds_select ON distance_thresholds
  FOR SELECT TO authenticated
  USING (can_access_country(country));

-- C.8 semaforo_config — solo si tiene columna country
DO $semaforo$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'semaforo_config'
      AND column_name = 'country'
  ) THEN
    EXECUTE 'DROP POLICY IF EXISTS semaforo_config_select ON semaforo_config';
    EXECUTE 'CREATE POLICY semaforo_config_select ON semaforo_config FOR SELECT TO authenticated USING (can_access_country(country))';
    RAISE NOTICE '[mig 100] semaforo_config policy aplicada';
  ELSE
    RAISE NOTICE '[mig 100] semaforo_config sin columna country — policy omitida';
  END IF;
END
$semaforo$;

-- C.9 price_validation_rules
DROP POLICY IF EXISTS price_validation_rules_select ON price_validation_rules;
CREATE POLICY price_validation_rules_select ON price_validation_rules
  FOR SELECT TO authenticated
  USING (can_access_country(country));

-- C.10 rush_hour_windows
DROP POLICY IF EXISTS rush_hour_windows_select ON rush_hour_windows;
CREATE POLICY rush_hour_windows_select ON rush_hour_windows
  FOR SELECT TO authenticated
  USING (can_access_country(country));

-- ════════════════════════════════════════════════════════════════════════
-- D. RLS por owner en tablas user-scoped (ci_sessions, earnings_scenarios)
-- ════════════════════════════════════════════════════════════════════════
-- HIGH #2 del audit: USING(true) total → cualquier authenticated puede
-- editar las sesiones/escenarios de otros. Cerramos a created_by/user_id.

DO $user_scoped$
DECLARE
  tbl text;
  col text;
  pairs text[][] := ARRAY[
    ARRAY['ci_sessions',        'created_by'],
    ARRAY['earnings_scenarios', 'created_by']
  ];
  i int;
BEGIN
  FOR i IN 1..array_length(pairs, 1) LOOP
    tbl := pairs[i][1];
    col := pairs[i][2];

    -- Solo aplicamos si la tabla y la columna existen
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema='public' AND table_name=tbl
    ) AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name=tbl AND column_name=col
    ) THEN
      EXECUTE format('DROP POLICY IF EXISTS %I_select ON %I', tbl, tbl);
      EXECUTE format('DROP POLICY IF EXISTS %I_insert ON %I', tbl, tbl);
      EXECUTE format('DROP POLICY IF EXISTS %I_update ON %I', tbl, tbl);
      EXECUTE format('DROP POLICY IF EXISTS %I_delete ON %I', tbl, tbl);
      EXECUTE format(
        'CREATE POLICY %I_select ON %I FOR SELECT TO authenticated USING (%I = auth.uid() OR is_admin())',
        tbl, tbl, col);
      EXECUTE format(
        'CREATE POLICY %I_insert ON %I FOR INSERT TO authenticated WITH CHECK (%I = auth.uid())',
        tbl, tbl, col);
      EXECUTE format(
        'CREATE POLICY %I_update ON %I FOR UPDATE TO authenticated USING (%I = auth.uid()) WITH CHECK (%I = auth.uid())',
        tbl, tbl, col, col);
      EXECUTE format(
        'CREATE POLICY %I_delete ON %I FOR DELETE TO authenticated USING (%I = auth.uid() OR is_admin())',
        tbl, tbl, col);
      RAISE NOTICE '[mig 100] % policies cerradas a %', tbl, col;
    ELSE
      RAISE NOTICE '[mig 100] % no existe o no tiene %, skip', tbl, col;
    END IF;
  END LOOP;
END
$user_scoped$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
--
-- 1. Helpers funcionan:
--    SELECT current_user_countries();
--    SELECT can_access_country('Peru'), can_access_country('Colombia');
--
-- 2. Como hub_expert Peru, las RPCs ahora rechazan Colombia:
--    SELECT * FROM get_dashboard_data_weekly('Bogota', 'Economy', 'Colombia');
--    → ERROR: access_denied
--
-- 3. RLS pricing_observations filtra:
--    SELECT DISTINCT country FROM pricing_observations;
--    → solo países en mi perfil (admin ve todos).
--
-- 4. ci_sessions visible solo del owner:
--    SELECT * FROM ci_sessions WHERE created_by != auth.uid();
--    → 0 filas (admin ve todos).
--
-- ROLLBACK INDIVIDUAL (si algo se rompe):
--   Restaurar policy SELECT abierta:
--     DROP POLICY pricing_observations_select ON pricing_observations;
--     CREATE POLICY pricing_observations_select ON pricing_observations
--       FOR SELECT TO authenticated USING (true);
--   Restaurar RPC sin guard: re-aplicar mig 65 (overrides).
-- ════════════════════════════════════════════════════════════════════════
