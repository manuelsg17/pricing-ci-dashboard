-- ════════════════════════════════════════════════════════════════════════
-- 193_generic_rpc_gates.sql — las RPCs dejan de nombrar "admin".
--
-- EL HUECO QUE CIERRA
-- Las migs 187/188/192 hicieron genéricas las escrituras por TABLA, pero seis
-- pantallas escriben además por RPC, y esas funciones siguen preguntando
-- `is_admin()`. Para un rol al que se le delegue `config` o `upload`, el
-- resultado es el bug original con otra puerta: la pantalla se abre, los
-- formularios guardan (RLS ya lo permite desde la 188) y el botón de al lado
-- —congelar promedios, recalcular brackets, ver la bitácora— tira
-- "access_denied: … es solo para admin". Peor que un permiso negado: un
-- permiso a medias.
--
-- Lo encontró `npm run check:section-grants` (FASE B), no una lectura a ojo:
-- cruza las RPCs que cada sección llama contra el cuerpo real de cada función
-- en pg_proc.
--
-- QUÉ CAMBIA
--   is_admin()  →  can_access_section('<sección>')
-- `can_access_section()` ya existía (mig 181) y es genérica igual que
-- `can_write_table()`: resuelve contra roles.permissions y devuelve true para
-- admin. Ningún rol ni sección queda escrito en una política.
--
-- LO QUE HABRÍA SIDO UN AGUJERO, y por eso va junto en el mismo cambio:
-- `is_admin()` estaba haciendo DOBLE trabajo. Estas funciones son SECURITY
-- DEFINER —bypasean RLS— y ninguna verifica el país: escriben o leen lo que
-- diga `p_country`. Mientras el guard fue "solo admin", el aislamiento entre
-- países se sostenía por accidente, porque el admin los tiene todos. Aflojar
-- el guard a la sección SIN agregar el chequeo de país habría dejado a
-- cualquier rol con `config` congelar promedios de Colombia desde Perú.
-- Por eso cada función suma `require_country_access(p_country)`.
--
-- `list_audit_log` no toma país como parámetro: filtra POR FILA. Admin sigue
-- viendo todo (incluidas las filas con country NULL, que son cambios
-- globales); un rol con `config` ve solo las de sus países.
--
-- NOTA DE FIRMA (CLAUDE.md §3): ninguna cambia de parámetros, así que
-- `CREATE OR REPLACE` reemplaza de verdad y no crea un OVERLOAD (que dejaría
-- a PostgREST sin poder elegir, PGRST203, y rompería la pantalla en silencio
-- para cualquier bundle viejo en caché). Los cuerpos se extrajeron con
-- `pg_get_functiondef` de la base ya migrada y solo se les tocó el guard:
-- ninguna otra línea cambia.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── Congelar promedios: sección 'config' + país ───────────────
CREATE OR REPLACE FUNCTION public.freeze_pricing_wa(p_country text, p_label text DEFAULT NULL::text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  cnt bigint := 0;
BEGIN
  IF NOT can_access_section('config') THEN
    RAISE EXCEPTION 'access_denied: congelar promedios requiere la sección Configuración'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM require_country_access(p_country);

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

-- ── Descongelar: sección 'config' + país ──────────────────────
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
  IF NOT can_access_section('config') THEN
    RAISE EXCEPTION 'access_denied: descongelar promedios requiere la sección Configuración'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM require_country_access(p_country);

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

-- ── Listar snapshots: sección 'config' + país ─────────────────
CREATE OR REPLACE FUNCTION public.list_pricing_wa_snapshots(p_country text)
 RETURNS TABLE(frozen_label text, frozen_at_second timestamp with time zone, rows_count bigint, weeks_count bigint, cities_count bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '5s'
AS $function$
BEGIN
  IF NOT can_access_section('config') THEN
    RAISE EXCEPTION 'access_denied: ver snapshots congelados requiere la sección Configuración'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM require_country_access(p_country);

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

-- ── Recalcular brackets: sección 'config' + país ──────────────
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
  IF NOT can_access_section('config') THEN
    RAISE EXCEPTION 'access_denied: recalcular brackets requiere la sección Configuración'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM require_country_access(p_country);

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

-- ── Watermark del bot: sección 'upload' + país ────────────────
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
  IF NOT can_access_section('upload') THEN
    RAISE EXCEPTION 'access_denied: resetear el watermark requiere la sección Cargar Data'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM require_country_access(p_country);

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

-- ── Bitácora: admin ve todo; con config, solo sus países ──────
CREATE OR REPLACE FUNCTION public.list_audit_log(p_table text DEFAULT NULL::text, p_user text DEFAULT NULL::text, p_country text DEFAULT NULL::text, p_action text DEFAULT NULL::text, p_since timestamp with time zone DEFAULT NULL::timestamp with time zone, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0)
 RETURNS TABLE(id bigint, ts timestamp with time zone, user_email text, action text, table_name text, row_id text, old_data jsonb, new_data jsonb, country text, session_id text, user_agent text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '15s'
AS $function$
  SELECT id, ts, user_email, action, table_name, row_id,
         old_data, new_data, country, session_id, user_agent
  FROM audit_log
  WHERE
        (is_admin() OR (can_access_section('config') AND can_access_country(country)))
    AND (p_table   IS NULL OR table_name = p_table)
    AND (p_user    IS NULL OR user_email = p_user)
    AND (p_country IS NULL OR country    = p_country)
    AND (p_action  IS NULL OR action     = p_action)
    AND (p_since   IS NULL OR ts        >= p_since)
  ORDER BY ts DESC
  LIMIT  GREATEST(1, LEAST(p_limit, 500))
  OFFSET GREATEST(0, p_offset);
$function$;

COMMIT;

REVOKE ALL ON FUNCTION public.freeze_pricing_wa FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.unfreeze_pricing_wa FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_pricing_wa_snapshots FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.recompute_brackets_for FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reset_bot_watermark FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_audit_log FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.freeze_pricing_wa TO authenticated;
GRANT EXECUTE ON FUNCTION public.unfreeze_pricing_wa TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_pricing_wa_snapshots TO authenticated;
GRANT EXECUTE ON FUNCTION public.recompute_brackets_for TO authenticated;
GRANT EXECUTE ON FUNCTION public.reset_bot_watermark TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_audit_log TO authenticated;

-- ── VERIFICACIÓN ──────────────────────────────────────────────────────
-- 1) No queda ninguna RPC inalcanzable desde su propia sección:
--      npm run check:section-grants        → "OK"
--
-- 2) Las seis quedaron genéricas y ninguna perdió el search_path fijado
--    (CLAUDE.md §3 — un search_path mutable en SECURITY DEFINER es escalación):
--    SELECT proname, proconfig FROM pg_proc
--     WHERE proname IN ('freeze_pricing_wa','unfreeze_pricing_wa',
--                       'list_pricing_wa_snapshots','recompute_brackets_for',
--                       'reset_bot_watermark','list_audit_log');
--
-- 3) Ninguna quedó ejecutable por anon:
--    SELECT p.proname, has_function_privilege('anon', p.oid, 'EXECUTE')
--      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--     WHERE n.nspname='public' AND p.proname IN (…);   → todas f
--
-- 4) El aislamiento por país que antes daba `is_admin()` de rebote ahora es
--    explícito, y se prueba: `npm run simulate:permissions` (bloque 16) crea un
--    rol con config sobre Perú y verifica que congela Perú y NO Colombia.
