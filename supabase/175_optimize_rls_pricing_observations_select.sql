-- ════════════════════════════════════════════════════════════════════════
-- 175_optimize_rls_pricing_observations_select.sql — bug real P0 (2026-07-29):
-- exportar/consultar RawData con muchas filas terminaba en "canceling
-- statement due to statement timeout" (8s, límite del rol `authenticated`).
--
-- CAUSA RAÍZ: la política pricing_observations_select usaba
-- `USING (can_access_country(country))`. Como `country` es una columna que
-- varía por fila, Postgres evaluaba can_access_country() UNA VEZ POR FILA
-- (confirmado con EXPLAIN ANALYZE: 50.373 invocaciones para una consulta de
-- 2 semanas en Lima → 16.5 segundos). Ni envolver auth.email() en
-- `(select ...)` adentro de la función alcanzaba, porque la función entera
-- se sigue llamando por fila cuando recibe un argumento correlacionado a la
-- fila — el wrap solo ayuda cuando NO hay ese argumento.
--
-- FIX REAL: en vez de llamar una función por fila, la política ahora
-- calcula UNA SOLA VEZ (subquery no correlacionada, sin referenciar
-- `country`) la lista de países a los que el usuario tiene acceso, y
-- compara cada fila contra esa lista con `country IN (...)` — Postgres
-- puede resolver esto con un hashed subplan calculado una vez (InitPlan),
-- no una función ejecutada 50 mil veces. Mismo resultado de permisos que
-- can_access_country(), solo reestructurado para que el planner lo pueda
-- cachear.
--
-- Validado en producción antes de este archivo (EXPLAIN ANALYZE con
-- SET LOCAL role authenticated + request.jwt.claims simulando usuarios
-- reales):
--   - masantillanag (admin, bypass): 16.500ms → 39ms.
--   - alexdokuchaev@yango-team.com (analyst, countries=[Peru]): 60ms,
--     50.373 filas correctas para Perú, 0 filas para Colombia (bloqueado
--     correctamente — el fix no abrió ningún acceso de más).
--   - check-rls-policy-drift: 0 políticas duplicadas post-cambio.
--
-- PENDIENTE (fuera de alcance de este fix puntual, por prudencia bajo
-- presión de tiempo): el mismo patrón `USING (can_access_country(country))`
-- se usa en las políticas UPDATE/DELETE de esta tabla y en varias otras
-- del proyecto — se beneficiarían del mismo rediseño, pero no se tocan acá.
-- Evaluar en una sesión dedicada con validación local completa.
--
-- is_admin()/can_access_country() ya se actualizaron por separado (mismo
-- incidente) para envolver auth.email() en (select ...) — buena práctica
-- igual, aunque no resolvía este caso puntual por sí sola.
-- ════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM user_profiles up
    JOIN roles r ON r.id = up.role_id
    WHERE up.email   = (select auth.email())
      AND up.is_active = true
      AND r.name     = 'admin'
  );
$function$;

CREATE OR REPLACE FUNCTION public.can_access_country(p_country text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT
    p_country IS NOT NULL AND (
      is_admin() OR
      EXISTS (
        SELECT 1
        FROM user_profiles up
        JOIN roles r ON r.id = up.role_id
        WHERE up.email = (select auth.email())
          AND up.is_active = true
          AND (
            r.permissions->'countries' ? p_country OR
            r.permissions->'countries' ? 'all'
          )
      )
    );
$function$;

DROP POLICY IF EXISTS pricing_observations_select ON public.pricing_observations;

CREATE POLICY pricing_observations_select ON public.pricing_observations
  FOR SELECT TO authenticated
  USING (
    (select is_admin())
    OR country IN (
      SELECT jsonb_array_elements_text(r.permissions -> 'countries')
      FROM user_profiles up JOIN roles r ON r.id = up.role_id
      WHERE up.email = (select auth.email()) AND up.is_active = true
    )
    OR EXISTS (
      SELECT 1 FROM user_profiles up JOIN roles r ON r.id = up.role_id
      WHERE up.email = (select auth.email()) AND up.is_active = true
        AND r.permissions->'countries' ? 'all'
    )
  );
