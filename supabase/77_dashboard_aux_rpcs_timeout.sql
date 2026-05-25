-- ════════════════════════════════════════════════════════════════════════
-- Migración 77 — statement_timeout para RPCs auxiliares del dashboard
--
-- CONTEXTO:
--   Mig 76 cubrió get_dashboard_data_weekly + get_dashboard_data_daily,
--   pero el dashboard también dispara en paralelo varias RPCs auxiliares
--   que NO tenían timeout configurado y caían a 8s del rol authenticated
--   durante el catch-up del sync:
--
--     - get_available_zones      (usado por FilterBar)
--     - get_indrive_summary      (usado por sección InDrive)
--     - get_indrive_weekly       (usado por sección InDrive)
--     - get_indrive_counts       (usado por sección InDrive)
--     - get_bot_vs_hubs_summary  (usado por comparativa bot vs hubs)
--
-- FIX:
--   `SET statement_timeout = '30s'` a cada una. Mismo razonamiento de
--   mig 76: 30s da margen durante picos de IO del sync, sin perder el
--   safety net del rol entero.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

DO $migration$
DECLARE
  fnsig text;
  sigs  text[] := ARRAY[
    'get_available_zones(text, text, text)',
    'get_indrive_summary(text, numeric)',
    'get_indrive_weekly(text, numeric)',
    'get_indrive_counts(text)',
    'get_bot_vs_hubs_summary(text)'
  ];
BEGIN
  FOREACH fnsig IN ARRAY sigs LOOP
    BEGIN
      EXECUTE format('ALTER FUNCTION %s SET statement_timeout = ''30s''', fnsig);
      RAISE NOTICE 'Timeout aplicado: %', fnsig;
    EXCEPTION
      WHEN undefined_function OR undefined_object THEN
        RAISE NOTICE 'Skip (firma no existe): %', fnsig;
    END;
  END LOOP;
END
$migration$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
--   SELECT proname, proconfig FROM pg_proc
--   WHERE proname IN (
--     'get_available_zones','get_indrive_summary','get_indrive_weekly',
--     'get_indrive_counts','get_bot_vs_hubs_summary'
--   );
--   -> Todas con "statement_timeout=30s" en proconfig.
-- ════════════════════════════════════════════════════════════════════════
