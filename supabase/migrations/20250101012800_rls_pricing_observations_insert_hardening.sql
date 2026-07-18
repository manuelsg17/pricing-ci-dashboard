-- ════════════════════════════════════════════════════════════════════════
-- Migración 88 — RLS: cerrar INSERT abierto en pricing_observations
--                       y bot_raw_observations
--
-- CONTEXTO:
--   Auditoría de seguridad post-mig 66 detectó que el INSERT sobre
--   `pricing_observations` quedó intencionalmente abierto a cualquier
--   `authenticated` (mig 66:68-71) con la justificación "uploads del bot +
--   hub_experts". El UPDATE/DELETE ya está restringido a admin (can_edit()).
--
--   El problema:
--     Cualquier usuario con un JWT válido — incluso un viewer/analyst — puede
--     llamar PostgREST directo y hacer:
--       INSERT INTO pricing_observations (country, city, competition_name,
--                                          observed_date, price_without_discount,
--                                          ...) VALUES (...);
--     inyectando filas falsas que contaminan el histórico, los semáforos y
--     el cálculo de Yango vs competencia. No queda audit trail útil porque
--     `data_source` y `upload_batch_id` son set por el cliente.
--
--   Mismo problema en `bot_raw_observations`: mig 60 la dejó en el array
--   `protected_tables` (writes admin-only) PERO el flujo real es el bot via
--   service_role. Confirmamos que ningún componente del frontend escribe
--   en esa tabla (grep src/components/upload/ → 0 matches), así que
--   reforzar admin-only es solo un cinturón extra sobre el bypass.
--
-- QUÉ HACE:
--   A. pricing_observations:
--      - DROP `pricing_observations_insert` (la abierta de mig 66).
--      - CREATE nueva `pricing_observations_insert` con WITH CHECK (can_edit()).
--   B. bot_raw_observations:
--      - DROP cualquier policy de INSERT abierta sobreviviente.
--      - CREATE `bot_raw_observations_insert` con WITH CHECK (can_edit()).
--      - (mig 60 ya creó esta exacta policy, pero la recreamos idempotente
--         para asegurar el estado independientemente de qué se aplicó).
--
-- IMPACTO:
--   - Bot ingestion: NO se rompe. El bot usa SERVICE_ROLE_KEY (env
--     `SUPABASE_SERVICE_ROLE_KEY` en el worker Python), que bypassea RLS
--     automáticamente — las policies no se evalúan para service_role.
--   - Admin uploads (Upload.jsx + BotUpload.jsx): NO se rompe. `can_edit()`
--     devuelve true para role='admin'.
--   - Hub_expert uploads desde Upload.jsx (manual Excel/CSV): SE ROMPE.
--     `useAccessControl` les permite ver `/upload` pero el INSERT fallará
--     con "new row violates row-level security policy".
--     → ACCIÓN RECOMENDADA: si se quiere mantener uploads de hub_expert,
--       elevar a admin a esos usuarios, O extender `can_edit()` para
--       reconocer rol 'hub_expert', O remover 'upload' del role.permissions
--       de hub_expert (alinear UI con DB). El default seguro elegido acá
--       es admin-only.
--
-- DEFENSIVO:
--   - DROP POLICY IF EXISTS antes de CREATE → re-ejecutable sin error.
--   - Wrap en BEGIN/COMMIT → atómico.
--   - Skip si la tabla no existe (proyectos donde el bot aún no se montó).
--   - VERIFICACIÓN al final usando DO + RAISE NOTICE para detectar policies
--     residuales con `with_check = 'true'` sobre estas tablas.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── A. pricing_observations: INSERT admin-only ────────────────────────────
DO $pricing$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'pricing_observations'
  ) THEN
    RAISE NOTICE 'Mig 88: pricing_observations no existe, skipping';
  ELSE
    ALTER TABLE public.pricing_observations ENABLE ROW LEVEL SECURITY;

    -- Dropear la INSERT abierta de mig 66 + cualquier variante legacy
    DROP POLICY IF EXISTS pricing_observations_insert     ON public.pricing_observations;
    DROP POLICY IF EXISTS pricing_observations_all        ON public.pricing_observations;
    DROP POLICY IF EXISTS auth_all                         ON public.pricing_observations;
    DROP POLICY IF EXISTS authenticated_all                ON public.pricing_observations;
    DROP POLICY IF EXISTS allow_authenticated              ON public.pricing_observations;

    -- Recrear INSERT admin-only. SELECT, UPDATE y DELETE quedan como mig 66.
    CREATE POLICY pricing_observations_insert
      ON public.pricing_observations
      FOR INSERT TO authenticated
      WITH CHECK (can_edit());

    RAISE NOTICE 'Mig 88: pricing_observations INSERT restringido a can_edit()';
  END IF;
END
$pricing$;


