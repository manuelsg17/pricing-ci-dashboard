-- ════════════════════════════════════════════════════════════════════════
-- Migración 59 — RLS: cerrar auto-escalación de privilegios
--
-- VULNERABILIDAD CRÍTICA:
--   `user_profiles` y `roles` tienen policies `FOR ALL TO authenticated
--   USING (true) WITH CHECK (true)`. Cualquier usuario logueado puede:
--     UPDATE user_profiles SET role_id = (SELECT id FROM roles WHERE name='admin') WHERE user_id = auth.uid()
--   y se vuelve admin instantáneamente.
--
--   El RBAC en src/hooks/useAccessControl.js solo es client-side — no
--   tiene enforcement en la DB.
--
-- FIX:
--   - Helper is_admin() SECURITY DEFINER que mira role del caller.
--   - SELECT abierto a authenticated (necesitan leer su propio role).
--   - INSERT/UPDATE/DELETE en user_profiles + roles solo a admins.
--
-- Nota: SECURITY DEFINER con search_path explícito (hijacking-safe).
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── A. Helper is_admin() ──────────────────────────────────────────────
-- Devuelve true si el caller (auth.uid()) tiene rol 'admin'.
-- SECURITY DEFINER → corre con privilegios del owner (postgres) y puede
-- leer user_profiles aunque el caller no tenga policy de SELECT directa.

CREATE OR REPLACE FUNCTION is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM user_profiles up
    JOIN roles r ON r.id = up.role_id
    WHERE up.user_id = auth.uid()
      AND r.name = 'admin'
  );
$$;

GRANT EXECUTE ON FUNCTION is_admin() TO authenticated;

COMMENT ON FUNCTION is_admin() IS
  'Devuelve true si el caller tiene rol admin. Usado por RLS policies.';


-- ── B. user_profiles: SELECT abierto, escritura solo admin ────────────

-- Drop policies abiertas
DROP POLICY IF EXISTS user_profiles_all          ON user_profiles;
DROP POLICY IF EXISTS user_profiles_authenticated ON user_profiles;
DROP POLICY IF EXISTS "Allow authenticated read"  ON user_profiles;

-- SELECT: cualquier authenticated puede leer (necesario para useAccessControl)
DROP POLICY IF EXISTS user_profiles_select ON user_profiles;
CREATE POLICY user_profiles_select ON user_profiles
  FOR SELECT TO authenticated USING (true);

-- INSERT/UPDATE/DELETE: solo admin
DROP POLICY IF EXISTS user_profiles_insert ON user_profiles;
CREATE POLICY user_profiles_insert ON user_profiles
  FOR INSERT TO authenticated WITH CHECK (is_admin());

DROP POLICY IF EXISTS user_profiles_update ON user_profiles;
CREATE POLICY user_profiles_update ON user_profiles
  FOR UPDATE TO authenticated USING (is_admin()) WITH CHECK (is_admin());

DROP POLICY IF EXISTS user_profiles_delete ON user_profiles;
CREATE POLICY user_profiles_delete ON user_profiles
  FOR DELETE TO authenticated USING (is_admin());


-- ── C. roles: idem ────────────────────────────────────────────────────

DROP POLICY IF EXISTS roles_all          ON roles;
DROP POLICY IF EXISTS roles_authenticated ON roles;

DROP POLICY IF EXISTS roles_select ON roles;
CREATE POLICY roles_select ON roles
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS roles_insert ON roles;
CREATE POLICY roles_insert ON roles
  FOR INSERT TO authenticated WITH CHECK (is_admin());

DROP POLICY IF EXISTS roles_update ON roles;
CREATE POLICY roles_update ON roles
  FOR UPDATE TO authenticated USING (is_admin()) WITH CHECK (is_admin());

DROP POLICY IF EXISTS roles_delete ON roles;
CREATE POLICY roles_delete ON roles
  FOR DELETE TO authenticated USING (is_admin());

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- POST-APLICACIÓN: probar con un usuario non-admin:
--
--   UPDATE user_profiles SET role_id = X WHERE user_id = auth.uid();
--   -- Debería fallar con "new row violates row-level security policy"
--
--   SELECT * FROM user_profiles;
--   -- Debería funcionar (SELECT sigue abierto)
-- ════════════════════════════════════════════════════════════════════════
