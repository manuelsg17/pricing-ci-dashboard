-- ════════════════════════════════════════════════════════════════════════
-- 204_upload_batch_transaccional.sql — que la carga masiva deje de poder
-- borrar sin insertar.
--
-- ⚠️  NO APLICADA. Requiere autorización explícita del user (CLAUDE.md §3).
--
-- EL PROBLEMA
-- `Upload.jsx` hace el DELETE del rango (ciudad + fechas) y DESPUÉS los INSERT,
-- en llamadas HTTP separadas. No hay transacción: si un lote falla, lo borrado
-- no vuelve. No hay re-INSERT, no hay rollback, y el usuario ve un error
-- después de que los datos ya desaparecieron.
--
-- Y no es un escenario de laboratorio. Caminos alcanzables desde la UI que
-- hacen fallar el INSERT:
--   · Cambiar el desplegable de ciudad a Corp: `updateSheetCity` reescribe
--     `city` pero NO vuelve a correr el filtro anti-Yango de Corp, así que el
--     trigger `tg_guard_corp_competitor` aborta el lote entero.
--   · Una fecha imposible que los parsers dejaron pasar (31/02).
--   · Cualquier violación de RLS o de constraint en una sola fila del lote.
--
-- Es además el ÚNICO camino de escritura masiva del proyecto que no usa una
-- RPC. `save_ci_batch` (el camino del hub) hace exactamente esto mismo —
-- DELETE + INSERT idempotente— dentro de una función, o sea en UNA transacción.
-- CLAUDE.md §1 lo nombra como el patrón canónico.
--
-- ── EL CONTRATO ────────────────────────────────────────────────────────
-- Una llamada por CIUDAD, con su rango de fechas y sus filas. La función borra
-- y reinserta en la misma transacción: o queda todo, o no se toca nada.
--
-- El DELETE conserva el acotamiento que ya tenía el cliente y que la mig 139
-- puso a propósito: `data_source='manual' AND uploaded_by IS NULL`. Así el
-- import de Excel NO se lleva puesto lo que los hubs cargaron a mano, que sí
-- lleva `uploaded_by`.
--
-- ── SOBRE LA LISTA EXPLÍCITA DE COLUMNAS ───────────────────────────────
-- Es la lección de la mig 182, que estuvo meses rota. `INSERT ... SELECT *`
-- desde `jsonb_populate_recordset` pasa NULL explícito para las claves
-- ausentes, y un NULL explícito NO dispara el DEFAULT de la columna: el insert
-- moría con 23502 sobre `id`. Acá se nombran las 33 columnas escribibles y se
-- omite `id` para que su DEFAULT actúe.
--
-- `uploaded_at` también se omite a propósito: la escribe la base, no el cliente.
--
-- Y no alcanza con omitir `id`: toda columna NOT NULL con DEFAULT necesita un
-- COALESCE explícito, porque la clave ausente llega como NULL y el DEFAULT no
-- actúa. En esta tabla son `country` (forzada desde el parámetro) y `no_data`.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.upload_pricing_batch(
  p_country text,
  p_city    text,
  p_from    date,
  p_to      date,
  p_rows    jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_borradas int := 0;
  v_insertadas int := 0;
BEGIN
  -- SECURITY INVOKER a propósito: las políticas de `pricing_observations`
  -- siguen siendo la autoridad (la mig 203 les puso el criterio de dueño). La
  -- función aporta la ATOMICIDAD, no un permiso nuevo.
  --
  -- El gate de sección igual se chequea acá para que el rebote sea explícito y
  -- temprano, en vez de un DELETE que borra 0 filas en silencio y un INSERT que
  -- falla después.
  IF NOT can_access_section('upload') THEN
    RAISE EXCEPTION 'access_denied: la carga masiva requiere la sección Cargar Data'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM require_country_access(p_country);

  IF p_city IS NULL OR p_from IS NULL OR p_to IS NULL THEN
    RAISE EXCEPTION 'upload_pricing_batch: faltan ciudad o rango de fechas'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;
  IF p_from > p_to THEN
    RAISE EXCEPTION 'upload_pricing_batch: rango invertido (% > %)', p_from, p_to
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF jsonb_typeof(coalesce(p_rows, 'null'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'upload_pricing_batch: p_rows tiene que ser un array'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Un lote vacío NO puede borrar: sería la peor forma de perder datos.
  IF jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'upload_pricing_batch: lote vacío — no se borra nada'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  DELETE FROM pricing_observations
  WHERE country = p_country
    AND city = p_city
    AND data_source = 'manual'
    AND uploaded_by IS NULL          -- mig 139: no tocar lo que cargó un hub
    AND observed_date BETWEEN p_from AND p_to;
  GET DIAGNOSTICS v_borradas = ROW_COUNT;

  -- Lista EXPLÍCITA de columnas, sin `id` (ver cabecera, lección de la 182).
  INSERT INTO pricing_observations (
    city, year, week, observed_date, observed_time, rush_hour, point_a, point_b,
    zone, distance_km, distance_bracket, timeslot, category, competition_name,
    surge, travel_time_min, eta_min, recommended_price, minimal_bid,
    price_with_discount, price_without_discount, bid_1, bid_2, bid_3,
    upload_batch_id, data_source, country, time_of_day, bid_4, bid_5,
    uploaded_by, no_data
  )
  SELECT
    r.city, r.year, r.week, r.observed_date, r.observed_time, r.rush_hour,
    r.point_a, r.point_b, r.zone, r.distance_km, r.distance_bracket, r.timeslot,
    r.category, r.competition_name, r.surge, r.travel_time_min, r.eta_min,
    r.recommended_price, r.minimal_bid, r.price_with_discount,
    r.price_without_discount, r.bid_1, r.bid_2, r.bid_3, r.upload_batch_id,
    -- Se fuerzan desde los parámetros y no se leen del payload: son la
    -- identidad del lote y no pueden venir contradichas fila por fila.
    'manual', p_country,
    r.time_of_day, r.bid_4, r.bid_5,
    NULL,                            -- uploaded_by: el Excel no tiene dueño
    -- COALESCE, no `r.no_data` pelado. `no_data` es NOT NULL con DEFAULT false,
    -- y `jsonb_populate_recordset` devuelve NULL para las claves AUSENTES — un
    -- NULL explícito NO dispara el DEFAULT. Es la trampa exacta de la mig 182,
    -- y la primera versión de ESTE archivo cayó en ella pese a documentarla en
    -- la cabecera: el primer test dio 23502 sobre no_data.
    -- `country` está en la misma situación y ya viene forzado desde p_country.
    coalesce(r.no_data, false)
  FROM jsonb_populate_recordset(NULL::pricing_observations, p_rows) r;
  GET DIAGNOSTICS v_insertadas = ROW_COUNT;

  RETURN jsonb_build_object(
    'city', p_city, 'deleted', v_borradas, 'inserted', v_insertadas
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.upload_pricing_batch(text, text, date, date, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upload_pricing_batch(text, text, date, date, jsonb)
  TO authenticated;

COMMENT ON FUNCTION public.upload_pricing_batch(text, text, date, date, jsonb) IS
  'Carga masiva de Excel: DELETE del rango + INSERT, en UNA transacción (mig '
  '204). Antes el cliente hacía las dos cosas en llamadas HTTP separadas y un '
  'INSERT fallido dejaba el rango borrado sin nada que lo reemplace. Rechaza '
  'lote vacío. SECURITY INVOKER: la RLS sigue siendo la autoridad.';

COMMIT;

-- ── VERIFICACIÓN ──────────────────────────────────────────────────────
-- 1) Camino feliz: N filas → {deleted: M, inserted: N}, y una segunda llamada
--    con las mismas filas deja el mismo total (idempotente por rango).
--
-- 2) LO QUE ESTA MIGRACIÓN VIENE A ARREGLAR — una fila envenenada en el medio
--    del lote (por ejemplo Yango en Corp, que dispara tg_guard_corp_competitor):
--      · el INSERT aborta
--      · y el DELETE SE REVIERTE: las filas viejas siguen ahí
--    Antes de la 204 esas filas ya no existían.
--
-- 3) Lote vacío → excepción, no un borrado silencioso.
--
-- 4) Un rol sin la sección `upload` → access_denied.
--
-- 5) El DELETE sigue sin tocar lo de los hubs:
--      insertar una fila con uploaded_by='hub@x' en el mismo rango, correr la
--      RPC, y verificar que esa fila sobrevive.
