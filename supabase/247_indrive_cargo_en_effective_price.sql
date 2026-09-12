-- ════════════════════════════════════════════════════════════════════════
-- Migración 247 — Subcategorías InDrive Cargo entran a la rama de bids en
--                 v_effective_price + filtros JS coordinados
--
-- POR QUÉ:
--   Auditoría del diccionario de "competidor" (2026-09-11): 4 lugares del
--   cliente comparan `competition_name === 'InDrive'` literal en vez de
--   usar isInDriveVariant() (src/lib/constants.js), que ya existe
--   precisamente para tratar igual a 'InDrive' y a sus 4 subcategorías de
--   Cargo (InDriveCargoPickup/Van/Liviano/Grande, agregadas 2026-09-07).
--   La vista `v_effective_price` tiene el mismo problema: solo promedia
--   bids para `competition_name = 'InDrive'` exacto.
--
--   src/algorithms/indrive.js ya documentaba esto como "PENDIENTE": es un
--   espejo cliente de esta vista, y corregir un lado sin el otro reproduce
--   el bug de divergencia que el resto de esta ronda de trabajo viene
--   cerrando (BRACKET_COLORS, paleta de competidor). Por eso este cambio
--   toca la vista SQL y los 4 archivos JS en el mismo commit.
--
-- VERIFICADO EN PROD ANTES DE APLICAR (sin impacto en datos existentes):
--   Las 4 subcategorías de Cargo con bids cargados (83 filas cada una, de
--   108 totales) tienen SIEMPRE price_without_discount == promedio de bids
--   — el cliente (rows.js) ya precalcula el promedio antes de guardar. Las
--   0 filas restantes por subcategoría (108-83=25) no tienen bids. O sea:
--   el resultado de effective_price para estas 2.16 M filas no cambia ni
--   un centavo con este fix — es una corrección hacia adelante, no un
--   backfill. Si Cargo alguna vez gana un camino de ingesta que NO
--   precalcule ese promedio (bot, import de Excel masivo), esta vista ya
--   lo cubre en vez de fallar en silencio.
--
--   Fuera de alcance a propósito: el filtro de exclusión de InDrive
--   Bogotá/Cali (mig 223, moneda rota) sigue comparando 'InDrive' literal.
--   Es intencional — Cargo es 100% carga manual (botApps: []), no existe
--   en Bogotá/Cali, y ese filtro es específico del bug de moneda del bot
--   de InDrive rideshare. Extenderlo a Cargo sería inventar un caso que no
--   existe.
--
-- SEGURIDAD: no toca RLS ni grants — solo la definición de una vista con
--   security_invoker (heredado de mig 030200, no se toca acá).
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE VIEW public.v_effective_price
WITH (security_invoker = true) AS
SELECT po.id,
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
        WHEN po.competition_name = ANY (ARRAY[
                'InDrive'::text,
                'InDriveCargoPickup'::text,
                'InDriveCargoVan'::text,
                'InDriveCargoLiviano'::text,
                'InDriveCargoGrande'::text
             ])
             AND (COALESCE(po.bid_1, 0::numeric) + COALESCE(po.bid_2, 0::numeric) + COALESCE(po.bid_3, 0::numeric) + COALESCE(po.bid_4, 0::numeric) + COALESCE(po.bid_5, 0::numeric)) > 0::numeric
        THEN (COALESCE(NULLIF(po.bid_1, 0::numeric), 0::numeric) + COALESCE(NULLIF(po.bid_2, 0::numeric), 0::numeric) + COALESCE(NULLIF(po.bid_3, 0::numeric), 0::numeric) + COALESCE(NULLIF(po.bid_4, 0::numeric), 0::numeric) + COALESCE(NULLIF(po.bid_5, 0::numeric), 0::numeric))
             / NULLIF(
                (CASE WHEN COALESCE(po.bid_1, 0::numeric) > 0::numeric THEN 1 ELSE 0 END) +
                (CASE WHEN COALESCE(po.bid_2, 0::numeric) > 0::numeric THEN 1 ELSE 0 END) +
                (CASE WHEN COALESCE(po.bid_3, 0::numeric) > 0::numeric THEN 1 ELSE 0 END) +
                (CASE WHEN COALESCE(po.bid_4, 0::numeric) > 0::numeric THEN 1 ELSE 0 END) +
                (CASE WHEN COALESCE(po.bid_5, 0::numeric) > 0::numeric THEN 1 ELSE 0 END), 0)::numeric
        ELSE COALESCE(po.price_without_discount, po.recommended_price)
    END AS effective_price,
    po.point_a,
    po.point_b
   FROM pricing_observations po
     LEFT JOIN tuktuk_routes tr ON tr.point_a = po.point_a AND tr.point_b = po.point_b
  WHERE (tr.point_a IS NULL OR po.category = 'TukTuk'::text)
    AND NOT (po.competition_name = 'InDrive'::text AND (po.city = ANY (ARRAY['Bogota'::text, 'Cali'::text])));

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN — correr DESPUÉS de aplicar
--
--   -- No debe cambiar ni un valor para las filas que ya tenían bids:
--   SELECT competition_name, count(*)
--   FROM v_effective_price v
--   JOIN pricing_observations po USING (id)
--   WHERE po.competition_name IN
--     ('InDriveCargoPickup','InDriveCargoVan','InDriveCargoLiviano','InDriveCargoGrande')
--     AND COALESCE(po.bid_1,0)+COALESCE(po.bid_2,0)+COALESCE(po.bid_3,0)+COALESCE(po.bid_4,0)+COALESCE(po.bid_5,0) > 0
--     AND v.effective_price IS DISTINCT FROM po.price_without_discount
--   GROUP BY competition_name;
--   -- esperado: 0 filas (ya lo estaba verificando la ELSE branch, ahora
--   -- también por la rama de bids con el mismo resultado)
-- ════════════════════════════════════════════════════════════════════════
