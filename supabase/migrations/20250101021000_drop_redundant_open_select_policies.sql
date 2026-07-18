-- ════════════════════════════════════════════════════════════════════════
-- Migración 130 — Fase 1.1: cerrar drift de RLS por policies duplicadas
--
-- CONTEXTO: la auditoría de arquitectura (previa a este plan) encontró que
-- entre mig 60 y 66, country_config tuvo una policy de escritura abierta
-- (`USING (true)`) corriendo EN PARALELO con la restrictiva correcta —
-- como RLS combina policies permisivas con OR, la abierta ganaba en
-- silencio. Se construyó un chequeo genérico para encontrar este mismo
-- patrón en cualquier tabla (2+ policies para la misma tabla+comando):
--
--   SELECT tablename, cmd, count(*), array_agg(policyname)
--   FROM pg_policies WHERE schemaname='public'
--   GROUP BY tablename, cmd HAVING count(*) > 1;
--
-- Corriéndolo hoy encontró 3 casos reales, todos el mismo patrón: una
-- policy vieja genérica "Authenticated read X" (qual=true, sin scope de
-- país) conviviendo con una policy nueva y correcta "X_select":
--
--   - bot_rules: "Authenticated read bot_rules" (true) + bot_rules_select
--     (can_access_country(country)) → la vieja neutraliza el scope de
--     país de la nueva. CUALQUIER usuario autenticado puede leer HOY las
--     bot_rules de CUALQUIER país, no solo los suyos. Es el mismo drift
--     que causó el incidente de mig 60-66, solo que en SELECT no en
--     escritura — y sigue vivo hasta esta migración.
--   - bot_sync_log / bot_sync_watermark: ambas policies con qual=true —
--     sin gap de seguridad real (ninguna las restringía por país en
--     primer lugar), pero duplicación pura a limpiar.
--
-- No afecta al Edge Function de sync (usa service_role, que ignora RLS
-- por completo) ni a ningún otro flujo — verificado.
-- ════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "Authenticated read bot_rules" ON public.bot_rules;
DROP POLICY IF EXISTS "Authenticated read log" ON public.bot_sync_log;
DROP POLICY IF EXISTS "Authenticated read watermark" ON public.bot_sync_watermark;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN:
--   SELECT tablename, cmd, count(*) FROM pg_policies WHERE schemaname='public'
--   GROUP BY tablename, cmd HAVING count(*) > 1;
--   → debe devolver 0 filas.
-- ════════════════════════════════════════════════════════════════════════
