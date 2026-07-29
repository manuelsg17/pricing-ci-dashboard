-- ════════════════════════════════════════════════════════════════════════
-- 176_optimize_rls_pricing_observations_write.sql — continuación de mig 175:
-- mismo rediseño de rendimiento (calcular países permitidos UNA VEZ por
-- consulta en vez de por fila) aplicado ahora a INSERT/UPDATE/DELETE de
-- pricing_observations. La lógica de dueño (uploaded_by) de UPDATE/DELETE
-- se preserva EXACTA — mismo criterio: admin siempre puede, filas sin dueño
-- (legacy/bot) las puede tocar cualquiera con acceso al país, filas con
-- dueño solo las toca su hub.
--
-- Alcance: se evaluaron las otras ~20 tablas que usan can_access_country()
-- (ver auditoría 2026-07-29) — todas tienen ≤2.139 filas, el costo por fila
-- ahí es insignificante (milisegundos incluso sin optimizar). Solo
-- pricing_observations (particionada, 1.6M+ filas) se beneficia real de
-- este rediseño — no se tocan las demás para no sumar complejidad/riesgo
-- sin beneficio medible.
--
-- Validado en producción antes de este archivo (transacciones con ROLLBACK,
-- sin tocar datos reales):
--   - alexdokuchaev (analyst, NO dueño) intentando DELETE de una fila de
--     raisalopez → 0 filas afectadas (bloqueado correctamente).
--   - raisalopez (dueña) borrando una fila propia → 1 fila afectada
--     (permitido correctamente).
--   - check de duplicados de política: 1 policy por comando (SELECT/
--     INSERT/UPDATE/DELETE), sin drift.
--
-- Aplicado con confirmación explícita del user para esta tabla puntual.
-- ════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS pricing_observations_insert ON public.pricing_observations;
CREATE POLICY pricing_observations_insert ON public.pricing_observations
  FOR INSERT TO authenticated
  WITH CHECK (
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

DROP POLICY IF EXISTS pricing_observations_update ON public.pricing_observations;
CREATE POLICY pricing_observations_update ON public.pricing_observations
  FOR UPDATE TO authenticated
  USING (
    (
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
    )
    AND ( (select is_admin()) OR uploaded_by IS NULL OR uploaded_by = (select auth.email()) )
  )
  WITH CHECK (
    (
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
    )
    AND ( (select is_admin()) OR uploaded_by IS NULL OR uploaded_by = (select auth.email()) )
  );

DROP POLICY IF EXISTS pricing_observations_delete ON public.pricing_observations;
CREATE POLICY pricing_observations_delete ON public.pricing_observations
  FOR DELETE TO authenticated
  USING (
    (
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
    )
    AND ( (select is_admin()) OR uploaded_by IS NULL OR uploaded_by = (select auth.email()) )
  );
