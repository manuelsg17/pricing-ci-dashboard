-- ════════════════════════════════════════════════════════════════════════
-- Migración 249 — Bracket EFECTIVO en save_ci_batch (mismo patrón que la
--                 zona efectiva de mig 211), cierra el drift de bracket de
--                 TukTuk encontrado en la auditoría 2026-09-12.
--
-- POR QUÉ:
--   Confirmado con datos reales de producción: la misma ruta TukTuk (mismo
--   point_a/point_b, mismo distance_km=2.5), mismo hub, mismo día, se
--   guardó con distance_bracket='average' a las 22:52 y 'median' a las
--   02:54 — 27 minutos después de que un admin editara distance_thresholds
--   para TukTuk/Lima (02:27). El cliente arma el payload con
--   `distance_references.bracket`, una columna ESTÁTICA que nunca se
--   recalcula cuando cambian los umbrales — mientras que `save_ci_batch`
--   borra por ruta EXACTA (incluye distance_bracket en el WHERE). Si el
--   bracket que manda el cliente no coincide con el que ya está guardado,
--   el DELETE no encuentra la fila vieja y el guardado acumula una copia.
--
--   Es la MISMA clase de bug que la mig 211 (zona de Aeropuerto) y la 209
--   (ciudad del upload de Excel): el predicado del borrado mira un valor
--   que puede quedar desincronizado de la fuente de verdad real.
--
-- POR QUÉ NO SE TOCA EL CLIENTE (investigado a fondo antes de decidir):
--   `DataEntry.jsx` (god-component, 3307 líneas) NO calcula el bracket —
--   lo lee tal cual de `distance_references.bracket`, cacheado en React
--   Query. Recalcularlo en el cliente exigiría replicar en JS la regla que
--   ya vive en `get_distance_bracket()` (SQL) — el segundo lugar que
--   CLAUDE.md §4 prohíbe, y la causa raíz de este bug de origen (la config
--   vive en dos sitios: la columna estática y la función). El fix correcto
--   es el mismo que la 211: una función ÚNICA que resuelve el bracket
--   EFECTIVO, usada tanto para decidir qué borrar como para lo que se
--   inserta. Cero líneas de DataEntry.jsx tocadas.
--
-- LA REGLA (revisada tras probarla: la primera versión de este archivo NO
-- alcanzaba — ver nota al pie):
--   Cuando la ruta tiene point_a/point_b (TukTuk, Aeropuerto), ESOS DOS
--   PUNTOS ya identifican la fila sin ambigüedad — el bracket deja de ser
--   parte de lo que el DELETE busca. Al INSERT sí se le escribe el bracket
--   EFECTIVO (recalculado con los umbrales VIGENTES vía
--   `get_distance_bracket`), así que la fila se auto-corrige sola la
--   próxima vez que alguien la re-guarda, sin backfill aparte.
--   Sin point_a/point_b (Economy/Comfort, Corp, etc. — el hub elige el
--   bracket a mano) todo sigue exactamente como antes: el bracket es parte
--   de la identidad de la fila.
--
--   POR QUÉ NO ALCANZABA calcular el bracket efectivo también para el
--   DELETE (mi primer intento, descartado tras un test que lo reprodujo):
--   los umbrales de distance_thresholds son configuración que CAMBIA con
--   el tiempo — a diferencia de la zona de Aeropuerto (mig 211, siempre la
--   misma transformación), "el bracket de hoy" y "el bracket con el que se
--   guardó la fila la semana pasada" pueden ser legítimamente distintos.
--   Si el DELETE buscara el bracket de HOY, nunca encontraría una fila
--   escrita antes de la última edición de umbrales — el mismatch se vuelve
--   permanente en vez de transitorio, y CADA edición de umbrales generaría
--   un duplicado nuevo por cada ruta ya guardada. Point_a/point_b como
--   única llave evita depender de un valor que cambia con el tiempo.
--
-- SEGURIDAD: no toca RLS ni grants — solo la lógica interna de una función
--   SECURITY DEFINER ya existente y una función STABLE nueva de solo
--   lectura (misma superficie que ci_zona_efectiva).
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1 · La regla, en un solo lugar ─────────────────────────────────────
-- Bracket que una ruta VA A TENER si se recalcula con los umbrales de HOY.
CREATE OR REPLACE FUNCTION public.ci_bracket_efectivo(
  p_country text, p_city text, p_category text,
  p_bracket_provisto text, p_distance_km numeric
)
RETURNS text
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  -- Sin distancia real conocida (la mayoría de categorías: el bracket lo
  -- elige el hub a mano, no hay point_a/point_b) → el valor del cliente
  -- manda, comportamiento sin cambios.
  -- Con distancia real → recalcular con los umbrales VIGENTES. El COALESCE
  -- final es una red de seguridad (get_distance_bracket ya nunca devuelve
  -- NULL si p_distance no es NULL, pero no cuesta nada blindarlo).
  SELECT CASE
    WHEN p_distance_km IS NULL THEN p_bracket_provisto
    ELSE COALESCE(
      public.get_distance_bracket(p_country, p_city, p_category, p_distance_km),
      p_bracket_provisto
    )
  END;
$function$;

