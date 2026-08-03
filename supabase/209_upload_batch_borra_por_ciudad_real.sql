-- ════════════════════════════════════════════════════════════════════════
-- 209 — re-subir un Excel de aeropuerto DUPLICA las filas: el borrado se acota
--       a la ciudad del Excel y el trigger las escribe en otra.
--
-- ⚠️  NO APLICADA A PRODUCCIÓN. Requiere autorización explícita del user para
--     ESTA migración puntual (CLAUDE.md §3).
--
-- ── QUÉ PASA ────────────────────────────────────────────────────────────
-- `upload_pricing_batch` borra y después inserta:
--
--     DELETE … WHERE city = p_city AND uploaded_by IS NULL AND …
--     INSERT …
--
-- Pero `pricing_observations` tiene un trigger BEFORE INSERT
-- (`trg_airport_route_pricing_obs`, migs 83/178) que REESCRIBE la ciudad según
-- la columna Zone: una fila que llega como 'Lima' con la zona del Punto A se
-- guarda como 'Lima_Airport_A'.
--
-- O sea que el DELETE mira la ciudad de ANTES del trigger y las filas viven en
-- la de DESPUÉS. Re-subir el mismo Excel no reemplaza nada: acumula. Sin error,
-- sin aviso, y con el resumen diciendo "N filas insertadas".
--
-- Es PREEXISTENTE, no lo introdujo la mig 204: el código viejo (DELETE por
-- PostgREST + inserts en lotes) tenía exactamente el mismo acote por `r.city`
-- pre-trigger. La 204 lo heredó al mover el borrado adentro de la RPC.
--
-- ── EL FIX: INVERTIR EL ORDEN ───────────────────────────────────────────
-- Primero INSERT, después DELETE de lo viejo. Suena al revés y es la única
-- forma de saber a qué ciudades fue a parar el lote sin duplicar la lógica del
-- trigger en un segundo lugar — que es justo lo que CLAUDE.md §4 prohíbe
-- ("ningún trigger de normalización debe vivir en un solo lugar si el dato
-- entra por múltiples caminos"; replicar el ruteo acá sería crear el segundo).
--
-- El `RETURNING city` del INSERT trae la ciudad REAL, ya reescrita por el
-- trigger. Con eso el DELETE borra lo viejo exactamente donde el lote aterrizó.
--
-- Es seguro porque todo pasa en la misma transacción —la RPC ya era atómica— y
-- porque el único índice único de la tabla (`ux_po_bot_natural_key`) es parcial
-- sobre `data_source = 'bot'`: las filas manuales no chocan entre sí, así que
-- convivir un instante con las viejas no rompe nada.
--
-- ── EL LOTE SE IDENTIFICA POR `upload_batch_id` ─────────────────────────
-- Para no borrar lo que se acaba de insertar, el DELETE excluye el batch
-- actual. El id ya venía en cada fila (Upload.jsx lo genera con
-- crypto.randomUUID); acá se toma de ahí, se exige que sea UNO SOLO, y se
-- FUERZA en el INSERT. Si el cliente no lo manda, la RPC genera el suyo: así el
-- algoritmo no depende de la versión del bundle.
--
-- ── UN CAMBIO DE ALCANCE DELIBERADO ─────────────────────────────────────
-- Antes, subir CUALQUIER hoja de Lima borraba todo 'Lima' del rango. Ahora se
-- borra solo en las ciudades donde el lote efectivamente escribió. Si alguien
-- sube una hoja que es toda de aeropuerto, las filas de Lima base del rango
-- SOBREVIVEN.
--
-- Es a propósito y es más correcto: un upload reemplaza lo que cubre, no lo que
-- comparte prefijo. El comportamiento viejo borraba data que no venía a
-- reemplazar, que es la otra mitad del mismo descuido.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.upload_pricing_batch(
  p_country text, p_city text, p_from date, p_to date, p_rows jsonb
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_borradas   int := 0;
  v_insertadas int := 0;
  v_batch      uuid;
  v_n_batches  int;
  v_ciudades   text[];
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

  -- Un solo batch por llamada. Dos ids distintos significarían que el cliente
  -- mezcló lotes, y el DELETE de abajo se llevaría puesto uno de los dos.
  SELECT count(DISTINCT r->>'upload_batch_id'), min(r->>'upload_batch_id')::uuid
    INTO v_n_batches, v_batch
  FROM jsonb_array_elements(p_rows) r
  WHERE r->>'upload_batch_id' IS NOT NULL;

  IF v_n_batches > 1 THEN
    RAISE EXCEPTION 'upload_pricing_batch: el lote trae % upload_batch_id distintos', v_n_batches
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_batch := coalesce(v_batch, gen_random_uuid());

  -- ── 1. INSERT primero ───────────────────────────────────────────────
  -- Lista EXPLÍCITA de columnas, sin `id` (lección de la 182).
  -- `RETURNING city` es el punto entero de invertir el orden: devuelve la
  -- ciudad DESPUÉS del trigger de ruteo de aeropuerto.
  WITH ins AS (
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
      r.price_without_discount, r.bid_1, r.bid_2, r.bid_3,
      -- Forzado: es la identidad del lote y de él depende no borrar lo recién
      -- insertado. No puede venir contradicho fila por fila.
      v_batch,
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
      coalesce(r.no_data, false)
    FROM jsonb_populate_recordset(NULL::pricing_observations, p_rows) r
    RETURNING city
  )
  SELECT count(*)::int, array_agg(DISTINCT city)
    INTO v_insertadas, v_ciudades
  FROM ins;

  -- ── 2. Y ahora sí, borrar lo viejo DONDE EL LOTE ATERRIZÓ ───────────
  IF v_ciudades IS NOT NULL AND array_length(v_ciudades, 1) > 0 THEN
    DELETE FROM pricing_observations
    WHERE country = p_country
      AND city = ANY (v_ciudades)      -- la ciudad REAL, post-trigger
      AND data_source = 'manual'
      AND uploaded_by IS NULL          -- mig 139: no tocar lo que cargó un hub
      AND observed_date BETWEEN p_from AND p_to
      AND upload_batch_id IS DISTINCT FROM v_batch;  -- todo menos este lote
    GET DIAGNOSTICS v_borradas = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object(
    'city', p_city, 'deleted', v_borradas, 'inserted', v_insertadas,
    'cities', to_jsonb(v_ciudades), 'batch', v_batch
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.upload_pricing_batch(text, text, date, date, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upload_pricing_batch(text, text, date, date, jsonb) TO authenticated;

COMMIT;

-- ── VERIFICACIÓN ──────────────────────────────────────────────────────
-- Con un rol {"sections":["upload"],"countries":["Peru"]} y ROLE authenticated:
--   1) subir un Excel de aeropuerto (city='Lima' + zona del Punto A)
--        → las filas quedan en 'Lima_Airport_A'
--   2) subir EL MISMO Excel otra vez
--        → deleted = las de la primera, y el total NO se duplica
--   3) subir una hoja mixta (base + aeropuerto)
--        → limpia las dos ciudades
--   4) el trabajo de un hub (uploaded_by NOT NULL) en el mismo rango sobrevive
--   5) lote vacío → excepción, sin borrar
--   6) dos upload_batch_id distintos en el mismo lote → excepción
--   7) rol sin la sección `upload` → access_denied
