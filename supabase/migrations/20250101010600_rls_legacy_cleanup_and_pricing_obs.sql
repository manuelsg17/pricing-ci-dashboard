-- ════════════════════════════════════════════════════════════════════════
-- Migración 66 — RLS legacy cleanup + pricing_observations admin-only writes
--
-- POR QUÉ:
--   La auditoría de seguridad detectó 3 goteras en mig 60:
--
--   1. country_config: la policy `allow_write_country_config` de
--      create_country_config_table.sql NO está en el array `old_policies`
--      de mig 60:106-117 → queda activa en paralelo a las nuevas
--      `country_config_*` (RLS resuelve con OR → la abierta gana).
--      Cualquier authenticated user puede modificar cualquier país.
--
--   2. user_profiles y roles: las policies `auth_all_profiles` (mig 18:45)
--      y `auth_all_roles` (mig 18:37) tampoco están en el array. Mig 59
--      droppea otras variantes pero NO estas dos → mismo problema.
--
--   3. pricing_observations: mig 60:253-269 mantuvo `FOR ALL USING(true)`
--      con un comentario "el gating real está en el flujo de upload",
--      pero un cliente puede ir directo a PostgREST y hacer
--      `DELETE FROM pricing_observations` masivo. Corrompe el histórico.
--
-- QUE HACE ESTA MIGRACIÓN:
--   A. DROP explícito de las 3 policies legacy abiertas.
--   B. DELETE/UPDATE de pricing_observations restringido a can_edit() (admin).
--      INSERT queda abierto a authenticated (uploads del bot + hub_experts).
--   C. Verificación: cuenta cuántas policies abiertas (USING true) quedan
--      sobre estas tablas y RAISE NOTICE.
--
-- IDEMPOTENCIA: todos los DROP usan IF EXISTS. Re-ejecutable sin error.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── A. DROP policies legacy huérfanas ─────────────────────────────────────
-- country_config: la abierta original
DROP POLICY IF EXISTS allow_read_country_config  ON public.country_config;
DROP POLICY IF EXISTS allow_write_country_config ON public.country_config;

-- user_profiles + roles: las de mig 18 que mig 59 no dropeó
DROP POLICY IF EXISTS auth_all_profiles ON public.user_profiles;
DROP POLICY IF EXISTS auth_all_roles    ON public.roles;

-- Defensive: por si alguna versión paralela también existe
DROP POLICY IF EXISTS user_profiles_all          ON public.user_profiles;
DROP POLICY IF EXISTS user_profiles_authenticated ON public.user_profiles;
DROP POLICY IF EXISTS "Allow authenticated read" ON public.user_profiles;

-- ── B. pricing_observations: write admin-only, lectura abierta ─────────────
-- Estrategia: dropear la policy `pricing_observations_all` (FOR ALL USING
-- true) creada en mig 60:264, y recrear como 3 policies separadas:
--   - SELECT abierto (todos leen)
--   - INSERT abierto (el bot + hub_experts hacen uploads)
--   - UPDATE/DELETE solo admin (evita borrar histórico desde el cliente)

DROP POLICY IF EXISTS pricing_observations_all    ON public.pricing_observations;
DROP POLICY IF EXISTS pricing_observations_select ON public.pricing_observations;
DROP POLICY IF EXISTS pricing_observations_insert ON public.pricing_observations;
DROP POLICY IF EXISTS pricing_observations_update ON public.pricing_observations;
DROP POLICY IF EXISTS pricing_observations_delete ON public.pricing_observations;

CREATE POLICY pricing_observations_select
  ON public.pricing_observations
  FOR SELECT TO authenticated
  USING (true);

-- INSERT: cualquier authenticated puede subir filas (upload manual del
-- hub_expert + bot via service_role bypass de todos modos las policies).
CREATE POLICY pricing_observations_insert
  ON public.pricing_observations
  FOR INSERT TO authenticated
  WITH CHECK (true);

-- UPDATE/DELETE: solo admin. Para corregir filas erróneas, el admin puede;
-- el resto debe re-subir un upload o crear un snapshot manual.
CREATE POLICY pricing_observations_update
  ON public.pricing_observations
  FOR UPDATE TO authenticated
  USING (can_edit())
  WITH CHECK (can_edit());

CREATE POLICY pricing_observations_delete
  ON public.pricing_observations
  FOR DELETE TO authenticated
  USING (can_edit());

COMMIT;

-- ── C. Verificación ──────────────────────────────────────────────────────
-- Cuenta policies "abiertas" (USING true para FOR ALL) sobre las 3 tablas.
-- Esperamos 0 — si sale > 0, algo se nos pasó.
DO $verify$
DECLARE
  n_open int;
BEGIN
  SELECT COUNT(*) INTO n_open
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN ('country_config', 'user_profiles', 'roles', 'pricing_observations')
    AND cmd = 'ALL'
    AND qual = 'true'
    AND with_check = 'true';

  IF n_open > 0 THEN
    RAISE WARNING 'Mig 66: %  policies abiertas (FOR ALL USING true) sobreviven. Inspeccionar pg_policies.', n_open;
  ELSE
    RAISE NOTICE 'Mig 66 OK: 0 policies legacy abiertas sobre tablas críticas.';
  END IF;
END
$verify$;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN MANUAL POST-APLICACIÓN
--
-- 1. Listar policies sobre las tablas críticas:
--    SELECT tablename, policyname, cmd, qual, with_check
--    FROM pg_policies
--    WHERE schemaname='public'
--      AND tablename IN ('country_config','user_profiles','roles','pricing_observations')
--    ORDER BY tablename, cmd;
--
--    Esperado:
--      - country_config: 4 policies (select/insert/update/delete) — ninguna
--        con qual='true' para INSERT/UPDATE/DELETE.
--      - user_profiles: 4 policies de mig 59 (admin-only writes).
--      - roles:         4 policies similares.
--      - pricing_observations: 4 policies — solo SELECT e INSERT con qual='true'.
--
-- 2. Test como user NO admin (analyst):
--      UPDATE country_config SET label='X' WHERE country_key='Peru';
--    → debe fallar con: "new row violates row-level security policy".
--
--      DELETE FROM pricing_observations WHERE id = 1;
--    → debe fallar con: "new row violates row-level security policy".
--
--      INSERT INTO pricing_observations (country, city, ...) VALUES (...);
--    → debe seguir funcionando (uploads no se rompen).
-- ════════════════════════════════════════════════════════════════════════
