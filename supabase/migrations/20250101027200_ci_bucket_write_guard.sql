-- ════════════════════════════════════════════════════════════════════════
-- 191_ci_bucket_write_guard.sql — guard de concurrencia de save_ci_batch.
--
-- EL BUG (SESIONES_HALLAZGOS.md P1-10)
-- Con DOS pestañas en el MISMO bucket (país+ciudad+zona+fecha), tocar una
-- sola celda de una ruta que la otra pestaña ya guardó mete esa ruta en el
-- DELETE de save_ci_batch y la reinserta con lo poco que ESTA pestaña tiene
-- en memoria. Se pierden filas en la BD, sin ningún error visible.
--
-- POR QUÉ VA EN EL SERVIDOR Y NO SOLO EN EL NAVEGADOR
-- Un candado de pestañas (localStorage) no ve el caso real más peligroso: el
-- hub con la laptop y el celular, o dos personas compartiendo la cuenta —
-- escenario ya contemplado en el comentario de SESSION_ID (src/lib/supabase.js).
-- Este guard es el único backstop que cubre eso.
--
-- CÓMO FUNCIONA
-- Una marca de agua por (dueño, país, ciudad, zona, fecha) con un CONTADOR
-- monótono. El cliente lee el contador al cargar y lo devuelve al guardar:
-- si no coincide Y la última escritura vino de OTRA pestaña, el guardado se
-- aborta ENTERO — no se borra ni se inserta una sola fila.
--
-- POR QUÉ CONTADOR Y NO TIMESTAMP: con timestamps no se puede distinguir
-- "escribió mi otra pestaña" de "escribí yo hace 2 segundos", y eso rompería
-- el reintento idempotente que el cliente promete hoy explícitamente
-- ("reintentar Terminar es seguro"). Guardando quién escribió último, la
-- regla "mi propia pestaña siempre puede" preserva esa promesa: un reintento
-- tras un timeout de red NUNCA da falso conflicto.
--
-- ⚠️ ES UN GUARD OPERATIVO, NO UN CONTROL DE SEGURIDAD. El cliente elige su
-- session_id y puede mandar p_force. Protege al hub de sí mismo, no contra un
-- cliente hostil. Queda escrito acá para que nadie lo lea al revés en seis
-- meses.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS public.ci_bucket_writes (
  user_email    text        NOT NULL,
  country       text        NOT NULL,
  city          text        NOT NULL,
  -- zone_key y no zone: la PK no admite expresiones, y hay zonas NULL (todo
  -- lo que no es TukTuk) y zonas '' (rutas Corp en distance_references). Se
  -- normalizan a '' en UN solo lugar, acá.
  zone_key      text        NOT NULL DEFAULT '',
  observed_date date        NOT NULL,
  write_seq     bigint      NOT NULL DEFAULT 0,
  last_session  text,
  last_write_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_email, country, city, zone_key, observed_date)
);

COMMENT ON TABLE public.ci_bucket_writes IS
  'Marca de agua de escritura de Ingresar CI (mig 191). write_seq lo bumpea '
  'SOLO save_ci_batch. Guard contra pérdida silenciosa con dos pestañas o dos '
  'dispositivos; NO es un control de seguridad.';

ALTER TABLE public.ci_bucket_writes ENABLE ROW LEVEL SECURITY;

-- Deny by default: authenticated SOLO lee su propia fila. Las escrituras
-- entran únicamente por la función DEFINER de abajo — sin GRANT de
-- INSERT/UPDATE/DELETE (RLS y GRANT son complementarios, CLAUDE.md §3).
GRANT SELECT ON public.ci_bucket_writes TO authenticated;
REVOKE ALL ON public.ci_bucket_writes FROM anon;

DROP POLICY IF EXISTS ci_bucket_writes_select ON public.ci_bucket_writes;
CREATE POLICY ci_bucket_writes_select ON public.ci_bucket_writes
  FOR SELECT TO authenticated
  USING (
    can_access_country(country)
    AND (user_email = (select auth.email()) OR is_admin())
  );

