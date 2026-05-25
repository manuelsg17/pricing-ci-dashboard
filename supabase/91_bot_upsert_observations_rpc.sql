-- ════════════════════════════════════════════════════════════════════════
-- Migración 91 — RPC bot_upsert_observations: upsert atómico para el bot
--
-- CONTEXTO / BUG EN PROD:
--   La mig 90 creó `ux_po_bot_natural_key` como UNIQUE INDEX **parcial**
--   (WHERE data_source = 'bot'). bot_sync_push.py fue patcheado para hacer
--   POST a `/rest/v1/pricing_observations?on_conflict=<cols>` con
--   `Prefer: resolution=merge-duplicates`. RESULTADO en prod:
--
--     HTTP 400 → 42P10
--     "there is no unique or exclusion constraint matching the
--      ON CONFLICT specification"
--
--   CAUSA RAÍZ:
--     PostgreSQL exige que para inferir un UNIQUE INDEX **parcial** desde
--     una cláusula `ON CONFLICT (cols)`, la sentencia INCLUYA el predicado
--     WHERE del índice (`ON CONFLICT (cols) WHERE data_source = 'bot'`).
--     PostgREST NO permite enviar ese predicado — sólo manda la lista de
--     columnas via `?on_conflict=`. Por eso PG no puede resolver el índice
--     y devuelve 42P10. Es una limitación conocida de PostgREST con
--     índices parciales.
--
-- ALTERNATIVAS EVALUADAS:
--   · (A) Cambiar a UNIQUE total (sin WHERE) — rompería re-uploads
--     manuales legítimos (mig 26 hace DELETE+INSERT contra data_source
--     ='manual' confiando en que duplicados manuales NO violan ninguna
--     restricción global). RECHAZADO.
--   · (B) Quitar el upsert y volver a INSERT plano — restaura el bug
--     original que mig 90 buscaba arreglar (duplicados por reintentos).
--     Sólo se usaría como fallback de emergencia.
--   · (C) Esta migración: RPC SECURITY DEFINER que hace
--     `INSERT ... ON CONFLICT (cols) WHERE data_source='bot' DO UPDATE`
--     EXPLÍCITO. El predicado en la sentencia matchea el WHERE del índice
--     parcial → PG lo resuelve sin ambigüedad.
--
-- DESIGN:
--   · Recibe `p_rows jsonb` (array de objetos con las mismas keys que el
--     bot envía hoy a /rest/v1/pricing_observations).
--   · Usa `jsonb_populate_recordset` para tipar contra el rowtype
--     `pricing_observations` (single source of truth — si la tabla cambia,
--     la RPC se adapta automáticamente).
--   · ON CONFLICT DO UPDATE re-aplica los campos NO-clave (precios, eta,
--     point_a/b, distance_km, etc.) — esto es lo que el path PostgREST
--     `resolution=merge-duplicates` haría. Si el bot reintenta con datos
--     enriquecidos, gana la última escritura.
--   · Devuelve la cantidad de filas INSERTADAS o UPDATEADAS (ambas cuentan
--     en `xmax = 0` heurística pero más simple: GET DIAGNOSTICS ROW_COUNT).
--
-- SEGURIDAD:
--   · SECURITY DEFINER + search_path fijo (defensa estándar — ver mig 89).
--   · GRANT EXECUTE sólo a `service_role` (el bot usa service-role key).
--     `authenticated` NO debe poder llamar esta función — los uploads de
--     UI van por upsert_pricing_batch (mig 26).
--
-- ROLLBACK:
--   DROP FUNCTION public.bot_upsert_observations(jsonb);
--   El bot debe volver al path REST plano + revertir el commit del .py.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.bot_upsert_observations(p_rows jsonb)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_count int;
BEGIN
  -- Inserción atómica con upsert. El WHERE en ON CONFLICT matchea EXACTO
  -- el WHERE del índice parcial `ux_po_bot_natural_key` (mig 90) — esto
  -- es lo que PostgREST no puede expresar y por qué necesitamos esta RPC.
  INSERT INTO public.pricing_observations AS po (
    country, city, observed_date, observed_time,
    category, competition_name,
    recommended_price, price_with_discount, price_without_discount,
    eta_min, surge, distance_bracket, distance_km,
    point_a, point_b, data_source
  )
  SELECT
    r.country, r.city, r.observed_date, r.observed_time,
    r.category, r.competition_name,
    r.recommended_price, r.price_with_discount, r.price_without_discount,
    r.eta_min, r.surge, r.distance_bracket, r.distance_km,
    r.point_a, r.point_b, COALESCE(r.data_source, 'bot')
  FROM jsonb_populate_recordset(null::public.pricing_observations, p_rows) AS r
  ON CONFLICT (
    country, city, observed_date, observed_time,
    category, competition_name, distance_bracket, surge, data_source
  ) WHERE data_source = 'bot'
  DO UPDATE SET
    recommended_price      = EXCLUDED.recommended_price,
    price_with_discount    = EXCLUDED.price_with_discount,
    price_without_discount = EXCLUDED.price_without_discount,
    eta_min                = EXCLUDED.eta_min,
    distance_km            = COALESCE(EXCLUDED.distance_km, po.distance_km),
    point_a                = COALESCE(EXCLUDED.point_a, po.point_a),
    point_b                = COALESCE(EXCLUDED.point_b, po.point_b);

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;

