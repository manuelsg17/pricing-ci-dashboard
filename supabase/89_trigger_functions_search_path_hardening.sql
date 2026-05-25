-- ════════════════════════════════════════════════════════════════════════
-- Migración 89 — Hardening de search_path en funciones de trigger legacy
--
-- CONTEXTO:
--   Mig 61 hardened todas las funciones SECURITY DEFINER del schema
--   public con `SET search_path = public, pg_temp` para mitigar el CVE
--   clásico de hijacking de search_path. Pero su DO block tenía dos
--   problemas:
--     1. Solo iteraba sobre SECURITY DEFINER (prosecdef=true), saltándose
--        las SECURITY INVOKER que también son atacables vía relación
--        objects en schemas ajenos al search_path del caller.
--     2. La cláusula NOT EXISTS interna era buggy (siempre falsa) por lo
--        que en algunos entornos el auto-harden quedó como no-op.
--
--   Auditoría 2026-05-24 identificó 3 funciones de trigger sin SET
--   search_path:
--     - trg_assign_computed_fields() (mig 03/42, BEFORE INSERT pricing_obs)
--     - tg_normalize_pricing_observations() (mig 70, BEFORE INSERT/UPDATE)
--     - tg_guard_corp_competitor() (mig 71, BEFORE INSERT/UPDATE)
--
--   También trg_airport_markers_set_updated_at() de mig 78 (INVOKER pero
--   trivial — lo incluimos por consistencia).
--
-- QUÉ HACE:
--   ALTER FUNCTION para cada una de las 4 funciones, agregando
--   `SET search_path = public, pg_temp`. ALTER es metadata-only —
--   no toca el cuerpo de la función ni rompe triggers existentes.
--
-- DEFENSIVO:
--   Usa DO block con EXCEPTION WHEN undefined_function para tolerar
--   ausencia de funciones (otros proyectos que no aplicaron mig 70/71/78).
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

DO $migration$
DECLARE
  fnsig text;
  sigs  text[] := ARRAY[
    -- Funciones de trigger sobre pricing_observations
    'trg_assign_computed_fields()',
    'tg_normalize_pricing_observations()',
    'tg_guard_corp_competitor()',
    -- Helper trigger sobre airport_markers
    'trg_airport_markers_set_updated_at()'
  ];
BEGIN
  FOREACH fnsig IN ARRAY sigs LOOP
    BEGIN
      EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', fnsig);
      RAISE NOTICE 'search_path hardened: %', fnsig;
    EXCEPTION
      WHEN undefined_function OR undefined_object THEN
        RAISE NOTICE 'Skip (función no existe): %', fnsig;
      WHEN OTHERS THEN
        RAISE NOTICE 'Skip (error): % — %', fnsig, SQLERRM;
    END;
  END LOOP;
END
$migration$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
--   SELECT proname, proconfig
--   FROM pg_proc
--   WHERE proname IN (
--     'trg_assign_computed_fields',
--     'tg_normalize_pricing_observations',
--     'tg_guard_corp_competitor',
--     'trg_airport_markers_set_updated_at'
--   );
--
--   Esperado: cada fila con proconfig conteniendo "search_path=public, pg_temp".
-- ════════════════════════════════════════════════════════════════════════
