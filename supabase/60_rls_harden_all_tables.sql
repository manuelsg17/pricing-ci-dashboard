-- ════════════════════════════════════════════════════════════════════════
-- Migración 60 — RLS hardening masivo
--
-- CONTEXTO:
--   Migración 59 ya blindó user_profiles + roles. Esta migración extiende
--   la misma idea (SELECT open, escritura solo admin) a las 21+ tablas
--   restantes que tenían policies abiertas `FOR ALL TO authenticated`.
--
-- DISEÑO:
--   - Helper `can_edit()` que reutiliza is_admin() pero deja la puerta
--     abierta para roles futuros (ej: can_edit_country(p_country)).
--     KISS — hoy es alias de is_admin(); si mañana aparece un rol
--     analyst-Peru, agregamos lógica acá sin tocar 60 policies.
--   - Cada tabla recibe 4 policies: select_open, insert_admin,
--     update_admin, delete_admin (granular por verbo, no FOR ALL).
--   - Idempotente: DROP IF EXISTS antes de cada CREATE.
--
-- EXCEPCIONES INTENCIONALES:
--   - user_filter_presets: cualquier user puede CRUD sus propios presets
--     (filtrados por created_by = auth.email()). Lo dejamos abierto a
--     authenticated porque es state del usuario, no config compartida.
--   - pricing_observations: writes vía batch upload pueden ser hechos
--     por roles non-admin (hub_expert ingresa CI). Lo dejamos como
--     `authenticated`. El gating real está en el flujo de upload.
--   - bot_sync_log / bot_sync_watermark: writes vienen del bot (service
--     role bypass) y de admin manual. Restringimos writes a admin.
--
-- VERIFICACIÓN POST-APLICACIÓN:
--   Login como user non-admin → intentar UPDATE bracket_weights →
--   debe fallar con `new row violates row-level security policy`.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── A. Helper can_edit() — extensible para roles geográficos futuros ──
--
-- HOY: idéntico a is_admin().
-- MAÑANA: cuando aparezca un rol como "analyst Bolivia", agregar:
--   SELECT is_admin() OR EXISTS (
--     SELECT 1 FROM user_profiles up JOIN roles r ON r.id = up.role_id
--     WHERE up.email = auth.email()
--       AND (r.permissions->'countries' ? p_country
--            OR r.permissions->'countries' ? 'all')
--       AND r.name <> 'viewer'
--   );
-- Pero NO predefinir nada hipotético — KISS hasta que el rol exista.

CREATE OR REPLACE FUNCTION can_edit()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT is_admin();
$$;

GRANT EXECUTE ON FUNCTION can_edit() TO authenticated;

COMMENT ON FUNCTION can_edit() IS
  'Wrapper extensible de is_admin(). Hoy = is_admin(). Cuando aparezcan roles geográficos, agregar lógica acá en lugar de tocar 60 policies.';


-- ── B. Macro: aplica RLS estándar a una tabla ──────────────────────────
--
-- DO block reutilizable que:
--   1. Dropea policies abiertas viejas (patrones conocidos)
--   2. Crea select_open + insert/update/delete_admin
--
-- Aplicado a cada tabla abajo con su nombre. No es función porque PG no
-- permite parametrizar nombres de tabla en CREATE POLICY sin EXECUTE.

DO $migration$
DECLARE
  t text;
  -- Lista de tablas con escritura admin-only.
  -- ORDEN: las más críticas primero (config), luego operacionales.
  protected_tables text[] := ARRAY[
    -- Configuración pricing (cambios afectan cálculos)
    'distance_thresholds',
    'bracket_weights',
    'bracket_weights_by_category',
    'semaforo_config',
    'price_validation_rules',
    'rush_hour_windows',
    'distance_references',
    'indrive_config',
    'ci_timeslots',
    -- Multi-tenancy
    'country_config',
    'catalog_extras',
    'bot_rules',
    -- Eventos / catálogos
    'market_events',
    'competitor_commissions',
    'competitor_bonuses',
    -- Pipeline observabilidad
    'bot_sync_log',
    'bot_sync_watermark',
    'bot_raw_observations',
    'bot_outliers',
    -- Snapshots históricos
    'pricing_wa_frozen',
    'upload_batches'
  ];
  old_policies text[] := ARRAY[
    'auth_read_write',
    'auth_all',
    'authenticated_all',
    'allow_authenticated',
    'public_all',
    'auth_all_indrive_config',
    'catalog_extras_rw',
    'bot_rules_rw',
    'bot_sync_log_rw',
    'bot_sync_watermark_rw'
  ];
  pol text;
