-- ════════════════════════════════════════════════════════════════════════
-- 211 — el guardado de Ingresar CI DUPLICA en Aeropuerto: el borrado busca
--       la zona de ANTES del trigger y las filas viven en la de DESPUÉS.
--
-- ⚠️  NO APLICADA A PRODUCCIÓN. Requiere autorización explícita del user para
--     ESTA migración puntual (CLAUDE.md §3).
--
-- ── CÓMO SE ENCONTRÓ ────────────────────────────────────────────────────
-- Revisando que los hubs siguieran trabajando bien tras las migs 206-210.
-- No es una regresión de esas migraciones: es crónico y muy anterior.
--
-- ── QUÉ PASA ────────────────────────────────────────────────────────────
-- `save_ci_batch` borra la ruta exacta antes de reinsertarla, y acota por
--
--     AND o.zone IS NOT DISTINCT FROM p_zone
--
-- En Aeropuerto el cliente manda `p_zone = NULL` — la vista de aeropuerto no
-- tiene zona, el distrito solo existe en TukTuk (DataEntry.jsx: `p_zone: zone
-- ?? null`). Pero el trigger `zz_auto_tag_airport_zone` (mig 180) COMPLETA la
-- zona al insertar: una fila que entra como `city='Arequipa_Airport_A',
-- zone=NULL` se guarda con `zone='Airport_A'`.
--
-- O sea que el DELETE busca `zone IS NULL` y las filas están en 'Airport_A':
-- **no borra nada, y cada re-guardado acumula una copia entera de la grilla.**
-- Sin error, sin aviso, y la UI dice "guardado".
--
-- Es la MISMA clase de bug que la mig 209 arregló para el upload de Excel
-- (ahí era la ciudad, acá es la zona): el predicado del borrado mira el valor
-- pre-trigger y las filas viven en el post-trigger.
--
-- ── MEDIDO EN PRODUCCIÓN, no deducido ───────────────────────────────────
-- Grupos (ruta exacta + dueño) con más de una fila, últimas 3 semanas:
--
--     AEROPUERTO (zona la pone el trigger)      3.613
--     TukTuk     (zona la manda el cliente)        27
--     Normal/Corp(zona NULL de punta a punta)       0
--
-- La correlación es la prueba: donde el cliente manda una zona que COINCIDE
-- con la guardada, no hay duplicados; donde la pone el trigger, sí.
--
-- Caso concreto: raisalopez / Arequipa_Airport_A / 2026-08-03, dos guardados
-- con 27 segundos de diferencia (17:08:15 y 17:08:42) → 108 celdas duplicadas,
-- 60 de ellas CON precio, que se cuentan dos veces en los promedios.
--
-- ── EL FIX, Y POR QUÉ NO SE REPLICA LA LÓGICA DEL TRIGGER ───────────────
-- Lo directo sería calcular la zona de aeropuerto adentro de `save_ci_batch`.
-- Eso crea el SEGUNDO lugar donde vive la misma regla de normalización, que
-- es exactamente lo que CLAUDE.md §4 prohíbe ("ningún trigger de
-- normalización debe vivir en un solo lugar si el dato entra por múltiples
-- caminos") — y es la causa raíz de este bug y del de la 209.
--
-- Así que la regla se extrae a UNA función, `ci_zona_efectiva()`, y la usan
-- los dos: el trigger que la escribe y el borrado que la busca. No pueden
-- divergir porque son la misma línea de código.
--
-- La función es config-driven igual que el trigger (lee `airport_markers`),
-- así que un rename desde la pestaña Aeropuertos sigue funcionando sin tocar
-- código, y respeta la misma precedencia: una zona explícita NUNCA se pisa.
--
-- El INSERT también pasa a escribir la zona efectiva en vez de `p_zone`. No
-- cambia el resultado —el trigger llegaba a lo mismo— pero deja de depender
-- del orden de disparo de los triggers para que el valor insertado y el
-- buscado por el DELETE sean el mismo.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1 · La regla, en un solo lugar ─────────────────────────────────────
-- Devuelve la zona que una fila VA A TENER después de los triggers, para
-- una (país, ciudad, zona pedida) dadas.
CREATE OR REPLACE FUNCTION public.ci_zona_efectiva(
  p_country text, p_city text, p_zone text
)
RETURNS text
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(
    -- Una zona explícita gana siempre: el trigger solo rellena, nunca pisa.
    -- Cubre TukTuk (el distrito) y cualquier zona puesta a mano.
    nullif(btrim(coalesce(p_zone, '')), ''),
    -- Vacía + ciudad que es un lado de aeropuerto → la del marcador.
    (SELECT CASE
              WHEN p_city = m.city_from THEN m.zone_from_value
              WHEN p_city = m.city_to   THEN m.zone_to_value
            END
       FROM airport_markers m
      WHERE m.country = p_country
        AND m.active
        AND p_city IN (m.city_from, m.city_to)
      LIMIT 1)
    -- Ni una cosa ni la otra → NULL (Normal, Corp).
  );
$function$;

COMMENT ON FUNCTION public.ci_zona_efectiva(text, text, text) IS
  'Zona que tendrá una fila de pricing_observations después de los triggers. '
  'Fuente ÚNICA de la regla: la usan el trigger que la escribe (mig 180) y el '
  'DELETE de save_ci_batch que la busca (mig 211). No pueden divergir.';

REVOKE ALL ON FUNCTION public.ci_zona_efectiva(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ci_zona_efectiva(text, text, text) TO authenticated;

-- ── 2 · El trigger pasa a usarla ───────────────────────────────────────
-- Mismo comportamiento exacto que la mig 180 — se refactoriza para que la
-- regla tenga un dueño único, no para cambiar qué hace.
CREATE OR REPLACE FUNCTION public.trg_auto_tag_airport_zone()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.city IS NULL OR NEW.country IS NULL THEN
    RETURN NEW;
  END IF;
  NEW.zone := ci_zona_efectiva(NEW.country, NEW.city, NEW.zone);
  RETURN NEW;
END;
$function$;

-- ── 3 · El guardado busca y escribe la MISMA zona ──────────────────────
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

  -- Guards propios (mig 208): con DEFINER, RLS no mira esta función.
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

  -- ── 211 · La zona REAL, la de después del trigger ─────────────────────
  -- En Aeropuerto `p_zone` llega NULL y la fila termina con 'Airport_A'. Sin
  -- esto, el DELETE de abajo busca NULL, no encuentra nada, y el guardado
  -- acumula una copia entera de la grilla en cada pasada.
  --
  -- El guard de bucket (mig 191) sigue recibiendo `p_zone` CRUDO a propósito:
  -- su clave la comparte con el cliente, que no conoce la zona efectiva.
  v_zone := ci_zona_efectiva(p_country, p_city, p_zone);

  v_seq := ci_bucket_write_guard(p_country, p_city, p_zone, p_date,
                                 p_session_id, p_expected_seq, p_force);

  -- ── Borrar cada ruta exacta ─────────────────────────────────────────
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
      -- 211: la zona EFECTIVA, no la cruda. El resto del acote no cambia —
      -- sigue siendo la ruta exacta, nunca una categoría o franja entera.
      AND o.zone    IS NOT DISTINCT FROM v_zone
      AND (o.uploaded_by = p_user_email OR o.uploaded_by IS NULL);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_deleted := v_deleted + v_n;
  END LOOP;

  -- ── Insertar ────────────────────────────────────────────────────────
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
      -- 211: `v_zone`, no `p_zone`. El trigger llegaba al mismo valor, pero
      -- escribirlo acá deja de depender del ORDEN de disparo de los triggers
      -- para que lo insertado y lo que busca el DELETE sean el mismo dato.
      s.point_a, s.point_b, v_zone, s.distance_km, s.distance_bracket, s.timeslot,
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
-- `npm run simulate:zona-aeropuerto`, con SET LOCAL ROLE authenticated:
--   1) Aeropuerto guardado DOS veces → 1 fila, no 2   ← el bug
--   2) mutación (volver a `p_zone` en el DELETE) → el caso 1 se pone en rojo
--   3) TukTuk sigue idempotente (la zona la manda el cliente)
--   4) Normal/Corp sigue idempotente (zona NULL de punta a punta)
--   5) el trabajo de OTRO hub en la misma ruta sobrevive (mig 139)
--   6) una fila de Excel de aeropuerto con OTRA zona no se la lleva puesta
--   7) el reclamo de legacy (uploaded_by IS NULL) sigue funcionando (mig 208)
--   8) `ci_zona_efectiva` = lo que realmente escribe el trigger, en los 4 casos
--
-- El BACKFILL de los duplicados históricos va en un archivo aparte (212) para
-- poder aplicar el fix sin tocar datos y medir antes de borrar nada.
