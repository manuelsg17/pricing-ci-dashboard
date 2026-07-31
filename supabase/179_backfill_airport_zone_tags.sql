-- ════════════════════════════════════════════════════════════════════════
-- 179_backfill_airport_zone_tags.sql — rellena `zone` en toda la data de
-- aeropuerto que quedó sin etiquetar.
--
-- CONTEXTO
-- Toda fila en una ciudad split de aeropuerto debe llevar su lado en `zone`
-- ('Airport_A' / 'Airport_B'). Hoy 21.756 filas lo tienen NULL:
--     · bot     8.997  (2026-06-14 → 2026-07-31)
--     · manual 12.759  (2026-04-04 → 2026-07-31)
--   en las 6 ciudades split (Lima/Trujillo/Arequipa × A/B).
--
-- Por qué se acumularon, por camino de entrada:
--   · BOT — el script real de producción (scripts/bot-sync/bot_sync_push.py)
--     usaba la zona para RESOLVER la ciudad y después la descartaba:
--         'zone': zone_val if category == 'TukTuk' else None
--     La mig 117 quiso arreglar justamente esto, pero lo hizo sobre
--     sync_bot_quotes — una función que NO corre en producción (ver el
--     CONTEXTO de la mig 135). El camino real nunca se tocó, así que el
--     100% de la data de aeropuerto del bot quedó con zone NULL.
--     Arreglado en el script el 2026-07-31, junto con esta migración.
--   · MANUAL — el upload de Excel y el CI manual tampoco garantizaban el
--     tag; la mig 118 hizo un backfill pero solo cubrió el snapshot del
--     2026-06-21, y desde entonces se volvió a acumular.
--
-- Impacto de tenerlo NULL: el selector de Zona del dashboard muestra esas
-- filas en blanco, y cualquier filtro o corte por Punto A/B las pierde
-- silenciosamente — justo la herramienta que se necesita para separar
-- aeropuerto del CI normal.
--
-- APPROACH
-- El lado ya está codificado en el nombre de la ciudad, así que el backfill
-- es determinístico y no adivina nada:
--     '<base>_Airport_A' → zone = 'Airport_A'
--     '<base>_Airport_B' → zone = 'Airport_B'
-- Es el mismo criterio de la mig 118 ('Airport_' || right(city,1)), pero se
-- toma el valor desde airport_markers en vez de construirlo por string, para
-- que respete un rename de zone_from_value/zone_to_value hecho desde la
-- pestaña Aeropuertos.
--
-- Idempotente: el predicado `zone IS NULL` hace que re-correr no toque nada.
-- NO sobreescribe zonas ya seteadas (ni tags correctos ni distritos).
--
-- FUERA DE ALCANCE — 288 filas de TukTuk con zone NULL (manual, 2026-03-06 a
-- 2026-03-09). Ahí el distrito NO es deducible: no está en la ciudad ni en
-- ninguna otra columna. Son anteriores al gate de distrito y traen brackets
-- long/very_long que la mig 135 documenta como rutas irreales que inflan el
-- promedio de TukTuk (~S/6.9 vs ~S/4.4 real). Se dejan como están: borrarlas
-- es una decisión de negocio, no de esta migración.
--
-- VERIFICACIÓN
--   SELECT count(*) FROM pricing_observations
--    WHERE city LIKE '%\_Airport\_%' AND zone IS NULL;   -- debe dar 0
--   SELECT city, zone, count(*) FROM pricing_observations
--    WHERE city LIKE '%\_Airport\_%' GROUP BY 1,2;       -- 1 zona por ciudad
-- ════════════════════════════════════════════════════════════════════════

UPDATE public.pricing_observations po
SET zone = m.zone_from_value
FROM public.airport_markers m
WHERE m.active
  AND po.country = m.country
  AND po.city    = m.city_from
  AND m.zone_from_value IS NOT NULL
  AND po.zone IS NULL;

UPDATE public.pricing_observations po
SET zone = m.zone_to_value
FROM public.airport_markers m
WHERE m.active
  AND po.country = m.country
  AND po.city    = m.city_to
  AND m.zone_to_value IS NOT NULL
  AND po.zone IS NULL;
