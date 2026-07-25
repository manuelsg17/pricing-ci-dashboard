-- ════════════════════════════════════════════════════════════════════════
-- 164_security_hardening.sql — auditoría completa de Supabase Advisors
-- (2026-07-24, pedido user tras ver las alertas del dashboard).
--
-- ── A. CRÍTICO: fuga de RLS entre países en pricing_observations ────────
-- `pricing_observations` tenía DOS capas de políticas RLS al mismo tiempo:
--   - `auth_read_write` (todo autenticado, USING/WITH CHECK = true) — vieja,
--     de antes de que existiera el gating por país.
--   - `pricing_observations_select/_insert/_update/_delete` — las
--     "correctas", con `can_access_country(country)` en SELECT pero
--     `can_edit()` (= is_admin() puro) en INSERT/UPDATE/DELETE.
-- PostgreSQL combina políticas PERMISSIVE del mismo comando con OR. Con
-- `auth_read_write` viva, CUALQUIER usuario autenticado (cualquier hub
-- Peru) podía leer/escribir filas de CUALQUIER país — el filtro de país
-- documentado en migs 105/124-127/156 nunca se aplicaba de verdad a nivel
-- de base, solo a nivel de UI (que un curioso con la consola del navegador
-- podía saltarse). Encontrado revisando por qué el advisor marcaba
-- `rls_policy_always_true`.
--
-- La razón por la que NO se puede simplemente borrar `auth_read_write`:
-- verificado en src/pages/DataEntry.jsx que el hub escribe DIRECTO a la
-- tabla (`sb.from('pricing_observations').insert/delete/select`, sin RPC
-- intermedio) — las políticas de RLS son la ÚNICA protección real. Y
-- `pricing_observations_insert/_update/_delete` exigen `can_edit()` =
-- SOLO ADMIN. Sin `auth_read_write`, todo hub_expert (role_id=2) pierde
-- la capacidad de guardar su trabajo en el acto — el incidente sería
-- peor que el bug que se está arreglando.
--
-- FIX: una sola política por operación, gateada por país (mismo criterio
-- que ya usa SELECT), ni más laxa (todo país) ni más estricta (solo admin).
--
-- Mismo patrón y mismo bug en `earnings_scenarios` (política `auth_all`,
-- confirmado con `country_config`/columna `country` presente y accedida
-- directo del cliente en src/hooks/useEarningsScenarios.js).
-- ════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS auth_read_write ON public.pricing_observations;
DROP POLICY IF EXISTS pricing_observations_insert ON public.pricing_observations;
DROP POLICY IF EXISTS pricing_observations_update ON public.pricing_observations;
DROP POLICY IF EXISTS pricing_observations_delete ON public.pricing_observations;
-- pricing_observations_select ya estaba bien (can_access_country) — queda igual.

CREATE POLICY pricing_observations_insert ON public.pricing_observations
  FOR INSERT TO authenticated
  WITH CHECK (can_access_country(country));

CREATE POLICY pricing_observations_update ON public.pricing_observations
  FOR UPDATE TO authenticated
  USING (can_access_country(country))
  WITH CHECK (can_access_country(country));

CREATE POLICY pricing_observations_delete ON public.pricing_observations
  FOR DELETE TO authenticated
  USING (can_access_country(country));

DROP POLICY IF EXISTS auth_all ON public.earnings_scenarios;
-- Idempotente: el entorno local ya tenía estas 4 políticas correctas desde
-- su propio seed (solo prod cargaba con la `auth_all` histórica) — el DROP
-- previo a cada CREATE hace que la migración funcione igual en los dos
-- puntos de partida.
DROP POLICY IF EXISTS earnings_scenarios_select ON public.earnings_scenarios;
DROP POLICY IF EXISTS earnings_scenarios_insert ON public.earnings_scenarios;
DROP POLICY IF EXISTS earnings_scenarios_update ON public.earnings_scenarios;
DROP POLICY IF EXISTS earnings_scenarios_delete ON public.earnings_scenarios;
CREATE POLICY earnings_scenarios_select ON public.earnings_scenarios
  FOR SELECT TO authenticated USING (can_access_country(country));
CREATE POLICY earnings_scenarios_insert ON public.earnings_scenarios
  FOR INSERT TO authenticated WITH CHECK (can_access_country(country));
