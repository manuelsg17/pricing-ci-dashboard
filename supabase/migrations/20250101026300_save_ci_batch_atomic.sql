-- ════════════════════════════════════════════════════════════════════════
-- 182_save_ci_batch_atomic.sql — DELETE+INSERT del guardado de CI en UNA
-- transacción.
--
-- ⚠️ INFRA-READY, SIN CUTOVER. Esta función queda creada pero NADIE la llama
--    todavía. El cliente (DataEntry.performSave) sigue haciendo el
--    DELETE+INSERT por separado. Ver "PARA EL CUTOVER" al final.
--
-- CONTEXTO
-- `performSave` (DataEntry.jsx) hace hoy:
--   1. N DELETEs en paralelo (uno por ruta exacta), y
--   2. INSERTs en lotes de 200.
-- Los dos pasos chequean su error y abortan — pero NO son atómicos. Si falla
-- el lote 2 de 3, las filas ya se borraron y solo se reinsertó una parte: la
-- BD queda a medias.
--
-- Está mitigado (el hub ve el error y el borrador local sobrevive, así que
-- reintentar lo arregla y el re-guardado es idempotente), por eso es P2 y no
-- P0. Pero la ventana existe: si el hub cierra la laptop en vez de
-- reintentar, esa ruta queda con datos parciales y nadie se entera.
--
-- APPROACH
-- Mover ambos pasos al servidor. El cuerpo de una función plpgsql corre en una
-- sola transacción: si el INSERT falla, el DELETE se revierte solo. Además
-- baja N+1 round-trips a 1.
--
-- SECURITY INVOKER a propósito (NO definer): así siguen aplicando las
-- políticas RLS de pricing_observations — gating por país y por dueño
-- (migs 170/175/176). Una función definer acá sería un bypass de RLS en el
-- camino de escritura más caliente del sistema.
--
-- Los predicados del DELETE replican EXACTAMENTE los del cliente, incluidos
-- los tres casos de NULL que ya causaron pérdida de datos:
--   · point_a / point_b: `IS NULL` cuando la ruta no los tiene (no `= NULL`).
--   · zone: SIEMPRE la zona constante de la vista (p_zone), nunca la de la
--     fila — hay ~76k filas manuales con zona no-null fuera de TukTuk
--     (Aeropuerto vía Excel) que un DELETE sin este predicado se llevaba
--     puestas en silencio.
--   · uploaded_by: dueño + legacy sin dueño. Sin email, SOLO las sin dueño —
--     nunca un DELETE sin predicado de dueño (mig 139).
-- Y el acote a los competidores VISIBLES de la categoría, para que un
-- competidor marcado "no ofrece" conserve su histórico.
--
-- FORMATO de p_routes (una entrada por ruta exacta a reemplazar):
--   [{"category":"Economy/Comfort","timeslot":"Mañana","bracket":"short",
--     "point_a":"X","point_b":"Y","competitors":["Yango","Uber"]}, …]
-- point_a/point_b/competitors pueden faltar o ser null.
--
-- p_rows: filas completas de pricing_observations (mismo payload que arma hoy
-- buildInsertPayload). Se tipan con jsonb_populate_recordset contra el rowtype
-- real, así que una columna que no exista revienta acá y no a mitad del batch.
--
-- VERIFICACIÓN (hecha contra producción antes de commitear, en transacciones
-- revertidas): para rutas reales, el conteo que borra esta función coincide
-- exactamente con el que borra el cliente hoy; y un INSERT inválido a mitad
-- de camino revierte también el DELETE (que es el punto de todo esto).
--
-- PARA EL CUTOVER (pendiente — requiere lo que pide CLAUDE.md §7.6):
--   1. Reemplazar en performSave los N DELETE + los INSERT por lotes por una
--      sola llamada a esta RPC.
--   2. Probar en NAVEGADOR contra Supabase LOCAL el flujo real del hub:
--      guardar, terminar, F5 real en cada punto, y con 2 usuarios reales
--      (creados por Admin API) para el caso de relevo.
--   3. Confirmar en BD que no quedan filas duplicadas ni huérfanas.
--   Sin esos 3 pasos NO se conecta: este es el flujo con más incidentes de
--   pérdida de datos documentados del proyecto.
-- ════════════════════════════════════════════════════════════════════════

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
  FOR r IN SELECT * FROM jsonb_array_elements(coalesce(p_routes, '[]'::jsonb))
  LOOP
    -- Sin competidores visibles no se borra nada (mismo criterio que el
    -- cliente: evita un DELETE sin acotar por competidor).
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
      -- point_a/point_b: IS NULL cuando la ruta no los define
      AND o.point_a IS NOT DISTINCT FROM (r->>'point_a')
      AND o.point_b IS NOT DISTINCT FROM (r->>'point_b')
      -- zona CONSTANTE de la vista, nunca la de la fila
      AND o.zone IS NOT DISTINCT FROM p_zone
      -- dueño: el hub + legacy sin dueño; sin email, solo las sin dueño
      AND (
        (p_user_email IS NOT NULL AND (o.uploaded_by = p_user_email OR o.uploaded_by IS NULL))
        OR (p_user_email IS NULL AND o.uploaded_by IS NULL)
      );
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_deleted := v_deleted + v_n;
  END LOOP;

  -- ── 2. Insertar todo de una ────────────────────────────────────────
  IF p_rows IS NOT NULL AND jsonb_array_length(p_rows) > 0 THEN
    INSERT INTO pricing_observations
    SELECT * FROM jsonb_populate_recordset(null::pricing_observations, p_rows);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_inserted := v_n;
  END IF;

  RETURN jsonb_build_object('deleted', v_deleted, 'inserted', v_inserted);
END;
$function$;

COMMENT ON FUNCTION public.save_ci_batch(text, text, date, text, text, jsonb, jsonb) IS
  'DELETE+INSERT atómico del guardado de Ingresar CI (mig 182). SECURITY INVOKER: '
  'respeta las políticas RLS de pricing_observations. INFRA-READY: todavía no la '
  'llama nadie — ver el bloque PARA EL CUTOVER en el archivo de migración.';

-- `FROM public` NO alcanza: en este proyecto `anon` tiene su propio GRANT
-- EXECUTE por los ALTER DEFAULT PRIVILEGES de Supabase, así que hay que
-- revocárselo explícitamente (verificado con has_function_privilege tras
-- aplicar: sin este REVOKE, anon quedaba con EXECUTE). No era explotable
-- —con SECURITY INVOKER las políticas de pricing_observations son TO
-- authenticated, así que anon no borraría ni insertaría nada— pero dejar el
-- grant colgado es la misma clase de descuido que causó las fugas de las
-- migs 164-167.
REVOKE ALL ON FUNCTION public.save_ci_batch(text, text, date, text, text, jsonb, jsonb) FROM public;
REVOKE ALL ON FUNCTION public.save_ci_batch(text, text, date, text, text, jsonb, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.save_ci_batch(text, text, date, text, text, jsonb, jsonb) TO authenticated;
