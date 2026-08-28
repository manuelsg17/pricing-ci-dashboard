-- ════════════════════════════════════════════════════════════════════════
-- Migración 223 — Excluir InDrive Bogotá/Cali de v_effective_price (moneda rota)
--
-- CONTEXTO (2026-08-29): al revisar un hallazgo lateral (v_yango_rival_diff_mv
-- con un pct_diff absurdo en Cali), se encontró que TODAS las observaciones
-- de InDrive en Bogotá y Cali están en una escala de precio distinta al
-- resto de competidores de esas mismas ciudades:
--   Bogotá: InDrive avg=12.73  vs Yango=17.824 / Uber=28.155 / Didi=21.316
--   Cali:   InDrive avg=16.25  vs Yango=17.280 / Uber=29.234
-- Yango/Uber/Didi están en pesos colombianos (miles). InDrive está en una
-- escala ~1000x menor — no es un outlier, es sistemático:
--   Bogotá: 142/142 filas rotas (100%)
--   Cali:    40/40  filas rotas (100%)
-- Barranquilla NO tiene el problema (InDrive ahí sí está en escala COP
-- correcta) — la exclusión es puntual a Bogotá+Cali, no a todo InDrive-CO.
--
-- CAUSA RAÍZ: NO CONFIRMADA. No hay ninguna lógica de conversión de moneda
-- en scripts/bot-sync/bot_sync_push.py (el pipeline real) — el precio que
-- manda la fuente pasa sin tocar. El bug está upstream (bot_quotes_remote /
-- el simulador), pero el conector FDW a esa base (fudobi.helioho.st) no
-- respondió durante la investigación — no se pudo confirmar si la fuente
-- reporta en USD, si es un problema de escala (÷1000), o algo específico
-- de la integración de InDrive en esas 2 ciudades.
--
-- POR QUÉ SE EXCLUYE EN VEZ DE "CORREGIR" EL NÚMERO: sin confirmar la causa
-- exacta, aplicar un multiplicador (ej. tipo de cambio USD/COP) sería
-- inventar un dato, no corregirlo — el tipo de cambio varía día a día y no
-- hay certeza de que el problema sea siquiera de moneda. Mismo criterio que
-- el resto del proyecto: nunca fabricar números.
--
-- ALCANCE: ambas ciudades están además prácticamente MUERTAS — Bogotá no
-- recibe data de InDrive desde 2026-04-09 (un solo día, nunca más), Cali
-- desde 2026-07-27. Bajo impacto en volumen, pero corrompía cualquier
-- comparación Yango-vs-InDrive en esas 2 ciudades específicas mientras
-- estuvo sin filtrar.
--
-- ROLLBACK: CREATE OR REPLACE VIEW con esta cláusula removida (ver mig 221
-- para la versión anterior completa de la vista).
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE VIEW public.v_effective_price
WITH (security_invoker = true) AS
SELECT
  po.id,
  po.country,
  po.city,
  po.year,
  po.week,
  po.observed_date,
  po.observed_time,
  po.time_of_day,
  po.category,
  po.zone,
  po.competition_name,
  po.distance_km,
  po.distance_bracket,
  po.surge,
  po.rush_hour,
  po.timeslot,
  po.data_source,
  po.upload_batch_id,
  CASE
    WHEN po.competition_name = 'InDrive'::text
     AND (COALESCE(po.bid_1, 0::numeric) + COALESCE(po.bid_2, 0::numeric)
        + COALESCE(po.bid_3, 0::numeric) + COALESCE(po.bid_4, 0::numeric)
        + COALESCE(po.bid_5, 0::numeric)) > 0::numeric
    THEN (COALESCE(NULLIF(po.bid_1, 0::numeric), 0::numeric)
        + COALESCE(NULLIF(po.bid_2, 0::numeric), 0::numeric)
        + COALESCE(NULLIF(po.bid_3, 0::numeric), 0::numeric)
        + COALESCE(NULLIF(po.bid_4, 0::numeric), 0::numeric)
        + COALESCE(NULLIF(po.bid_5, 0::numeric), 0::numeric))
        / NULLIF(
            CASE WHEN COALESCE(po.bid_1, 0::numeric) > 0::numeric THEN 1 ELSE 0 END +
            CASE WHEN COALESCE(po.bid_2, 0::numeric) > 0::numeric THEN 1 ELSE 0 END +
            CASE WHEN COALESCE(po.bid_3, 0::numeric) > 0::numeric THEN 1 ELSE 0 END +
            CASE WHEN COALESCE(po.bid_4, 0::numeric) > 0::numeric THEN 1 ELSE 0 END +
            CASE WHEN COALESCE(po.bid_5, 0::numeric) > 0::numeric THEN 1 ELSE 0 END, 0)::numeric
    ELSE COALESCE(po.price_without_discount, po.recommended_price)
  END AS effective_price
FROM public.pricing_observations po
LEFT JOIN public.tuktuk_routes tr
       ON tr.point_a = po.point_a
      AND tr.point_b = po.point_b
WHERE (tr.point_a IS NULL OR po.category = 'TukTuk')
  -- ★ mig 223 — InDrive Bogotá/Cali: moneda/escala rota, 100% de las filas
  -- (142/142 y 40/40 verificado). Barranquilla queda afuera de este filtro
  -- a propósito, ahí InDrive está correcto.
  AND NOT (po.competition_name = 'InDrive' AND po.city IN ('Bogota', 'Cali'));

COMMENT ON VIEW public.v_effective_price IS
  'Precio efectivo por observación (InDrive: promedio de bids reales si hay; '
  'resto: price_without_discount). mig 219/221: excluye taxi sobre rutas '
  'TukTuk. mig 223: excluye InDrive Bogotá/Cali (moneda/escala rota, causa '
  'raíz no confirmada — fuente externa no disponible al momento del fix).';

COMMIT;