BEGIN
  FOREACH t IN ARRAY protected_tables LOOP
    -- Skip si la tabla no existe (defensivo: algunas migraciones quizás
    -- no se aplicaron en este proyecto)
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = t
    ) THEN
      RAISE NOTICE 'Tabla % no existe, skipping', t;
      CONTINUE;
    END IF;

    -- Asegurar RLS habilitado
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

    -- Drop policies abiertas viejas
    FOREACH pol IN ARRAY old_policies LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol, t);
    END LOOP;
    -- Drop también las que vamos a recrear (idempotencia)
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_insert', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_update', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_delete', t);

    -- SELECT abierto (todos los authenticated leen)
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (true)',
      t || '_select', t
    );
    -- INSERT/UPDATE/DELETE solo si can_edit()
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (can_edit())',
      t || '_insert', t
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (can_edit()) WITH CHECK (can_edit())',
      t || '_update', t
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (can_edit())',
      t || '_delete', t
    );

    RAISE NOTICE 'RLS hardened: %', t;
  END LOOP;
END
$migration$;


-- ── C. Excepciones: tablas con RLS distinta ────────────────────────────

-- C.1 user_filter_presets — cada usuario CRUD sólo sus presets
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'user_filter_presets'
  ) THEN
    ALTER TABLE public.user_filter_presets ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS auth_read_write           ON public.user_filter_presets;
    DROP POLICY IF EXISTS user_filter_presets_select ON public.user_filter_presets;
    DROP POLICY IF EXISTS user_filter_presets_insert ON public.user_filter_presets;
    DROP POLICY IF EXISTS user_filter_presets_update ON public.user_filter_presets;
    DROP POLICY IF EXISTS user_filter_presets_delete ON public.user_filter_presets;

    -- SELECT: ven todos los presets (UI espera ver presets compartidos)
    CREATE POLICY user_filter_presets_select ON public.user_filter_presets
      FOR SELECT TO authenticated USING (true);
    -- INSERT: solo si created_by = mi email
    CREATE POLICY user_filter_presets_insert ON public.user_filter_presets
      FOR INSERT TO authenticated
      WITH CHECK (created_by = auth.email() OR can_edit());
    -- UPDATE/DELETE: dueño o admin
    CREATE POLICY user_filter_presets_update ON public.user_filter_presets
      FOR UPDATE TO authenticated
      USING (created_by = auth.email() OR can_edit())
      WITH CHECK (created_by = auth.email() OR can_edit());
    CREATE POLICY user_filter_presets_delete ON public.user_filter_presets
      FOR DELETE TO authenticated
      USING (created_by = auth.email() OR can_edit());
  END IF;
END
$$;

-- C.2 ci_sessions — hub_experts ingresan CI, no admin-only.
-- Mantenemos write abierto a authenticated. Si en el futuro hay abuso,
-- agregar AND created_by = auth.email() OR can_edit().
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'ci_sessions'
  ) THEN
    ALTER TABLE public.ci_sessions ENABLE ROW LEVEL SECURITY;
    -- Mantener policy abierta existente, NO la sobreescribimos.
    -- Solo nos aseguramos de que exista una policy de SELECT.
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'ci_sessions'
    ) THEN
      CREATE POLICY ci_sessions_select ON public.ci_sessions
        FOR SELECT TO authenticated USING (true);
      CREATE POLICY ci_sessions_write ON public.ci_sessions
        FOR ALL TO authenticated USING (true) WITH CHECK (true);
    END IF;
  END IF;
END
$$;

-- C.3 earnings_scenarios — análisis personal, mantener abierto.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'earnings_scenarios'
  ) THEN
    ALTER TABLE public.earnings_scenarios ENABLE ROW LEVEL SECURITY;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'earnings_scenarios'
    ) THEN
      CREATE POLICY earnings_scenarios_all ON public.earnings_scenarios
        FOR ALL TO authenticated USING (true) WITH CHECK (true);
    END IF;
  END IF;
END
$$;

-- C.4 pricing_observations — writes vienen de uploads (hub_expert puede)
-- + service role del bot. Mantener escritura a authenticated.
-- Si abusan, restringir a `created_by = auth.email() OR can_edit()`.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'pricing_observations'
  ) THEN
    ALTER TABLE public.pricing_observations ENABLE ROW LEVEL SECURITY;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'pricing_observations'
    ) THEN
      CREATE POLICY pricing_observations_all ON public.pricing_observations
        FOR ALL TO authenticated USING (true) WITH CHECK (true);
    END IF;
  END IF;
END
$$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN POST-APLICACIÓN
--
-- 1. Listar policies aplicadas:
--    SELECT tablename, policyname, cmd
--    FROM pg_policies WHERE schemaname = 'public'
--    ORDER BY tablename, cmd;
--
-- 2. Test como user NO admin:
--    -- Crear un user 'viewer@test.com' con role='analyst'
--    -- Loggearse con ese user en el dashboard
--    -- Intentar UPDATE bracket_weights SET weight = 0.5 WHERE id = 1
--    -- Debe fallar con: "new row violates row-level security policy"
--
-- 3. Test como admin: todo debe seguir funcionando normal.
-- ════════════════════════════════════════════════════════════════════════
