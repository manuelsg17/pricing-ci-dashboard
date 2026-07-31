-- ════════════════════════════════════════════════════════════════════════
-- 180_auto_tag_airport_zone.sql — toda fila en una ciudad de aeropuerto
-- recibe su `zone` automáticamente, entre por donde entre.
--
-- CONTEXTO
-- La mig 179 rellenó las 21.756 filas de aeropuerto que estaban sin zona.
-- Minutos después ya habían entrado 108 filas nuevas sin zona (carga manual
-- de Arequipa_Airport_B, 2026-07-31 16:35 UTC) — o sea el backfill limpia el
-- pasado pero no evita que se vuelva a ensuciar.
--
-- La causa: `zone` se setea en cada camino de entrada por separado y no todos
-- lo hacen. El bot ya quedó arreglado (bot_sync_push.py, 2026-07-31), pero el
-- upload de Excel y el CI manual escriben la ciudad de aeropuerto directo
-- (city='Arequipa_Airport_B') sin pasar zona — y como el trigger de ruteo
-- (mig 178) solo LEE la zona para decidir la ciudad, nadie la escribe.
--
-- Es exactamente el patrón que CLAUDE.md §4 marca como causa de incidentes
-- repetidos: "ningún trigger de normalización debe vivir en un solo lugar si
-- el dato entra por múltiples caminos". Mejor un invariante en la BD que
-- recordar el mismo detalle en 3 caminos de escritura.
--
-- APPROACH
-- Trigger BEFORE INSERT OR UPDATE OF city, zone que completa `zone` cuando
-- la ciudad es un lado de aeropuerto y la zona viene vacía:
--     city = marker.city_from → zone = marker.zone_from_value
--     city = marker.city_to   → zone = marker.zone_to_value
--
-- Solo rellena NULL/''; NUNCA pisa una zona ya puesta. Config-driven: lee de
-- airport_markers, así que respeta un rename hecho desde la pestaña
-- Aeropuertos sin tocar código.
--
-- ORDEN DE DISPARO: Postgres ejecuta los triggers por orden alfabético de
-- nombre. Este se llama 'zz_...' para correr DESPUÉS de
-- 'airport_route_before_insert' (mig 83/178) — necesita la ciudad ya
-- resuelta. Si corriera antes, en un INSERT con city='Lima' + zone='Airport_A'
-- la ciudad todavía sería la base y no matchearía ningún city_from/city_to.
--
-- VERIFICACIÓN
--   · INSERT con city='Lima_Airport_B' sin zone → zone='Airport_B'.
--   · INSERT con city='Lima' + zone='Airport_B' → mig 178 rutea a
--     Lima_Airport_B y la zona se conserva.
--   · INSERT con city='Lima' + zone='VES' (TukTuk) → no se toca.
--   · UPDATE que mueve una fila a la ciudad base → la zona NO se limpia sola
--     (fuera de alcance: este trigger solo rellena, nunca borra).
-- ════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.trg_auto_tag_airport_zone()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  m record;
BEGIN
  IF NEW.city IS NULL OR NEW.country IS NULL THEN
    RETURN NEW;
  END IF;

  -- Solo rellenar; nunca pisar una zona existente.
  IF nullif(trim(coalesce(NEW.zone, '')), '') IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT city_from, city_to, zone_from_value, zone_to_value
    INTO m
  FROM airport_markers
  WHERE country = NEW.country
    AND active = true
    AND NEW.city IN (city_from, city_to)
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF NEW.city = m.city_from THEN
    NEW.zone := m.zone_from_value;
  ELSIF NEW.city = m.city_to THEN
    NEW.zone := m.zone_to_value;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS zz_auto_tag_airport_zone ON public.pricing_observations;
CREATE TRIGGER zz_auto_tag_airport_zone
  BEFORE INSERT OR UPDATE OF city, zone ON public.pricing_observations
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_auto_tag_airport_zone();

COMMENT ON FUNCTION public.trg_auto_tag_airport_zone() IS
  'Completa pricing_observations.zone con Airport_A/Airport_B cuando la ciudad '
  'es un lado de aeropuerto y la zona viene vacía (mig 180). Solo rellena, '
  'nunca pisa. Corre despues del trigger de ruteo por el prefijo zz_.';