CREATE POLICY earnings_scenarios_update ON public.earnings_scenarios
  FOR UPDATE TO authenticated USING (can_access_country(country)) WITH CHECK (can_access_country(country));
CREATE POLICY earnings_scenarios_delete ON public.earnings_scenarios
  FOR DELETE TO authenticated USING (can_access_country(country));

-- ── B. Causa raíz: default privilege de esquema demasiado amplio ────────
-- pg_default_acl mostraba `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN
-- SCHEMA public GRANT ALL ON TABLES TO anon, authenticated` — CADA tabla,
-- vista o MV nueva creada por una migración hereda automáticamente
-- permisos COMPLETOS (lectura Y escritura) para el rol público `anon`,
-- salvo que la migración se acuerde de revocarlos a mano. Así llegaron a
-- tener anon=arwdDxtm las 3 tablas de la mig 163 (detectado y corregido en
-- esa misma mig) y TODOS los objetos de la sección C de abajo, creados en
-- distintos momentos de la vida del proyecto.
--
-- Esto NO afecta objetos ya creados (el default solo aplica al momento del
-- CREATE), así que es seguro de correr ahora — deja de propagarse hacia
-- adelante. Las funciones (RPCs) SÍ necesitan seguir siendo EXECUTE-por-
-- default para anon/authenticated (así funciona el patrón de este
-- proyecto: RPC pública + gating interno con is_admin()/
-- can_access_country()) — no se toca esa regla, solo la de TABLAS.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE ALL ON TABLES FROM anon, authenticated;

-- ── C. Objetos YA expuestos por el default de arriba — cerrar cada uno ──
-- v_effective_price/v_bracket_weekly_avg/v_bracket_daily_avg: vistas
-- planas (no MV), dueño postgres, SIN security_invoker → corren con los
-- privilegios del DUEÑO (bypassean RLS de pricing_observations por
-- completo). Con anon=arwdDxtm, cualquiera con la clave pública del
-- bundle podía leer el dataset CRUDO completo de CI vía REST
-- (GET /rest/v1/v_effective_price), sin pasar por ningún filtro de país.
-- Verificado por grep: el cliente NUNCA las lee directo, solo se usan
-- dentro de otras vistas/funciones — revocar es seguro.
REVOKE ALL ON public.v_effective_price     FROM anon, authenticated, PUBLIC;
REVOKE ALL ON public.v_bracket_weekly_avg  FROM anon, authenticated, PUBLIC;
REVOKE ALL ON public.v_bracket_daily_avg   FROM anon, authenticated, PUBLIC;
-- security_invoker=true: belt-and-suspenders — aunque alguien vuelva a
-- otorgar acceso en el futuro, la vista respeta el RLS del que consulta
-- en vez de correr como el dueño. Requiere PG15+ (este proyecto usa 17).
ALTER VIEW public.v_effective_price    SET (security_invoker = true);
ALTER VIEW public.v_bracket_weekly_avg SET (security_invoker = true);
ALTER VIEW public.v_bracket_daily_avg  SET (security_invoker = true);

-- v_bot_vs_manual_mv: la única MV que la mig 163 dejó como estaba (144 kB,
-- se refresca sola). Mismo problema de grants heredados. A diferencia de
-- las 3 tablas de la mig 163, PostgreSQL NO permite ENABLE ROW LEVEL
-- SECURITY sobre una vista materializada — el REVOKE solo ya alcanza:
-- sin ningún grant, PostgREST no puede tocarla (mismo comportamiento que
-- tenía CUALQUIER MV de este proyecto antes de que el default privilege
-- roto empezara a filtrar acceso).
REVOKE ALL ON public.v_bot_vs_manual_mv FROM anon, authenticated, PUBLIC;

-- bot_quotes_remote: FOREIGN TABLE hacia la BD del bot (postgres_fdw).
-- Solo la usan sync_bot_quotes/probe_bot_quotes (dormidas — el sync real
-- es el script Python, ver project_bot_sync). Con anon=arwdDxtm quedaba
-- accesible por la API pública sin que ninguna RPC lo supiera ni lo
-- necesitara.
REVOKE ALL ON public.bot_quotes_remote FROM anon, authenticated, PUBLIC;