-- ── B. bot_raw_observations: INSERT admin-only ────────────────────────────
-- Tabla escrita exclusivamente por el bot (service_role bypass). Cerramos
-- INSERT para `authenticated` por defensa en profundidad — ningún componente
-- del dashboard escribe acá (confirmed via grep src/).
DO $bot_raw$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'bot_raw_observations'
  ) THEN
    RAISE NOTICE 'Mig 88: bot_raw_observations no existe, skipping';
  ELSE
    ALTER TABLE public.bot_raw_observations ENABLE ROW LEVEL SECURITY;

    -- Dropear todas las variantes (mig 60 ya creó *_insert admin-only, pero
    -- en proyectos donde mig 60 no corrió quedó *_rw o *_all abierta).
    DROP POLICY IF EXISTS bot_raw_observations_insert     ON public.bot_raw_observations;
    DROP POLICY IF EXISTS bot_raw_observations_all        ON public.bot_raw_observations;
    DROP POLICY IF EXISTS bot_raw_observations_rw         ON public.bot_raw_observations;
    DROP POLICY IF EXISTS auth_all                         ON public.bot_raw_observations;
    DROP POLICY IF EXISTS authenticated_all                ON public.bot_raw_observations;
    DROP POLICY IF EXISTS allow_authenticated              ON public.bot_raw_observations;

    -- Recrear INSERT admin-only.
    CREATE POLICY bot_raw_observations_insert
      ON public.bot_raw_observations
      FOR INSERT TO authenticated
      WITH CHECK (can_edit());

    RAISE NOTICE 'Mig 88: bot_raw_observations INSERT restringido a can_edit()';
  END IF;
END
$bot_raw$;


-- ── C. Nota sobre service_role ───────────────────────────────────────────
-- El bot usa `SUPABASE_SERVICE_ROLE_KEY` (ver worker Python). PostgREST + RLS
-- bypassean automáticamente cuando el JWT corresponde a `service_role`:
--   https://supabase.com/docs/guides/auth/row-level-security#service-role
-- Por eso NO necesitamos una policy explícita para el bot — las restricciones
-- de arriba solo aplican a clientes con rol `authenticated` (anon key + JWT
-- de usuario). El cron del bot sigue funcionando sin cambios.


-- ── D. Verificación inline ───────────────────────────────────────────────
DO $verify$
DECLARE
  n_open int;
BEGIN
  SELECT COUNT(*) INTO n_open
  FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename IN ('pricing_observations', 'bot_raw_observations')
    AND cmd       = 'INSERT'
    AND with_check = 'true';

  IF n_open > 0 THEN
    RAISE WARNING 'Mig 88: % policies de INSERT con with_check=true sobreviven sobre las tablas blindadas. Inspeccionar pg_policies.', n_open;
  ELSE
    RAISE NOTICE 'Mig 88 OK: 0 policies de INSERT abiertas sobre pricing_observations / bot_raw_observations.';
  END IF;
END
$verify$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN MANUAL POST-APLICACIÓN
--
-- 1. Confirmar que las policies finales son las esperadas:
--    SELECT tablename, policyname, cmd, qual, with_check
--    FROM pg_policies
--    WHERE schemaname='public'
--      AND tablename IN ('pricing_observations','bot_raw_observations')
--    ORDER BY tablename, cmd;
--
--    Esperado para pricing_observations:
--      - SELECT  qual='true'        (abierto a authenticated)
--      - INSERT  with_check='can_edit()'
--      - UPDATE  qual='can_edit()' with_check='can_edit()'
--      - DELETE  qual='can_edit()'
--
--    Esperado para bot_raw_observations:
--      - SELECT  qual='true'
--      - INSERT  with_check='can_edit()'
--      - UPDATE  qual='can_edit()' with_check='can_edit()'
--      - DELETE  qual='can_edit()'
--
-- 2. Test como user NO admin (analyst/viewer):
--      INSERT INTO pricing_observations (country, city, competition_name,
--        observed_date, price_without_discount, data_source)
--      VALUES ('Peru','Lima','Yango','2026-05-23',10.00,'manual');
--      → debe fallar: "new row violates row-level security policy".
--
-- 3. Test como user admin (can_edit() = true):
--      mismo INSERT → debe funcionar.
--
-- 4. Test bot service_role (curl con SUPABASE_SERVICE_ROLE_KEY):
--      curl -X POST "$URL/rest/v1/pricing_observations" \
--           -H "apikey: $SERVICE_ROLE_KEY" \
--           -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
--           -H "Content-Type: application/json" \
--           -d '{...row...}'
--      → debe funcionar (bypass RLS).
--
-- 5. Smoke test del cron del bot (esperar próximo ciclo o forzar manual):
--      SELECT MAX(uploaded_at) FROM pricing_observations WHERE data_source='bot';
--      → timestamp debe avanzar después de aplicada la migración.
-- ════════════════════════════════════════════════════════════════════════