-- ── El guard: chequea y bumpea, atómico ───────────────────────────────
CREATE OR REPLACE FUNCTION public.ci_bucket_write_guard(
  p_country      text,
  p_city         text,
  p_zone         text,
  p_date         date,
  p_session_id   text,
  p_expected_seq bigint,
  p_force        boolean DEFAULT false
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_email text := (select auth.email());
  v_zone  text := coalesce(nullif(p_zone, ''), '');
  v_cur   ci_bucket_writes%ROWTYPE;
  v_new   bigint;
BEGIN
  IF v_email IS NULL THEN
    RAISE EXCEPTION 'no_session' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM require_country_access(p_country);

  -- Bundle VIEJO (el hub puede tener la pestaña abierta desde ayer): no manda
  -- identidad de pestaña, así que se lo deja pasar exactamente como antes.
  -- Es el paso "expandir" de CLAUDE.md §4 — desplegar el guard no puede
  -- romper a un cliente que todavía tiene el bundle anterior en caché.
  IF p_session_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Serializa dos guardados concurrentes del MISMO bucket. Hace falta el
  -- advisory lock y no alcanza un SELECT ... FOR UPDATE: sobre una fila que
  -- todavía no existe, FOR UPDATE no bloquea nada y los dos PRIMEROS
  -- guardados simultáneos se colarían.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(v_email || '|' || p_country || '|' || p_city || '|' ||
                     v_zone || '|' || p_date::text, 0)
  );

  SELECT * INTO v_cur FROM ci_bucket_writes
  WHERE user_email = v_email AND country = p_country AND city = p_city
    AND zone_key = v_zone AND observed_date = p_date;

  IF FOUND
     AND NOT p_force
     -- last_session NULL = lo escribió un bundle previo a esta migración: no
     -- hay con qué razonar, se deja pasar. Sin esto, el día del deploy todo
     -- hub con trabajo en curso comería un conflicto falso.
     AND v_cur.last_session IS NOT NULL
     -- Mi propia pestaña SIEMPRE puede reescribir: es lo que mantiene seguro
     -- el reintento tras un timeout y el doble click en Guardar.
     AND v_cur.last_session <> p_session_id
     AND (p_expected_seq IS NULL OR p_expected_seq <> v_cur.write_seq)
  THEN
    -- El cliente matchea por CÓDIGO, no por texto: un mensaje se refactoriza,
    -- un SQLSTATE es contrato.
    RAISE EXCEPTION 'ci_save_conflict'
      USING ERRCODE = '55006',
            DETAIL  = to_char(v_cur.last_write_at AT TIME ZONE 'UTC',
                              'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            HINT    = 'otro dispositivo o pestaña guardó este bucket despues de la ultima sincronizacion de este cliente';
  END IF;

  INSERT INTO ci_bucket_writes AS w (
    user_email, country, city, zone_key, observed_date,
    write_seq, last_session, last_write_at
  ) VALUES (
    v_email, p_country, p_city, v_zone, p_date, 1, p_session_id, now()
  )
  ON CONFLICT (user_email, country, city, zone_key, observed_date) DO UPDATE SET
    write_seq     = w.write_seq + 1,
    last_session  = EXCLUDED.last_session,
    last_write_at = now()
  RETURNING w.write_seq INTO v_new;

  RETURN v_new;
END;
$function$;

REVOKE ALL ON FUNCTION public.ci_bucket_write_guard(text,text,text,date,text,bigint,boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ci_bucket_write_guard(text,text,text,date,text,bigint,boolean) TO authenticated;

-- ── save_ci_batch con 3 parámetros nuevos ─────────────────────────────
-- DROP OBLIGATORIO de la firma vieja (CLAUDE.md §3): un CREATE OR REPLACE con
-- parámetros distintos crea un OVERLOAD, y PostgREST devuelve PGRST203 para
-- TODOS los clientes — se rompería el guardado de todos los hubs a la vez.
-- Con los DEFAULT, un bundle viejo que manda solo los 7 originales sigue
-- resolviendo a esta misma función.
DROP FUNCTION IF EXISTS public.save_ci_batch(text, text, date, text, text, jsonb, jsonb);

CREATE OR REPLACE FUNCTION public.save_ci_batch(
  p_country      text,
  p_city         text,
  p_date         date,
  p_zone         text,
  p_user_email   text,
  p_routes       jsonb,
  p_rows         jsonb,
  p_session_id   text    DEFAULT NULL,
  p_expected_seq bigint  DEFAULT NULL,
  p_force        boolean DEFAULT false
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
  v_seq      bigint;
BEGIN
  IF p_country IS NULL OR p_city IS NULL OR p_date IS NULL THEN
    RAISE EXCEPTION 'save_ci_batch: country, city y date son obligatorios';
  END IF;

  -- ANTES de tocar una sola fila. Si levanta ci_save_conflict, la transacción
  -- entera aborta: no se borró ni se insertó nada.
  v_seq := ci_bucket_write_guard(p_country, p_city, p_zone, p_date,
                                 p_session_id, p_expected_seq, p_force);

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
  RETURN jsonb_build_object('deleted', v_deleted, 'inserted', v_inserted, 'seq', v_seq);
END;
$function$;

COMMENT ON FUNCTION public.save_ci_batch(text,text,date,text,text,jsonb,jsonb,text,bigint,boolean) IS
  'DELETE+INSERT atómico de Ingresar CI (migs 182/186) + guard de concurrencia '
  '(mig 191). SECURITY INVOKER: las políticas RLS de pricing_observations siguen '
  'aplicando. Devuelve {deleted, inserted, seq}.';

REVOKE ALL ON FUNCTION public.save_ci_batch(text,text,date,text,text,jsonb,jsonb,text,bigint,boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_ci_batch(text,text,date,text,text,jsonb,jsonb,text,bigint,boolean) TO authenticated;

COMMIT;

-- ── VERIFICACIÓN ──────────────────────────────────────────────────────
-- 1) UNA sola firma de save_ci_batch (un overload = PGRST203 = guardado roto
--    para todos los hubs, que es el incidente de la mig 186):
--    SELECT count(*) FROM pg_proc WHERE proname = 'save_ci_batch';   → 1
-- 2) save_ci_batch sigue INVOKER; el guard es DEFINER con search_path fijo:
--    SELECT proname, prosecdef, proconfig FROM pg_proc
--     WHERE proname IN ('save_ci_batch','ci_bucket_write_guard');
-- 3) La tabla nueva no hereda permisos amplios (pg_class.relacl, no
--    information_schema):
--    SELECT relname, relacl FROM pg_class WHERE relname = 'ci_bucket_writes';
-- 4) anon sin nada:
--    SELECT has_table_privilege('anon','ci_bucket_writes','SELECT');  → f
-- 5) El guard NO da falso conflicto con la misma pestaña (reintento seguro),
--    y SÍ conflictúa con otra. Ver el bloque de simulación del cutover.
