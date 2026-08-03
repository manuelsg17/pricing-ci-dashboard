-- ════════════════════════════════════════════════════════════════════════
-- 208 — P0: la mig 203 rompió el reclamo de filas legacy de `save_ci_batch`.
--        El hub duplica filas en `pricing_observations`, en silencio.
--
-- ⚠️  NO APLICADA A PRODUCCIÓN. Requiere autorización explícita del user para
--     ESTA migración puntual (CLAUDE.md §3).
--
-- ⚠️  LO INTRODUJE YO CON LA MIG 203, HOY. La 203 ya está aplicada en
--     producción, así que el defecto está ARMADO ahí ahora mismo.
--
-- ── QUÉ PASA ────────────────────────────────────────────────────────────
-- El DELETE de `save_ci_batch` reclama, a propósito, las filas sin dueño de la
-- ruta que el hub está guardando:
--
--     (p_user_email IS NOT NULL AND (o.uploaded_by = p_user_email
--                                    OR o.uploaded_by IS NULL))
--
-- Esa rama NULL es el "reclamo de legacy": una celda que ya venía del Excel
-- masivo o del histórico pasa a ser del hub cuando él la re-mide. Sin ella, la
-- vieja y la nueva conviven.
--
-- La mig 203 cambió esa misma rama EN LA POLÍTICA a
-- `uploaded_by IS NULL AND can_access_section('upload')`. Y `save_ci_batch` es
-- SECURITY INVOKER (`pg_proc.prosecdef = f`), así que su DELETE pasa por RLS:
-- un hub de Ingresar CI —que tiene `dataentry`, no `upload`— ya no borra nada.
--
-- ── REPRODUCIDO, no deducido ────────────────────────────────────────────
-- Rol {"sections":["dataentry"],"countries":["Peru"]}, una fila legacy
-- (uploaded_by NULL) en Lima/2026-08-03/Economy-Comfort/Mañana/short/A→B/Didi,
-- y el hub guardando ESA misma ruta como `authenticated`:
--
--     save_ci_batch → {"seq": null, "deleted": 0, "inserted": 1}
--     filas para esa ruta exacta: 2      ← duplicada
--
-- Con el único cambio de agregarle la sección `upload` al rol:
--
--     save_ci_batch → {"deleted": 1, "inserted": 1}
--     filas para esa ruta exacta: 1
--
-- O sea que la diferencia entre 1 y 2 filas es exactamente la cláusula que
-- agregó la 203. Y la RPC devuelve `deleted: 0` sin error: la UI dice "guardado".
--
-- ── IMPACTO REAL EN PRODUCCIÓN, medido ──────────────────────────────────
-- Cero. Se aplicó la 203 hoy ~11:00 UTC y desde entonces no hubo una sola
-- sesión (`max(started_at) = 2026-08-03 05:41 UTC`, y 0 filas manuales de hoy).
-- Los 68 grupos con la firma del bug que hay en la tabla son del 2026-07-20,
-- muy anteriores. El fix llega antes que el daño, por suerte y no por diseño.
--
-- ── POR QUÉ NO SE ARREGLA EN LA POLÍTICA ────────────────────────────────
-- Lo obvio sería sumarle `dataentry` a la rama NULL. Reabre exactamente el
-- agujero que la 203 vino a cerrar: `useRawDataMutations` borra por `id` desde
-- una ruta que no es adminOnly, y con `dataentry` en esa rama un hub vuelve a
-- poder barrer los ~150.000 registros del bot por PostgREST directo.
--
-- Una política RLS no distingue "borrar esta ruta exacta" de "borrar todo lo
-- que matchee" — es el límite que CLAUDE.md §3 ya deja escrito: *"Una política
-- RLS no puede restringir por COLUMNA. Si el usuario solo debe poder cambiar un
-- campo, la política no alcanza: va por RPC SECURITY DEFINER que valide y
-- escriba solo lo permitido."* Acá es lo mismo un nivel más arriba: la política
-- no puede restringir por FORMA del borrado, y el borrado de `save_ci_batch`
-- ya es de ruta exacta (país+ciudad+zona+fecha+categoría+franja+bracket+
-- point_a+point_b+competidor). No puede desbocarse.
--
-- Así que la RPC pasa a `SECURITY DEFINER` y se hace cargo de sus propios
-- guards. La política queda como la dejó la 203, cerrada.
--
-- ── LO QUE CAMBIA AL PASAR A DEFINER, Y QUE HAY QUE COMPENSAR ───────────
-- Con DEFINER, RLS deja de mirar esta función POR COMPLETO. Todo lo que antes
-- sostenían las políticas —las migs 202 y 203— ahora lo tiene que sostener el
-- código, o el fix abre tres agujeros nuevos. Los tres se cierran acá:
--
--   1. IDENTIDAD. El DELETE usa `p_user_email`, que venía del payload. Con
--      DEFINER, pasar el email de otro hub borraría SUS filas de esa ruta. Ahora
--      `p_user_email` tiene que ser el del que llama (o el llamador es admin).
--   2. DUEÑO DE LO INSERTADO. El `WITH CHECK` de la mig 202 impedía firmar
--      observaciones a nombre ajeno; ya no corre. El `uploaded_by` lo pone la
--      base desde `auth.email()`, no el payload.
--   3. PAÍS Y ALCANCE DE LAS FILAS. El INSERT tomaba `city`/`zone`/`country`/
--      `observed_date` de CADA FILA del payload, y el `can_access_country` de la
--      política era lo único que impedía que una fila dijera 'Colombia'. Ahora
--      los cuatro se fuerzan a los parámetros de la llamada, que son los que
--      pasaron por `require_country_access` y por el guard de bucket.
--
-- Sin el punto 3 este "fix" sería peor que el bug: un hub de Perú escribiendo
-- observaciones en Colombia con un payload a mano.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.save_ci_batch(
  p_country text, p_city text, p_date date, p_zone text, p_user_email text,
  p_routes jsonb, p_rows jsonb, p_session_id text DEFAULT NULL::text,
  p_expected_seq bigint DEFAULT NULL::bigint, p_force boolean DEFAULT false
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  r          jsonb;
  v_deleted  int := 0;
  v_inserted int := 0;
  v_n        int;
  v_comps    text[];
  v_seq      bigint;
  v_caller   text;
  v_admin    boolean;
BEGIN
  IF p_country IS NULL OR p_city IS NULL OR p_date IS NULL THEN
    RAISE EXCEPTION 'save_ci_batch: country, city y date son obligatorios';
  END IF;

  -- ── GUARDS PROPIOS ────────────────────────────────────────────────────
  -- Reemplazan a las políticas RLS, que a partir de acá no se evalúan.
  v_caller := (select auth.email());
  v_admin  := is_admin();

  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'access_denied: guardar CI requiere sesión iniciada'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT can_access_section('dataentry') THEN
    RAISE EXCEPTION 'access_denied: guardar CI requiere la sección Ingresar CI'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM require_country_access(p_country);

  -- La identidad la pone la base. Un hub no guarda —ni borra— a nombre de otro.
  IF NOT v_admin AND p_user_email IS DISTINCT FROM v_caller THEN
    RAISE EXCEPTION 'access_denied: no se puede guardar a nombre de otro hub'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  p_user_email := coalesce(p_user_email, v_caller);

  -- ANTES de tocar una sola fila. Si levanta ci_save_conflict, la transacción
  -- entera aborta: no se borró ni se insertó nada.
  v_seq := ci_bucket_write_guard(p_country, p_city, p_zone, p_date,
                                 p_session_id, p_expected_seq, p_force);

  -- ── 1. Borrar cada ruta exacta ──────────────────────────────────────
  -- Sin cambios respecto de la mig 182. Los tres casos de NULL que ya
  -- causaron pérdida de datos siguen igual: point_a/point_b con IS NOT
  -- DISTINCT FROM, la zona CONSTANTE de la vista (nunca la de la fila), y el
  -- predicado de dueño que nunca puede quedar abierto (mig 139).
  --
  -- La rama `o.uploaded_by IS NULL` es el reclamo de legacy y vuelve a
  -- funcionar acá: con DEFINER ya no la filtra la política de la mig 203. El
  -- acote sigue siendo la ruta exacta, no la sección.
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
      AND (o.uploaded_by = p_user_email OR o.uploaded_by IS NULL);
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
      -- FORZADOS a los parámetros de la llamada, no tomados de la fila: son los
      -- que pasaron por require_country_access y por ci_bucket_write_guard. Si
      -- salieran del payload, con DEFINER un hub de Perú escribiría en Colombia.
      p_city, s.year, s.week, p_date, s.observed_time, s.rush_hour,
      s.point_a, s.point_b, p_zone, s.distance_km, s.distance_bracket, s.timeslot,
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
      p_country,
      s.time_of_day,
      -- El dueño lo pone la base. El WITH CHECK de la mig 202 ya no corre acá.
      p_user_email,
      coalesce(s.no_data, false)
    FROM jsonb_populate_recordset(null::pricing_observations, p_rows) s;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_inserted := v_n;
  END IF;

  RETURN jsonb_build_object('deleted', v_deleted, 'inserted', v_inserted, 'seq', v_seq);
END;
$function$;

-- Sin EXECUTE para anon: es una pantalla logueada (mismo criterio que la 200).
REVOKE ALL ON FUNCTION public.save_ci_batch(text, text, date, text, text, jsonb, jsonb, text, bigint, boolean)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_ci_batch(text, text, date, text, text, jsonb, jsonb, text, bigint, boolean)
  TO authenticated;

COMMIT;

-- ── VERIFICACIÓN ──────────────────────────────────────────────────────
-- Con SET LOCAL ROLE authenticated (nunca como postgres):
--   1) hub {"sections":["dataentry"],"countries":["Peru"]} guarda una ruta que
--      tiene una fila legacy   → deleted=1, y queda UNA fila
--   2) el mismo hub guarda dos veces (idempotencia)         → 1 fila
--   3) el hub NO se lleva puesta la fila de OTRO hub en la misma ruta (mig 139)
--   4) rol sin la sección `dataentry`                       → access_denied
--   5) hub de Perú con p_country='Colombia'                 → access_denied
--   6) hub pasando el p_user_email de un compañero          → access_denied
--   7) payload con country/city/zone/observed_date de otro alcance
--                                                            → se ignoran, la
--      fila queda en el alcance de los PARÁMETROS
--   8) anon                                                  → sin EXECUTE
--
-- Y que la 203 siga cerrada por el otro lado:
--   9) el mismo hub, por PostgREST directo, sigue sin poder borrar las filas
--      con uploaded_by IS NULL de la tabla.
