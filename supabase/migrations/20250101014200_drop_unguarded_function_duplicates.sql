-- ════════════════════════════════════════════════════════════════════════
-- Migración 102 — Drop de duplicates sin guard tras mig 101
--
-- CONTEXTO:
--   Mig 101 creó nuevas versiones con require_country_access() de:
--     - get_indrive_summary / get_indrive_weekly / get_indrive_counts
--     - get_available_zones
--     - get_bot_vs_hubs_summary
--     - apply_indrive_bot_prices
--
--   Los DROP FUNCTION IF EXISTS dentro de mig 101 NO matchearon las
--   firmas reales pre-existentes (algunas tenían DEFAULTs o coerciones
--   distintas) → ambas versiones quedaron en pg_proc:
--
--     proname                  | has_guard
--     get_available_zones      | false  ← versión vieja sin guard
--     get_available_zones      | true   ← versión nueva con guard
--     ...
--
--   PostgREST puede rutear a la vieja según los params del cliente →
--   el agujero del audit sigue abierto.
--
-- QUÉ HACE:
--   DO block que itera pg_proc, encuentra cada función con esos nombres,
--   y dropea SOLO las que NO tienen require_country_access en el cuerpo.
--   Independiente de la firma exacta.
--
-- IDEMPOTENCIA:
--   Re-correr es no-op (no quedan unguarded después de la primera pasada).
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

DO $cleanup_unguarded$
DECLARE
  fn record;
  v_dropped int := 0;
BEGIN
  FOR fn IN
    SELECT p.oid,
           p.proname,
           pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'get_indrive_summary',
        'get_indrive_weekly',
        'get_indrive_counts',
        'get_available_zones',
        'get_bot_vs_hubs_summary',
        'apply_indrive_bot_prices'
      )
      AND pg_get_functiondef(p.oid) NOT ILIKE '%require_country_access%'
  LOOP
    EXECUTE format('DROP FUNCTION public.%I(%s) CASCADE', fn.proname, fn.args);
    RAISE NOTICE '[mig 102] DROP unguarded: %(%)', fn.proname, fn.args;
    v_dropped := v_dropped + 1;
  END LOOP;
  RAISE NOTICE '[mig 102] Total funciones sin guard eliminadas: %', v_dropped;
END
$cleanup_unguarded$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
--   SELECT p.proname,
--          pg_get_function_identity_arguments(p.oid) AS args,
--          (pg_get_functiondef(p.oid) ILIKE '%require_country_access%') AS has_guard
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname='public'
--     AND p.proname IN (
--       'get_indrive_summary','get_indrive_weekly','get_indrive_counts',
--       'get_available_zones','get_bot_vs_hubs_summary','apply_indrive_bot_prices'
--     )
--   ORDER BY p.proname;
--
--   Esperado: 6 filas (o más si hay overloads con DEFAULT), TODAS con
--   has_guard=true.
-- ════════════════════════════════════════════════════════════════════════