COMMENT ON FUNCTION public.bot_upsert_observations(jsonb) IS
  'Upsert atómico de pricing_observations para el bot. Resuelve el bug 42P10 que PostgREST tiene con índices parciales (mig 90 / ux_po_bot_natural_key). Llamada exclusiva desde scripts/bot-sync/bot_sync_push.py con service_role key. Mig 91.';

-- ── Permisos ────────────────────────────────────────────────────────────
-- Por defecto SECURITY DEFINER ejecuta como el owner (postgres). Cerramos
-- EXECUTE para PUBLIC y abrimos sólo a service_role.
REVOKE ALL ON FUNCTION public.bot_upsert_observations(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bot_upsert_observations(jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bot_upsert_observations(jsonb) TO service_role;

-- ── Verificación ────────────────────────────────────────────────────────
DO $verify$
DECLARE
  v_exists boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'bot_upsert_observations'
  ) INTO v_exists;

  IF NOT v_exists THEN
    RAISE EXCEPTION '[mig 91] bot_upsert_observations no se creó — abortando.'
      USING ERRCODE = 'internal_error';
  END IF;

  RAISE NOTICE '[mig 91] OK · bot_upsert_observations(jsonb) creada y otorgada a service_role.';
  RAISE NOTICE '[mig 91] SIGUIENTE PASO: deploy del bot_sync_push.py patcheado (mismo PR) que llama /rest/v1/rpc/bot_upsert_observations.';
END
$verify$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- DESPUÉS DE APLICAR ESTA MIGRACIÓN:
--
-- 1. Deploy del bot_sync_push.py patcheado. Cambio puntual:
--    POST /rest/v1/pricing_observations?on_conflict=...   ← VIEJO (rompía con 42P10)
--    POST /rest/v1/rpc/bot_upsert_observations            ← NUEVO
--    body: { "p_rows": [<chunk>] }
--
-- 2. Smoke test manual (después del deploy del .py):
--    SELECT COUNT(*) FROM bot_sync_log
--     WHERE country IN ('peru','colombia')
--       AND started_at > now() - interval '1 hour'
--       AND status = 'ok';
--
-- 3. Si todavía hay 42P10 después del deploy del .py:
--    a. Verificar que el índice existe:
--       SELECT indexdef FROM pg_indexes
--        WHERE indexname = 'ux_po_bot_natural_key';
--    b. Si no existe → re-aplicar mig 90 ANTES de mig 91.
--    c. Fallback de emergencia: revertir el .py al INSERT plano sin
--       ?on_conflict (acepta duplicados temporalmente, los dedup vuelven
--       a aplicarse con mig 90 cuando se re-deploye).
-- ════════════════════════════════════════════════════════════════════════
