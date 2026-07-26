-- ════════════════════════════════════════════════════════════════════════
-- 167_country_gate_bonuses_notes_botlog.sql — cierre de los hallazgos
-- medios/bajos de la auditoría de seguridad 2026-07-26 (mig 166 cerró los
-- críticos/altos). Mismo patrón de drift ya visto en mig 165: tablas con
-- columna `country` pero SELECT en `USING(true)`, mientras sus tablas
-- hermanas sí filtran por país.
--
-- A) competitor_bonuses / yango_gmv_tiers: SELECT sin filtro de país —
--    cualquier hub logueado veía bonos/tiers de TODOS los países. Se
--    alinean con competitor_commissions (ya corregida en mig 165).
--
-- B) bot_sync_log / bot_sync_watermark: mismo patrón, severidad menor
--    (contenido operativo del pipeline, no de negocio) pero mismo fix.
--
-- C) user_profiles: SELECT sin ninguna restricción exponía email/nombre/
--    rol/`notes` de los 23 usuarios del sistema a CUALQUIER hub logueado
--    (no solo el propio perfil). `notes` en particular es texto libre que
--    podría contener comentarios internos. Fix: cada usuario puede seguir
--    viendo su PROPIO perfil (lo necesita `useAccessControl.js`, que
--    corre para cualquier rol al loguearse) + admin ve todos (lo necesita
--    `AccessManagement.jsx`, panel de gestión de cuentas) — nadie más ve
--    perfiles ajenos.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

DROP POLICY IF EXISTS competitor_bonuses_select ON public.competitor_bonuses;
CREATE POLICY competitor_bonuses_select ON public.competitor_bonuses
  FOR SELECT TO authenticated
  USING (can_access_country(country));

DROP POLICY IF EXISTS yango_gmv_tiers_select ON public.yango_gmv_tiers;
CREATE POLICY yango_gmv_tiers_select ON public.yango_gmv_tiers
  FOR SELECT TO authenticated
  USING (can_access_country(country));

DROP POLICY IF EXISTS bot_sync_log_select ON public.bot_sync_log;
CREATE POLICY bot_sync_log_select ON public.bot_sync_log
  FOR SELECT TO authenticated
  USING (can_access_country(country));

DROP POLICY IF EXISTS bot_sync_watermark_select ON public.bot_sync_watermark;
CREATE POLICY bot_sync_watermark_select ON public.bot_sync_watermark
  FOR SELECT TO authenticated
  USING (can_access_country(country));

DROP POLICY IF EXISTS user_profiles_select ON public.user_profiles;
CREATE POLICY user_profiles_select ON public.user_profiles
  FOR SELECT TO authenticated
  USING (is_admin() OR email = (SELECT auth.email()));

COMMIT;
