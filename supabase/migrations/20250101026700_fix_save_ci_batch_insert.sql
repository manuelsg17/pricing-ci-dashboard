-- ════════════════════════════════════════════════════════════════════════
-- 186_fix_save_ci_batch_insert.sql — arregla el INSERT de save_ci_batch.
--
-- EL BUG (encontrado al hacer el cutover de la mig 182, 2026-08-01)
-- `save_ci_batch` fallaba en el 100% de las llamadas:
--
--   ERROR 23502: null value in column "id" of relation
--                "pricing_observations_2026_08" violates not-null constraint
--
-- Causa: el cuerpo hacía
--     INSERT INTO pricing_observations
--     SELECT * FROM jsonb_populate_recordset(null::pricing_observations, p_rows);
--
-- `jsonb_populate_recordset` parte de un registro TODO NULL y solo completa
-- las claves presentes en el JSON. Como el payload del cliente no manda `id`
-- —ni tiene por qué: es una secuencia— la columna sale NULL, y `SELECT *` la
-- pasa EXPLÍCITAMENTE al INSERT. Un NULL explícito NO activa el DEFAULT de la
-- columna: Postgres solo usa el default cuando la columna se OMITE de la lista.
--
-- Por eso la mig 182 quedó "INFRA-READY pero sin cutover" y nunca falló: nadie
-- la llamó nunca. Se aplicó sin ejecutarla ni una vez con un payload real.
--
-- EL BUG SILENCIOSO QUE VENÍA ATRÁS, peor que el anterior
-- Aun arreglando `id`, `SELECT *` rompía los otros defaults. El más grave es
-- `data_source` (default 'manual'): si el payload lo omitiera, las filas
-- entrarían con data_source NULL — y el DELETE de esta misma función filtra por
-- `data_source = 'manual'`. Resultado: el siguiente guardado NO encontraría esas
-- filas para reemplazarlas y las duplicaría, en silencio, para siempre.
-- Hoy el cliente sí manda data_source, pero depender de eso es frágil: la lista
-- explícita de columnas + coalesce lo vuelve imposible de romper desde el
-- cliente.
--
-- EL FIX
-- Lista de columnas EXPLÍCITA, sin `id` (para que corra la secuencia), y
-- coalesce en las que tienen default y el cliente no manda (`surge`,
-- `uploaded_at`). El resto del cuerpo —los predicados del DELETE, que son la
-- parte delicada y ya estaban bien— queda intacto.
--
-- Se mantiene SECURITY INVOKER: las políticas RLS de pricing_observations
-- (migs 170/175/176) tienen que seguir aplicando. Una función definer acá sería
-- un bypass de RLS en el camino de escritura más caliente del sistema.
--
-- No cambia la firma, así que NO hace falta DROP FUNCTION (CLAUDE.md §3: un
-- CREATE OR REPLACE con firma distinta crearía un OVERLOAD y rompería
-- PostgREST con PGRST203). Los grants de la mig 182 se conservan.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.save_ci_batch(
  p_country    text,
  p_city       text,
  p_date       date,
  p_zone       text,
  p_user_email text,
  p_routes     jsonb,
  p_rows       jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r          jsonb;
  v_deleted  int := 0;
  v_inserted int := 0;
  v_n        int;
  v_comps    text[];
BEGIN
  IF p_country IS NULL OR p_city IS NULL OR p_date IS NULL THEN
    RAISE EXCEPTION 'save_ci_batch: country, city y date son obligatorios';
  END IF;

  -- ── 1. Borrar cada ruta exacta ──────────────────────────────────────
  -- Sin cambios respecto de la mig 182. Los tres casos de NULL que ya
  -- causaron pérdida de datos siguen igual: point_a/point_b con IS NOT
  -- DISTINCT FROM, la zona CONSTANTE de la vista (nunca la de la fila), y el
  -- predicado de dueño que nunca puede quedar abierto (mig 139).
  FOR r IN SELECT * FROM jsonb_array_elements(coalesce(p_routes, '[]'::jsonb))
  LOOP
    v_comps := CASE
      WHEN jsonb_typeof(r->'competitors') = 'array'
        THEN ARRAY(SELECT jsonb_array_elements_text(r->'competitors'))
      ELSE NULL
    END;
    CONTINUE WHEN v_comps IS NULL OR cardinality(v_comps) = 0;

    DELETE FROM pricing_observations o
    WHERE o.country          = p_country
      AND o.city             = p_city
      AND o.observed_date    = p_date
      AND o.data_source      = 'manual'
      AND o.category         = r->>'category'
      AND o.timeslot         IS NOT DISTINCT FROM r->>'timeslot'
      AND o.distance_bracket IS NOT DISTINCT FROM r->>'bracket'
      AND o.competition_name = ANY (v_comps)
      AND o.point_a IS NOT DISTINCT FROM (r->>'point_a')
      AND o.point_b IS NOT DISTINCT FROM (r->>'point_b')
      AND o.zone    IS NOT DISTINCT FROM p_zone
      AND (
        (p_user_email IS NOT NULL AND (o.uploaded_by = p_user_email OR o.uploaded_by IS NULL))
        OR (p_user_email IS NULL AND o.uploaded_by IS NULL)
      );
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_deleted := v_deleted + v_n;
  END LOOP;

  -- ── 2. Insertar todo de una ────────────────────────────────────────
  -- Lista EXPLÍCITA de columnas. `id` se OMITE a propósito para que corra
  -- nextval(); mandarlo como NULL explícito es lo que rompía la mig 182.
  IF p_rows IS NOT NULL AND jsonb_array_length(p_rows) > 0 THEN
    INSERT INTO pricing_observations (
      city, year, week, observed_date, observed_time, rush_hour,
      point_a, point_b, zone, distance_km, distance_bracket, timeslot,
      category, competition_name, surge, travel_time_min, eta_min,
      recommended_price, minimal_bid, price_with_discount, price_without_discount,
      bid_1, bid_2, bid_3, bid_4, bid_5, upload_batch_id, uploaded_at,
      data_source, country, time_of_day, uploaded_by, no_data
    )
    SELECT
      s.city, s.year, s.week, s.observed_date, s.observed_time, s.rush_hour,
      s.point_a, s.point_b, s.zone, s.distance_km, s.distance_bracket, s.timeslot,
      s.category, s.competition_name,
      coalesce(s.surge, false),          -- default de columna, el cliente no lo manda
      s.travel_time_min, s.eta_min,
      s.recommended_price, s.minimal_bid, s.price_with_discount, s.price_without_discount,
      s.bid_1, s.bid_2, s.bid_3, s.bid_4, s.bid_5, s.upload_batch_id,
      coalesce(s.uploaded_at, now()),    -- idem: sin esto la fila queda sin marca
      -- Blindaje deliberado: el DELETE de arriba filtra por data_source =
      -- 'manual'. Una fila que entrara con NULL sería invisible para el
      -- próximo guardado y se duplicaría en silencio para siempre.
      coalesce(s.data_source, 'manual'),
      coalesce(s.country, p_country),
      s.time_of_day, s.uploaded_by,
      coalesce(s.no_data, false)
    FROM jsonb_populate_recordset(null::pricing_observations, p_rows) s;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_inserted := v_n;
  END IF;

  RETURN jsonb_build_object('deleted', v_deleted, 'inserted', v_inserted);
END;
$function$;

COMMENT ON FUNCTION public.save_ci_batch(text, text, date, text, text, jsonb, jsonb) IS
  'DELETE+INSERT atómico del guardado de Ingresar CI (mig 182, arreglada en la '
  '186). SECURITY INVOKER: respeta las políticas RLS de pricing_observations. '
  'La lista de columnas del INSERT es explícita y sin `id` a propósito — ver 186.';

COMMIT;

-- ── VERIFICACIÓN ──────────────────────────────────────────────────────
-- 1) Sigue habiendo UNA sola firma (un overload rompería PostgREST/PGRST203):
--    SELECT count(*) FROM pg_proc WHERE proname = 'save_ci_batch';  → 1
--
-- 2) Sigue siendo INVOKER y con search_path fijado:
--    SELECT prosecdef, proconfig FROM pg_proc WHERE proname = 'save_ci_batch';
--    → prosecdef = false, proconfig = {"search_path=public, pg_temp"}
--
-- 3) `anon` sigue sin EXECUTE:
--    SELECT has_function_privilege('anon',
--      'save_ci_batch(text,text,date,text,text,jsonb,jsonb)', 'EXECUTE');  → f
--
-- 4) Un insert real ahora funciona y respeta los defaults (ver el bloque de
--    pruebas ejecutado en el cutover: id asignado por la secuencia,
--    data_source='manual', uploaded_at con marca, surge=false).
