-- ════════════════════════════════════════════════════════════════════════
-- 165_country_gate_wa_frozen_events_commissions.sql — cierra la misma fuga
-- cross-país de la mig 164, en 3 tablas que quedaron afuera de esa barrida.
--
-- Contexto (2026-07-24, auditoría de seguimiento pedida por el user tras
-- la mig 164): `pricing_wa_frozen` (precios promedio ponderados congelados
-- por ciudad/categoría/competidor), `market_events` (notas de eventos de
-- mercado) y `competitor_commissions` (comisiones de competidores) tenían
-- su política SELECT en `USING (true)` — cualquier usuario autenticado
-- podía leer estos datos de CUALQUIER país, no solo el suyo.
--
-- Bug MENOS grave que el de la mig 164: son datos derivados/agregados, no
-- las cotizaciones crudas de `pricing_observations`, y las políticas de
-- escritura (INSERT/UPDATE/DELETE) YA estaban correctamente gateadas por
-- `can_edit()` (solo admin) — no hay riesgo de romper el camino de
-- escritura de ningún hub_expert, así que esta migración es de bajo
-- riesgo: solo reemplaza el SELECT.
--
-- Se revisó el resto de tablas con política SELECT en `true`
-- (catalog_extras, distance_references, upload_batches, ci_timeslots,
-- bot_sync_log, bot_sync_watermark, yango_gmv_tiers, roles, user_profiles)
-- y son catálogos/config compartidos legítimamente entre países (sin
-- columna `country` sensible, o son metadatos operativos no
-- competitivos) — no requieren cambio.
-- ════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS pricing_wa_frozen_select ON public.pricing_wa_frozen;
CREATE POLICY pricing_wa_frozen_select ON public.pricing_wa_frozen
  FOR SELECT TO authenticated
  USING (can_access_country(country));

DROP POLICY IF EXISTS market_events_select ON public.market_events;
CREATE POLICY market_events_select ON public.market_events
  FOR SELECT TO authenticated
  USING (can_access_country(country));

DROP POLICY IF EXISTS competitor_commissions_select ON public.competitor_commissions;
CREATE POLICY competitor_commissions_select ON public.competitor_commissions
  FOR SELECT TO authenticated
  USING (can_access_country(country));
