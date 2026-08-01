-- ════════════════════════════════════════════════════════════════════════
-- 188_uniform_write_policies.sql — políticas de escritura uniformes.
--
-- Reemplaza `can_edit()` (= is_admin(), la foto de roles de hoy congelada en
-- SQL) por `can_write_table('<tabla>')` (mig 187), que resuelve contra
-- roles.permissions en vivo. A partir de acá, conceder o quitar una sección a
-- un rol NO requiere una migración.
--
-- EL RIESGO DE ESTE ARCHIVO, y por qué cada DROP está escrito explícito:
-- Postgres combina las políticas permisivas con OR. Si una política vieja
-- sobrevive junto a la nueva, la vieja GANA en silencio — sin error y sin log.
-- Es exactamente lo que causó las fugas de las migs 60-66, 130 y 164-165. Por
-- eso acá hay un DROP POLICY IF EXISTS por cada CREATE, y la verificación del
-- pie cuenta políticas por (tabla, comando).
--
-- PATRÓN APLICADO
--   con columna country : can_write_table('<t>') AND can_access_country(country)
--   country_config      : can_write_table('country_config') AND can_access_country(country_key)
--   ci_timeslots        : can_write_table('ci_timeslots')   -- global por diseño
--
-- `auth.email()` va envuelto en (select ...) DENTRO de can_write_table, así
-- que Postgres lo evalúa una sola vez por consulta (InitPlan), no por fila.
--
-- QUÉ NO SE TOCA, a propósito:
--   · pricing_observations — rendimiento. Las migs 175/176 la optimizaron para
--     resolver los países una vez por consulta (16,5s → 39-60ms sobre 1,6M+
--     filas). Meterla en el patrón genérico reintroduce el costo por fila.
--   · ci_sessions, ci_active_sessions, user_filter_presets — se gatean por
--     DUEÑO. El criterio correcto ahí es "es tuyo", no "qué sección tenés".
--   · user_profiles, roles — solo admin. Un rol no-admin que pudiera
--     escribirlas se concedería a sí mismo cualquier permiso: es escalación de
--     privilegios, no un permiso más. La sección `access` queda fuera del mapa
--     de la 187 a propósito, y la app marca esa pantalla como adminOnly para
--     no dejar el estado intermedio de "la ves pero no podés guardar".
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- Las 18 tablas con columna `country` siguen todas la misma forma, así que se
-- generan en bucle en vez de escribir 54 bloques a mano — menos superficie
-- para una errata, y el patrón queda evidente. Los nombres de política
-- respetan la convención ya existente: <tabla>_insert/_update/_delete.
DO $$
DECLARE
  t text;
  tablas_con_country text[] := ARRAY[
    'distance_references',
    'earnings_scenarios', 'competitor_commissions', 'competitor_bonuses',
    'market_events',
    'bot_sync_watermark', 'upload_batches',
    'distance_thresholds', 'bracket_weights', 'semaforo_config',
    'price_validation_rules', 'rush_hour_windows', 'yango_gmv_tiers',
    'indrive_config', 'competitive_bands', 'bot_rules', 'airport_markers',
    'catalog_extras'
  ];
BEGIN
  FOREACH t IN ARRAY tablas_con_country LOOP
    -- DROP explícito ANTES del CREATE. Nunca asumir que la nueva "gana".
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_insert', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_update', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_delete', t);

    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated '
      'WITH CHECK (can_write_table(%L) AND can_access_country(country))',
      t || '_insert', t, t);

    -- USING filtra las filas que ya existen; WITH CHECK valida el estado
    -- nuevo. Sin el WITH CHECK, un UPDATE podría mover una fila a un país al
    -- que el usuario no tiene acceso.
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated '
      'USING (can_write_table(%L) AND can_access_country(country)) '
      'WITH CHECK (can_write_table(%L) AND can_access_country(country))',
      t || '_update', t, t, t);

    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR DELETE TO authenticated '
      'USING (can_write_table(%L) AND can_access_country(country))',
      t || '_delete', t, t);
  END LOOP;
END $$;

-- ── country_config: la columna de país se llama country_key ───────────
DROP POLICY IF EXISTS country_config_insert ON public.country_config;
DROP POLICY IF EXISTS country_config_update ON public.country_config;
DROP POLICY IF EXISTS country_config_delete ON public.country_config;

CREATE POLICY country_config_insert ON public.country_config
  FOR INSERT TO authenticated
  WITH CHECK (can_write_table('country_config') AND can_access_country(country_key));
CREATE POLICY country_config_update ON public.country_config
  FOR UPDATE TO authenticated
  USING (can_write_table('country_config') AND can_access_country(country_key))
  WITH CHECK (can_write_table('country_config') AND can_access_country(country_key));
CREATE POLICY country_config_delete ON public.country_config
  FOR DELETE TO authenticated
  USING (can_write_table('country_config') AND can_access_country(country_key));

-- ── ci_timeslots: catálogo GLOBAL, sin columna de país ────────────────
-- Se documenta acá el motivo, como pide CLAUDE.md §3 para cualquier tabla sin
-- gating por país: los turnos de CI (Mañana/Tarde/Noche) son los mismos para
-- todos los países por diseño del producto.
DROP POLICY IF EXISTS ci_timeslots_insert ON public.ci_timeslots;
DROP POLICY IF EXISTS ci_timeslots_update ON public.ci_timeslots;
DROP POLICY IF EXISTS ci_timeslots_delete ON public.ci_timeslots;

CREATE POLICY ci_timeslots_insert ON public.ci_timeslots
  FOR INSERT TO authenticated WITH CHECK (can_write_table('ci_timeslots'));
CREATE POLICY ci_timeslots_update ON public.ci_timeslots
  FOR UPDATE TO authenticated
  USING (can_write_table('ci_timeslots')) WITH CHECK (can_write_table('ci_timeslots'));
CREATE POLICY ci_timeslots_delete ON public.ci_timeslots
  FOR DELETE TO authenticated USING (can_write_table('ci_timeslots'));

COMMIT;

-- ── VERIFICACIÓN ──────────────────────────────────────────────────────
-- 1) NINGUNA tabla con 2+ políticas para el mismo comando (la trampa del OR):
--      npm run check:rls-drift        → 0 filas
--
-- 2) Ya no queda can_edit() en las políticas de estas tablas:
--    SELECT tablename, cmd, policyname FROM pg_policies
--     WHERE schemaname='public' AND (qual LIKE '%can_edit%' OR with_check LIKE '%can_edit%');
--
-- 3) Las 20 tablas tienen exactamente 3 políticas de escritura cada una:
--    SELECT tablename, count(*) FROM pg_policies
--     WHERE schemaname='public' AND cmd <> 'SELECT'
--       AND tablename IN (...) GROUP BY tablename HAVING count(*) <> 3;   → 0 filas
--
-- 4) Simulación de genericidad (ejecutada en el cutover): crear un rol de
--    prueba, verificar que gana y pierde permisos SOLO editando
--    roles.permissions, y que el aislamiento por país se mantiene.
