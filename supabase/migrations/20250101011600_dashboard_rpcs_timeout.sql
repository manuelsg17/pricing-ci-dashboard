-- ════════════════════════════════════════════════════════════════════════
-- Migración 76 — statement_timeout para RPCs del dashboard
--
-- CONTEXTO:
--   get_dashboard_data_weekly / get_dashboard_data_daily son el hot path
--   del dashboard principal. Mig 61 puso timeouts a varias funciones
--   costosas (freeze_pricing_wa, sync_bot_quotes, etc) pero estas dos
--   quedaron heredando el default del rol `authenticated` (8s en
--   Supabase).
--
-- SÍNTOMA OBSERVADO (2026-05-23):
--   Mientras el sync hace catch-up del backlog (corre cada 30 min y
--   mete miles de INSERTs por corrida), las queries del dashboard
--   compiten por IO/CPU. Una query que normalmente toma <1s sobrepasa
--   los 8s y la BD la cancela con `canceling statement due to
--   statement timeout`. La UI muestra una barra de error rosa y un
--   dashboard vacío.
--
-- FIX:
--   `SET statement_timeout = '30s'` a nivel función. 30s es generoso —
--   en condiciones normales son <1s. Esto da margen durante el catch-up
--   sin degradar la respuesta del rol entero (otras queries siguen
--   con el ceiling de 8s y fallan rápido si hay un bug).
--
--   No retoco el cuerpo de las funciones (mismo CREATE OR REPLACE
--   con el SELECT actual de mig 65). Solo agrego el SET. Mantengo
--   la idempotencia: si hay que cambiar la query, esta migración
--   no entra en conflicto.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ALTER FUNCTION funciona acá porque la firma es estable desde mig 65.
-- Si una migración futura cambia la firma, este SET se hereda al
-- CREATE OR REPLACE — y si la firma cambia (drop+create), hay que
-- re-aplicar este ALTER.
DO $migration$
DECLARE
  fnsig text;
  sigs  text[] := ARRAY[
    -- weekly
    'get_dashboard_data_weekly(text, text, text, text, boolean, int, int, int, int, text, text[])',
    -- daily
    'get_dashboard_data_daily(text, text, text, text, boolean, date, date, text, text[])'
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
--   WHERE proname IN ('get_dashboard_data_weekly', 'get_dashboard_data_daily');
--   -> proconfig debe contener "statement_timeout=30s" en ambas.
-- ════════════════════════════════════════════════════════════════════════
