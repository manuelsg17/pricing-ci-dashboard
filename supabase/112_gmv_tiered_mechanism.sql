-- ============================================================
-- 112 — competitor_bonuses: mecanismo gmv_tiered (% GMV de Yango)
-- ============================================================
-- CONTEXTO
--   Yango ofrece a sus drivers un bono "% GMV con metas": el driver elige
--   una meta de N viajes y, si la cumple, le devuelven un % del GMV BRUTO
--   (antes de comisión) de los primeros N viajes — aunque haga más. Cada
--   meta (peldaño) tiene su propio % y su propio tope en S/. La escalera
--   es distinta por ciudad (Lima / Trujillo / Arequipa) → una tarjeta por
--   ciudad usando la columna city existente.
--
-- APPROACH
--   Sin columnas nuevas: se reusa tiers jsonb con shape
--   [{threshold: N viajes, pct: % GMV, cap: tope S/}] (vs {threshold,
--   reward} de la escalera clásica). Solo se extiende el CHECK de
--   mechanism. El motor (src/lib/competitorBonus.js → gmvTieredReward)
--   calcula: min(cap, pct% × fare × N) del peldaño que más paga entre
--   los alcanzados.
--
-- VERIFICACIÓN
--   insert con mechanism='gmv_tiered' pasa el CHECK; el editor de bonos
--   (Config → Competitors → Bonuses) muestra el mecanismo "% GMV".
-- ============================================================

ALTER TABLE public.competitor_bonuses
  DROP CONSTRAINT IF EXISTS competitor_bonuses_mechanism_chk;
ALTER TABLE public.competitor_bonuses
  ADD CONSTRAINT competitor_bonuses_mechanism_chk
  CHECK (mechanism IN ('flat','tiered','guarantee','comm_discount',
                       'comm_credit','streak','surge','gmv_tiered'));
