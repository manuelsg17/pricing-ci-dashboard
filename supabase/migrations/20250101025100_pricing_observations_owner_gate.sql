-- ════════════════════════════════════════════════════════════════════════
-- 170_pricing_observations_owner_gate.sql — cierra el hallazgo pendiente
-- de la auditoría de seguridad 2026-07-26: RawData.jsx permitía a
-- cualquier hub con acceso a un país editar/borrar filas MANUALES
-- cargadas por OTRO hub del mismo país (la RLS de UPDATE/DELETE solo
-- filtraba por can_access_country, no por dueño).
--
-- Diseño (datos reales verificados antes de escribir esto):
-- - Filas bot (1.448.466, uploaded_by siempre NULL): sin dueño real, se
--   mantienen editables por cualquiera con acceso al país — mismo
--   comportamiento de hoy, lo necesita el flujo de "Sync InDrive"/
--   corrección de precios del bot.
-- - Filas manuales LEGACY sin uploaded_by (150.260, de antes de mig 139):
--   no se les puede asignar dueño retroactivo — se mantienen editables
--   por cualquiera con acceso al país, igual que hoy (no empeora nada).
-- - Filas manuales CON dueño (6.662, las que sí tienen uploaded_by desde
--   mig 139): ahora SOLO las edita/borra su propio uploaded_by, o un admin.
--
-- Admin (is_admin()) bypassa siempre — el panel de administración necesita
-- poder corregir cualquier fila de cualquier hub.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

DROP POLICY IF EXISTS pricing_observations_update ON public.pricing_observations;
CREATE POLICY pricing_observations_update ON public.pricing_observations
  FOR UPDATE TO authenticated
  USING (
    can_access_country(country)
    AND (is_admin() OR uploaded_by IS NULL OR uploaded_by = (SELECT auth.email()))
  )
  WITH CHECK (
    can_access_country(country)
    AND (is_admin() OR uploaded_by IS NULL OR uploaded_by = (SELECT auth.email()))
  );

DROP POLICY IF EXISTS pricing_observations_delete ON public.pricing_observations;
CREATE POLICY pricing_observations_delete ON public.pricing_observations
  FOR DELETE TO authenticated
  USING (
    can_access_country(country)
    AND (is_admin() OR uploaded_by IS NULL OR uploaded_by = (SELECT auth.email()))
  );

COMMIT;
