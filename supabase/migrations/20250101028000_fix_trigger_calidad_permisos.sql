-- ════════════════════════════════════════════════════════════════════════
-- 199_fix_trigger_calidad_permisos.sql — el trigger de la 195 dejaba al hub
-- sin poder TERMINAR LA SESIÓN.
--
-- EL BUG (detectado en producción el 2026-08-01, minutos después de aplicar
-- la 195, probando como el rol real y no como postgres)
--
-- El bundle desplegado cierra la sesión con un INSERT DIRECTO a `ci_sessions`
-- (src/pages/DataEntry.jsx:2347), corriendo como `authenticated`.
--
--   1. El INSERT dispara `trg_ci_close_fill_quality` (mig 195).
--   2. `ci_close_fill_quality()` es SECURITY INVOKER → corre con los
--      privilegios del HUB, no del dueño.
--   3. Llama a `ci_duration_quality_from_timings`, que llama a
--      `ci_ts_or_null`.
--   4. La mig 194 revocó EXECUTE sobre `ci_ts_or_null` a PUBLIC, anon Y
--      authenticated (higiene: no exponerla como RPC de PostgREST).
--
--   → ERROR 42501 "permission denied for function ci_ts_or_null" y el INSERT
--     entero aborta. El hub no puede cerrar.
--
-- POR QUÉ NO LO CAZÓ LA SIMULACIÓN LOCAL
-- `scripts/simulate-hub-daily-minutes.sql` afirma "toda fila nueva sale
-- clasificada por el trigger" — y pasa. Pero corre como `postgres`, que tiene
-- EXECUTE sobre todo. La regla que falta y que este archivo deja escrita: una
-- simulación que valida un camino de escritura del hub DEBE hacer `SET LOCAL
-- ROLE authenticated`, o solo prueba que el SQL compila.
--
-- Es la misma familia que la mig 182: aplicó limpio y estaba rota porque
-- nadie la había EJECUTADO por el camino real.
--
-- EL FIX
-- Se hace DEFINER la maquinaria interna en vez de re-exponer el helper. Las
-- dos funciones son PURAS respecto de sus argumentos —no leen ni escriben
-- ninguna tabla, solo recorren el jsonb que reciben— así que SECURITY DEFINER
-- no les da acceso a ningún dato que el llamador no tuviera. Ambas ya tienen
-- `search_path` fijado (CLAUDE.md §3).
--
-- Se prefiere esto a re-GRANTear `ci_ts_or_null` porque ese GRANT la volvería
-- a publicar como RPC de PostgREST, que es justo lo que la 194 quiso evitar.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- El trigger: corre en el INSERT del hub, tiene que poder leer los timings.
ALTER FUNCTION public.ci_close_fill_quality()
  SECURITY DEFINER;

-- Está GRANTeada a `authenticated` desde la 195, o sea que se anuncia como
-- llamable; sin esto el grant es una promesa que falla al usarse.
ALTER FUNCTION public.ci_duration_quality_from_timings(jsonb, timestamptz)
  SECURITY DEFINER;

COMMIT;

-- ── VERIFICACIÓN ──────────────────────────────────────────────────────
-- 1) Las dos quedaron DEFINER y con search_path fijado:
--
--    SELECT proname, prosecdef AS definer, proconfig
--      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--     WHERE n.nspname = 'public'
--       AND proname IN ('ci_close_fill_quality','ci_duration_quality_from_timings');
--    → definer = true en las dos, proconfig = {search_path=public, pg_temp}
--
-- 2) EL CHEQUEO QUE IMPORTA — como el rol del hub, no como postgres:
--
--    SET LOCAL ROLE authenticated;
--    SELECT ci_duration_quality_from_timings(
--      '{"Mañana":{"startedAt":"2026-08-01T09:00:00Z",
--                  "endedAt":"2026-08-01T09:40:00Z"}}'::jsonb,
--      now());
--    → NULL (confiable). Si tira 42501, el fix no entró.
--
-- 3) `ci_ts_or_null` SIGUE sin EXECUTE para authenticated (no se re-expuso):
--    SELECT has_function_privilege('authenticated','public.ci_ts_or_null(text)','EXECUTE');
--    → false
