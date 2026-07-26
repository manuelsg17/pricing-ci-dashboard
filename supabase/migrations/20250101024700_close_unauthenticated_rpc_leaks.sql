-- ════════════════════════════════════════════════════════════════════════
-- 166_close_unauthenticated_rpc_leaks.sql — auditoría de seguridad activa
-- 2026-07-26 (pedida explícitamente por el user: "probá como si quisieras
-- hackear mi página"). Confirmado en vivo simulando `SET LOCAL ROLE anon`
-- contra producción: 4 RPCs de analítica devolvían filas reales de
-- pricing de CUALQUIER país SIN NINGÚN login, y 12 RPCs de mantenimiento
-- del pipeline del bot (algunas de ESCRITURA masiva) eran ejecutables por
-- cualquiera con la clave anónima pública, sin ningún chequeo de
-- autorización en el cuerpo — a diferencia de sus funciones hermanas, que
-- sí llaman `require_country_access()`/`is_admin()`. Mismo patrón de bug
-- que las fugas RLS de mig 60-66/130/164-165, pero en RPCs en vez de
-- policies: la puerta simplemente nunca se cerró para estas funciones.
--
-- Se verificó contra el código real (`grep` en src/) cuáles de estas RPCs
-- se llaman de verdad desde la UI antes de decidir el fix de cada una:
--
-- A) 4 RPCs de Análisis (SÍ se usan desde paneles admin) — se agrega
--    `require_country_access(p_country)` al inicio, mismo patrón que
--    `get_representativity`/`get_dashboard_data_daily`. Se convierten de
--    `LANGUAGE sql` a `LANGUAGE plpgsql` porque SQL puro no soporta el
--    guard de la forma estándar del proyecto (PERFORM + RETURN QUERY).
--    No cambia el resultado para ningún caller legítimo (admin/analyst
--    con acceso al país que ya está pidiendo) — solo cierra el acceso sin
--    login y el acceso cross-país.
--
-- B) 5 RPCs de mantenimiento SÍ usadas desde Config (panel admin) — se
--    agrega `IF NOT is_admin() THEN RAISE EXCEPTION` al inicio. Antes
--    cualquier `authenticated` (cualquier hub_expert, o directamente
--    `anon`) podía forzar un reset del watermark del bot, recalcular
--    brackets, o crear/borrar snapshots congelados de cualquier país.
--
-- C) 8 RPCs SIN NINGÚN caller en el código actual del cliente (confirmado
--    con grep — código muerto desde la perspectiva de la UI, pero
--    igual de explotable vía API REST directa mientras el GRANT siga
--    abierto) — se revoca el EXECUTE de `anon`/`authenticated`/`PUBLIC`
--    por completo y se deja solo para `service_role` (uso interno del
--    pipeline/scripts, nunca desde el navegador). Incluye
--    `upsert_pricing_batch`, una función de escritura vieja (mig 26) que
--    el flujo real de Upload.jsx ya no usa (inserta directo a la tabla,
--    protegida por RLS) pero que seguía siendo invocable por cualquier
--    hub logueado con un país distinto al declarado en el payload — sin
--    caller legítimo, la revocación es más segura que parchearla.
--
-- Verificado ANTES de escribir esta migración: `pg_get_functiondef` de
-- cada una de las 17 funciones tocadas, leído completo desde producción
-- — los bodies de abajo son copia exacta de lo que corre hoy, con SOLO
-- el guard agregado (o el REVOKE, sin tocar el body). Cero cambio de
-- lógica de negocio.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ────────────────────────────────────────────────────────────────────────
-- A) RPCs de Análisis — agregar require_country_access(p_country)
-- ────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_discount_stats(p_country text, p_city text, p_category text, p_start_date date, p_end_date date)
 RETURNS TABLE(competition_name text, list_avg numeric, final_avg numeric, with_discount bigint, n_total bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM require_country_access(p_country);
  RETURN QUERY
  WITH paired AS (
    SELECT
      competition_name,
      CASE
        WHEN competition_name = 'InDrive' THEN recommended_price
        ELSE price_without_discount
      END AS list_price,
      CASE
        WHEN competition_name = 'InDrive' THEN minimal_bid
        ELSE price_with_discount
      END AS final_price
    FROM pricing_observations
    WHERE country  = p_country
      AND city     = p_city
      AND category = p_category
      AND observed_date BETWEEN p_start_date AND p_end_date
  ),
  filtered AS (
    SELECT * FROM paired
    WHERE list_price IS NOT NULL AND list_price > 0
      AND final_price IS NOT NULL AND final_price > 0
  )
  SELECT
    paired_f.competition_name,
    AVG(paired_f.list_price)::numeric(10,2)                                          AS list_avg,
    AVG(paired_f.final_price)::numeric(10,2)                                         AS final_avg,
    COUNT(*) FILTER (WHERE paired_f.final_price < paired_f.list_price * 0.99)         AS with_discount,
    COUNT(*)                                                                          AS n_total
  FROM filtered paired_f
  GROUP BY paired_f.competition_name;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_heatmap_dow_tod(p_country text, p_city text, p_category text, p_start_date date, p_end_date date)
 RETURNS TABLE(competition_name text, dow integer, time_of_day text, avg_price numeric, n bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM require_country_access(p_country);
  RETURN QUERY
  SELECT
    po.competition_name,
    EXTRACT(isodow FROM po.observed_date)::int AS dow,
    po.time_of_day,
    AVG(CASE
      WHEN po.competition_name = 'InDrive' THEN po.recommended_price
      ELSE po.price_without_discount
    END)::numeric(10,2)                      AS avg_price,
    COUNT(*)                                 AS n
  FROM pricing_observations po
  WHERE po.country  = p_country
    AND po.city     = p_city
    AND po.category = p_category
    AND po.observed_date BETWEEN p_start_date AND p_end_date
    AND po.time_of_day IS NOT NULL
    AND (
      (po.competition_name = 'InDrive' AND po.recommended_price IS NOT NULL AND po.recommended_price > 0)
      OR (po.competition_name <> 'InDrive' AND po.price_without_discount IS NOT NULL AND po.price_without_discount > 0)
    )
  GROUP BY po.competition_name, dow, po.time_of_day;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_rush_valley_stats(p_country text, p_city text, p_category text, p_start_date date, p_end_date date)
 RETURNS TABLE(competition_name text, rush_avg numeric, rush_n bigint, valley_avg numeric, valley_n bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM require_country_access(p_country);
  RETURN QUERY
  WITH base AS (
    SELECT
      competition_name,
      rush_hour,
      CASE
        WHEN competition_name = 'InDrive' THEN recommended_price
        ELSE price_without_discount
      END AS price
    FROM pricing_observations
    WHERE country  = p_country
      AND city     = p_city
      AND category = p_category
      AND observed_date BETWEEN p_start_date AND p_end_date
      AND rush_hour IS NOT NULL
  ),
  filtered AS (
    SELECT * FROM base WHERE price IS NOT NULL AND price > 0
  )
  SELECT
    filtered.competition_name,
    AVG(filtered.price) FILTER (WHERE filtered.rush_hour = true)::numeric(10,2)  AS rush_avg,
    COUNT(*)   FILTER (WHERE filtered.rush_hour = true)                          AS rush_n,
    AVG(filtered.price) FILTER (WHERE filtered.rush_hour = false)::numeric(10,2) AS valley_avg,
    COUNT(*)   FILTER (WHERE filtered.rush_hour = false)                         AS valley_n
  FROM filtered
  GROUP BY filtered.competition_name;
END;
$function$;

CREATE OR REPLACE FUNCTION public.list_unmatched_combos(p_country text, p_days integer DEFAULT 2)
 RETURNS TABLE(app text, vc text, ovc text, db_city text, total_n bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM require_country_access(p_country);
  RETURN QUERY
  WITH last_run AS (
    SELECT notes->'dropped_combos' AS dropped_combos
    FROM bot_sync_log
    WHERE country = p_country
      AND status  = 'ok'
      AND started_at > NOW() - (p_days || ' days')::interval
      AND notes ? 'dropped_combos'
    ORDER BY started_at DESC
    LIMIT 1
  )
  SELECT
    (combo->>'app')         AS app,
    (combo->>'vc')          AS vc,
    (combo->>'ovc')         AS ovc,
    (combo->>'db_city')     AS db_city,
    ((combo->>'n')::bigint) AS total_n
  FROM last_run,
       LATERAL jsonb_array_elements(dropped_combos) AS combo
  ORDER BY total_n DESC
  LIMIT 50;
END;
$function$;

-- ────────────────────────────────────────────────────────────────────────
-- B) RPCs de mantenimiento usadas desde Config admin — agregar is_admin()
-- ────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.reset_bot_watermark(p_country text, p_days_back integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_old timestamptz;
  v_new timestamptz;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'access_denied: resetear el watermark del bot es solo para admin'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

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
$function$;

CREATE OR REPLACE FUNCTION public.recompute_brackets_for(p_country text, p_city text, p_category text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '60s'
AS $function$
DECLARE
  updated_count int;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'access_denied: recalcular brackets es solo para admin'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE pricing_observations
  SET distance_bracket = get_distance_bracket(
    p_country, city, category, distance_km
  )
  WHERE country  = p_country
    AND city     = p_city
    AND category = p_category
    AND distance_km IS NOT NULL;

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.freeze_pricing_wa(p_country text, p_label text DEFAULT NULL::text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  cnt bigint := 0;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'access_denied: congelar promedios es solo para admin'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

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
  FROM v_bracket_weekly_avg_mv v
  WHERE v.country          = p_country
    AND v.country          IS NOT NULL
    AND v.city             IS NOT NULL
    AND v.category         IS NOT NULL
    AND v.competition_name IS NOT NULL
    AND v.distance_bracket IS NOT NULL
  GROUP BY v.country, v.city, v.category, v.year, v.week,
           v.competition_name, v.distance_bracket
  ON CONFLICT (country, city, category, year, week, competition_name, distance_bracket)
  DO NOTHING;

  GET DIAGNOSTICS cnt = ROW_COUNT;

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
    FROM v_bracket_weekly_avg_mv v
    WHERE v.country          = p_country
      AND v.country          IS NOT NULL
      AND v.city             IS NOT NULL
      AND v.category         IS NOT NULL
      AND v.competition_name IS NOT NULL
      AND v.distance_bracket IS NOT NULL
    GROUP BY v.country, v.city, v.category, v.year, v.week,
             v.competition_name, v.distance_bracket
  ),
  weights_resolved AS (
    SELECT
      d.country, d.city, d.category, d.bracket,
      COALESCE(
        (SELECT bw.weight FROM bracket_weights bw
          WHERE bw.country=d.country AND bw.city=d.city AND bw.category=d.category AND bw.bracket=d.bracket
          LIMIT 1),
        (SELECT bw.weight FROM bracket_weights bw
          WHERE bw.country=d.country AND bw.city=d.city AND bw.category='all' AND bw.bracket=d.bracket
          LIMIT 1),
        (SELECT bw.weight FROM bracket_weights bw
          WHERE bw.country=d.country AND bw.city='all' AND bw.category=d.category AND bw.bracket=d.bracket
          LIMIT 1),
        (SELECT bw.weight FROM bracket_weights bw
          WHERE bw.country=d.country AND bw.city='all' AND bw.category='all' AND bw.bracket=d.bracket
          LIMIT 1),
        CASE d.bracket
          WHEN 'very_short' THEN 0.0983
          WHEN 'short'      THEN 0.1967
          WHEN 'median'     THEN 0.1939
          WHEN 'average'    THEN 0.1384
          WHEN 'long'       THEN 0.0750
          WHEN 'very_long'  THEN 0.2970
          ELSE 0
        END
      ) AS weight
    FROM (
      SELECT DISTINCT country, city, category, distance_bracket AS bracket
      FROM per_bracket
    ) d
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
      ON wr.country  = pb.country
     AND wr.city     = pb.city
     AND wr.category = pb.category
     AND wr.bracket  = pb.distance_bracket
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
$function$;

CREATE OR REPLACE FUNCTION public.unfreeze_pricing_wa(p_country text, p_label text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '5s'
AS $function$
DECLARE
  v_count bigint := 0;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'access_denied: descongelar promedios es solo para admin'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_country IS NULL OR p_label IS NULL THEN
    RAISE EXCEPTION 'p_country y p_label son obligatorios';
  END IF;

  DELETE FROM pricing_wa_frozen
  WHERE country = p_country
    AND COALESCE(frozen_label, '(sin etiqueta)') = p_label;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.list_pricing_wa_snapshots(p_country text)
 RETURNS TABLE(frozen_label text, frozen_at_second timestamp with time zone, rows_count bigint, weeks_count bigint, cities_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '5s'
AS $function$
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'access_denied: ver snapshots congelados es solo para admin'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  SELECT
    COALESCE(pwf.frozen_label, '(sin etiqueta)')      AS frozen_label,
    DATE_TRUNC('second', pwf.frozen_at)::timestamptz  AS frozen_at_second,
    count(*)                                          AS rows_count,
    count(DISTINCT (pwf.year, pwf.week))              AS weeks_count,
    count(DISTINCT pwf.city)                          AS cities_count
  FROM pricing_wa_frozen pwf
  WHERE pwf.country = p_country
  GROUP BY 1, 2
  ORDER BY 2 DESC;
END;
$function$;

-- ────────────────────────────────────────────────────────────────────────
-- C) RPCs sin caller en el cliente actual — revocar EXECUTE por completo,
--    dejar solo para service_role (pipeline/scripts internos)
-- ────────────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.sync_bot_quotes(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_bot_quotes(text, integer) TO service_role;

REVOKE ALL ON FUNCTION public.reconcile_indrive_bot_prices() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_indrive_bot_prices() TO service_role;

REVOKE ALL ON FUNCTION public.probe_bot_quotes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.probe_bot_quotes() TO service_role;

REVOKE ALL ON FUNCTION public.diagnose_bot_rules_coverage(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.diagnose_bot_rules_coverage(text, integer) TO service_role;

REVOKE ALL ON FUNCTION public.get_bot_health(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_bot_health(text) TO service_role;

REVOKE ALL ON FUNCTION public.validate_fdw_schema() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_fdw_schema() TO service_role;

REVOKE ALL ON FUNCTION public.unfreeze_pricing_wa_by_id(text, bigint[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.unfreeze_pricing_wa_by_id(text, bigint[]) TO service_role;

-- upsert_pricing_batch (HALLAZGO ALTO #3): sin caller en el cliente actual
-- (Upload.jsx inserta directo a pricing_observations, ya protegida por
-- RLS por país) — permitía, para cualquier hub_expert logueado, insertar
-- filas con un `country` distinto al declarado en p_country dentro del
-- propio payload JSON (el guard solo validaba el parámetro, no cada fila).
-- Sin caller legítimo, revocar es más seguro que parchear la validación.
REVOKE ALL ON FUNCTION public.upsert_pricing_batch(text, jsonb, jsonb, uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_pricing_batch(text, jsonb, jsonb, uuid, text, integer) TO service_role;

COMMIT;