-- 3 tablas de respaldo puntual (limpiezas de datos de TukTuk, ya
-- documentadas en memoria de proyecto) — nadie debe tocarlas vía API.
-- Envuelto en DO/to_regclass: son artefactos puntuales de PRODUCCIÓN que
-- nunca se mirroreoron a un CREATE TABLE versionado, así que no existen en
-- local/CI — sin el guard, la migración fallaría entera fuera de prod.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'public.pricing_observations_backup_tuktuk_bot_20260714',
    'public.pricing_observations_backup_tuktuk_bot_20260720',
    'public.pricing_observations_backup_tuktuk_bot_all_20260720'
  ] LOOP
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('REVOKE ALL ON %s FROM anon, authenticated, PUBLIC', t);
    END IF;
  END LOOP;
END $$;

-- ── D. function_search_path_mutable — mismo patrón de la mig 158 ────────
-- No son SECURITY DEFINER (riesgo menor que las 5 de la mig 158), pero
-- fijar el search_path es la misma buena práctica y el fix es gratis.
ALTER FUNCTION public.get_time_of_day(time without time zone)
  SET search_path = 'public', 'pg_temp';
ALTER FUNCTION public.normalize_distance_bracket(text)
  SET search_path = 'public', 'pg_temp';
ALTER FUNCTION public.tg_normalize_pricing_observations()
  SET search_path = 'public', 'pg_temp';
ALTER FUNCTION public.trg_assign_computed_fields()
  SET search_path = 'public', 'pg_temp';

-- ── E. Performance: auth_rls_initplan ────────────────────────────────────
-- `auth.email()`/`auth.uid()` sueltos en una política RLS se reevalúan
-- FILA POR FILA; envueltos en `(select ...)` el planner los evalúa UNA
-- sola vez por consulta (initplan). Mismas condiciones, más rápido a
-- escala. No toca is_admin()/can_access_country() (ya son funciones
-- STABLE separadas, no llamadas directas a auth.*, no las marcó el
-- advisor).
DROP POLICY IF EXISTS ci_active_sessions_select ON public.ci_active_sessions;
DROP POLICY IF EXISTS ci_active_sessions_insert ON public.ci_active_sessions;
DROP POLICY IF EXISTS ci_active_sessions_update ON public.ci_active_sessions;
DROP POLICY IF EXISTS ci_active_sessions_delete ON public.ci_active_sessions;
CREATE POLICY ci_active_sessions_select ON public.ci_active_sessions
  FOR SELECT TO authenticated USING (is_admin() OR (user_email = (select auth.email())));
CREATE POLICY ci_active_sessions_insert ON public.ci_active_sessions
  FOR INSERT TO authenticated WITH CHECK ((user_email = (select auth.email())) OR is_admin());
CREATE POLICY ci_active_sessions_update ON public.ci_active_sessions
  FOR UPDATE TO authenticated
  USING ((user_email = (select auth.email())) OR is_admin())
  WITH CHECK ((user_email = (select auth.email())) OR is_admin());
CREATE POLICY ci_active_sessions_delete ON public.ci_active_sessions
  FOR DELETE TO authenticated USING ((user_email = (select auth.email())) OR is_admin());

DROP POLICY IF EXISTS ci_sessions_select ON public.ci_sessions;
DROP POLICY IF EXISTS ci_sessions_insert ON public.ci_sessions;
CREATE POLICY ci_sessions_select ON public.ci_sessions
  FOR SELECT TO authenticated USING (is_admin() OR (user_email = (select auth.email())));
CREATE POLICY ci_sessions_insert ON public.ci_sessions
  FOR INSERT TO authenticated WITH CHECK ((user_email = (select auth.email())) OR is_admin());

DROP POLICY IF EXISTS "users manage their own presets" ON public.user_filter_presets;
CREATE POLICY "users manage their own presets" ON public.user_filter_presets
  FOR ALL TO public
  USING ((select auth.uid()) = user_id)
  WITH CHECK ((select auth.uid()) = user_id);

-- `multiple_permissive_policies` en pricing_observations (INSERT/UPDATE/
-- DELETE/SELECT) queda resuelto como efecto colateral de la sección A:
-- ya no hay 2 políticas permisivas pisándose para el mismo comando+rol.
