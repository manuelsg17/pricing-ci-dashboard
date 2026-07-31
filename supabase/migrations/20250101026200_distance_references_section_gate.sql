-- ════════════════════════════════════════════════════════════════════════
-- 181_distance_references_section_gate.sql — los hubs con la sección
-- "distances" pueden editar distance_references (hoy solo puede admin).
--
-- CONTEXTO
-- Un hub reportó "new row violates row-level security policy for table
-- distance_references" al intentar guardar una ruta de referencia.
--
-- La causa es un desajuste entre lo que concede la UI y lo que exige la BD:
--   · El rol `hub_expert` (4 usuarios activos) declara
--     permissions.sections = ["dataentry", "distances"], y App.jsx rutea
--     /distances con section:'distances' → la página se les MUESTRA.
--   · Pero las políticas de escritura de distance_references exigen
--     can_edit(), que es literalmente `SELECT is_admin()` → r.name='admin'.
-- Resultado: ven la pantalla, cargan el formulario y el guardado falla.
-- Peor que no tener acceso: parece un bug de la app, no un permiso faltante.
--
-- Se auditaron las 22 tablas con escritura gateada por can_edit(). Las otras
-- 21 son configuración genuinamente administrativa (bot_rules, semaforo_config,
-- country_config, umbrales, ventanas de rush, etc.) y NINGUNA tiene su sección
-- concedida a un rol no-admin — se dejan como están. distance_references es la
-- única con el desajuste, porque es la única cuya sección se delega a los hubs.
-- El arreglo es quirúrgico a propósito.
--
-- APPROACH
-- 1. Nueva función can_access_section(text): misma lógica que
--    useAccessControl.canAccess() en el front (permissions.sections contiene
--    la sección o 'all'), para que UI y BD lean la MISMA fuente de verdad —
--    roles.permissions — en vez de divergir. Admin siempre pasa.
-- 2. Reemplazar las 3 políticas de escritura por el patrón estándar de
--    CLAUDE.md §3 para tablas que los hubs SÍ deben poder escribir:
--        can_access_section('distances') AND can_access_country(country)
--    El gate de país es lo que evita que un hub de Perú toque rutas de otro
--    país: antes no hacía falta porque solo admin escribía.
--
-- DROP POLICY IF EXISTS explícito antes de cada CREATE (CLAUDE.md §3: dos
-- políticas permisivas para el mismo comando se combinan con OR y la vieja y
-- laxa gana en silencio — ya pasó en las migs 60-66, 130 y 164-165).
--
-- auth.email() envuelto en (select ...) dentro de la función nueva: InitPlan
-- una sola vez por consulta en vez de por fila.
--
-- SELECT no se toca: sigue USING(true) — el catálogo de rutas es lectura
-- compartida y ya era así antes de esta migración.
--
-- VERIFICACIÓN
--   · Como hub_expert de Perú: INSERT/UPDATE de una ruta de Perú → permitido.
--   · Como hub_expert de Perú: INSERT de una ruta de otro país → bloqueado.
--   · Como analyst (sin la sección "distances"): INSERT → bloqueado.
--   · check:rls-drift → 1 política por comando, sin duplicados.
-- ════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.can_access_section(p_section text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT
    p_section IS NOT NULL AND (
      is_admin() OR
      EXISTS (
        SELECT 1
        FROM user_profiles up
        JOIN roles r ON r.id = up.role_id
        WHERE up.email = (select auth.email())
          AND up.is_active = true
          AND (
            r.permissions->'sections' ? p_section OR
            r.permissions->'sections' ? 'all'
          )
      )
    );
$function$;

COMMENT ON FUNCTION public.can_access_section(text) IS
  'True si el usuario actual tiene concedida la sección (roles.permissions.sections '
  'contiene la sección o "all"), o es admin. Espeja useAccessControl.canAccess() '
  'del front para que UI y RLS lean la misma fuente de verdad (mig 181).';

DROP POLICY IF EXISTS distance_references_insert ON public.distance_references;
CREATE POLICY distance_references_insert ON public.distance_references
  FOR INSERT TO authenticated
  WITH CHECK (
    can_access_section('distances') AND can_access_country(country)
  );

DROP POLICY IF EXISTS distance_references_update ON public.distance_references;
CREATE POLICY distance_references_update ON public.distance_references
  FOR UPDATE TO authenticated
  USING (
    can_access_section('distances') AND can_access_country(country)
  )
  WITH CHECK (
    can_access_section('distances') AND can_access_country(country)
  );

DROP POLICY IF EXISTS distance_references_delete ON public.distance_references;
CREATE POLICY distance_references_delete ON public.distance_references
  FOR DELETE TO authenticated
  USING (
    can_access_section('distances') AND can_access_country(country)
  );