COMMENT ON FUNCTION public.ci_bracket_efectivo(text, text, text, text, numeric) IS
  'Bracket que una ruta de Ingresar CI tendrá si se recalcula con los '
  'umbrales de distance_thresholds VIGENTES (no los que tenía cuando se '
  'creó la referencia). Fuente única: la usa save_ci_batch (mig 249) tanto '
  'para decidir qué fila borrar como para lo que inserta — no pueden '
  'divergir. Sin distancia conocida, respeta el valor provisto tal cual.';

REVOKE ALL ON FUNCTION public.ci_bracket_efectivo(text, text, text, text, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ci_bracket_efectivo(text, text, text, text, numeric) TO authenticated;

-- ── 2 · save_ci_batch usa el bracket efectivo para borrar y para insertar ─
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
  v_zone     text;
BEGIN
  IF p_country IS NULL OR p_city IS NULL OR p_date IS NULL THEN
    RAISE EXCEPTION 'save_ci_batch: country, city y date son obligatorios';
  END IF;

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

  IF NOT v_admin AND p_user_email IS DISTINCT FROM v_caller THEN
    RAISE EXCEPTION 'access_denied: no se puede guardar a nombre de otro hub'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  p_user_email := coalesce(p_user_email, v_caller);

  -- 211: la zona REAL, la de después del trigger.
  v_zone := ci_zona_efectiva(p_country, p_city, p_zone);

  v_seq := ci_bucket_write_guard(p_country, p_city, p_zone, p_date,
                                 p_session_id, p_expected_seq, p_force);

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
      -- 249: con point_a/point_b (TukTuk, Aeropuerto) esos dos puntos YA
      -- identifican la fila sin ambigüedad, así que el bracket deja de
      -- filtrar — si lo hiciera, una fila guardada antes de la última
      -- edición de distance_thresholds jamás matchearía el bracket que se
      -- calcula HOY, y el mismatch sería permanente en vez de transitorio.
      -- Sin point_a/point_b (la mayoría: el hub elige el bracket a mano)
      -- el bracket sigue siendo parte de la identidad, sin cambios.
      AND (
        ((r->>'point_a') IS NOT NULL OR (r->>'point_b') IS NOT NULL)
        OR o.distance_bracket IS NOT DISTINCT FROM r->>'bracket'
      )
      AND o.competition_name = ANY (v_comps)
      AND o.point_a IS NOT DISTINCT FROM (r->>'point_a')
      AND o.point_b IS NOT DISTINCT FROM (r->>'point_b')
      AND o.zone    IS NOT DISTINCT FROM v_zone
      AND (o.uploaded_by = p_user_email OR o.uploaded_by IS NULL);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_deleted := v_deleted + v_n;
  END LOOP;

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
      p_city, s.year, s.week, p_date, s.observed_time, s.rush_hour,
      s.point_a, s.point_b, v_zone, s.distance_km,
      -- 249: mismo bracket efectivo que buscó el DELETE de arriba, para que
      -- lo insertado y lo que el próximo guardado va a buscar sean el
      -- mismo valor otra vez.
      public.ci_bracket_efectivo(p_country, p_city, s.category, s.distance_bracket, s.distance_km),
      s.timeslot,
      s.category, s.competition_name,
      coalesce(s.surge, false),
      s.travel_time_min, s.eta_min,
      s.recommended_price, s.minimal_bid, s.price_with_discount, s.price_without_discount,
      s.bid_1, s.bid_2, s.bid_3, s.bid_4, s.bid_5, s.upload_batch_id,
      coalesce(s.uploaded_at, now()),
      coalesce(s.data_source, 'manual'),
      p_country,
      s.time_of_day,
      p_user_email,
      coalesce(s.no_data, false)
    FROM jsonb_populate_recordset(null::pricing_observations, p_rows) s;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_inserted := v_n;
  END IF;

  RETURN jsonb_build_object('deleted', v_deleted, 'inserted', v_inserted, 'seq', v_seq);
END;
$function$;

REVOKE ALL ON FUNCTION public.save_ci_batch(text, text, date, text, text, jsonb, jsonb, text, bigint, boolean)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_ci_batch(text, text, date, text, text, jsonb, jsonb, text, bigint, boolean)
  TO authenticated;

COMMIT;

-- ── VERIFICACIÓN ──────────────────────────────────────────────────────
-- scripts/simulate-bracket-tuktuk.sql, con SET LOCAL ROLE authenticated:
--   1) Guardar una ruta TukTuk → 1 fila con el bracket calculado hoy.
--   2) Cambiar distance_thresholds de forma que la MISMA ruta recalcule a
--      otro bracket, volver a guardarla con el bracket VIEJO en el
--      payload (el cliente no se enteró del cambio) → debe seguir
--      quedando 1 SOLA fila (antes de esta migración quedaban 2), y esa
--      fila debe tener el bracket EFECTIVO de hoy, no el viejo.
--   3) Categorías sin point_a/point_b (Economy/Comfort, Corp) → el
--      bracket que manda el cliente sigue siendo la identidad de la fila,
--      sin cambios de comportamiento.
--   4) Aeropuerto sigue con su zona efectiva intacta (mig 211 sin tocar).
-- ════════════════════════════════════════════════════════════════════════
