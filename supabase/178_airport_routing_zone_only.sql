-- ════════════════════════════════════════════════════════════════════════
-- 178_airport_routing_zone_only.sql — el ruteo de aeropuerto pasa a ser
-- SOLO por zona. Se eliminan las keywords sobre point_a/point_b.
--
-- CONTEXTO
-- El trigger de mig 83 decidía la ciudad de aeropuerto en 4 pasos: zona
-- (1-2) y, si no había zona, match por substring de las keywords del marker
-- contra point_a/point_b (3-4). Ese fallback por substring produjo un falso
-- positivo REAL y medible en producción:
--
--   La keyword 'jorge chavez' (por el Aeropuerto Internacional Jorge Chávez)
--   matcheó la dirección "Hipolito Unanue College, Av. Jorge Chavez 42,
--   Lima 15834" — una avenida en Villa El Salvador, a 25km del aeropuerto.
--   Resultado: 320 filas ruteadas a Lima_Airport_A que no son aeropuerto.
--     · 279 de TukTuk/VES, cargadas por 2 hubs distintos (educespe,
--       rayrodriguez) los días 24, 26 y 30 de julio.
--     · 41 del bot en categorías normales (Economy/Comfort, Comfort+, XL,
--       Premier).
--   Jorge Chávez es un héroe de la aviación peruana: hay calles con su
--   nombre en varias ciudades. El match por substring no puede distinguirlas.
--
-- Verificado antes de quitar las keywords (sobre datos reales de Lima):
--   · 59.661 filas matchean 'jorge ch'.
--   · 59.341 de ellas matchean ADEMÁS una keyword específica
--     ('aicc', 'lim airport', 'aeropuerto internacional jorge', 'callao 07031').
--   · Solo 320 dependen exclusivamente de la keyword genérica, y NINGUNA de
--     esas es un aeropuerto real (0 con 'aeropuerto'/'airport' en la dirección).
--   → quitar el fallback de keywords no pierde ni un viaje legítimo.
--
-- La fuente ya emite la zona correctamente: el Excel del simulador trae
-- zone='Airport_A'/'Airport_B' en las filas de aeropuerto y el distrito en
-- las de TukTuk, con city='Lima' en ambos casos. La zona es la señal buena;
-- la keyword era una adivinanza.
--
-- APPROACH
-- Recrear trg_airport_route_pricing_obs sin los pasos 3-4. Quedan:
--   1. zone = zone_from_value → city_from
--   2. zone = zone_to_value   → city_to
--   3. sin match: legacy '<base>_Airport' → base_city; ya-base → sin cambios
--
-- No se tocan las keywords de airport_markers (la UI las exige y siguen
-- sirviendo de documentación de qué es cada aeropuerto); simplemente dejan
-- de gobernar el ruteo.
--
-- CONSECUENCIA ACEPTADA (decisión explícita del user, 2026-07-31)
-- Un viaje de aeropuerto que llegue SIN zona ya no se atrapa: se queda en la
-- ciudad base y se mezcla con el CI normal. Antes las keywords lo rescataban.
-- Mitigación: el sync (bot_sync_push.py) ahora cuenta esas filas y las
-- reporta en notes.airport_sin_zone del bot_sync_log, para que un Excel mal
-- etiquetado se vea en vez de degradar en silencio.
--
-- VERIFICACIÓN
--   · Tras aplicar: insertar en transacción revertida una fila con
--     city='Lima' + point_a con 'jorge chavez' pero SIN zone → debe quedar
--     en 'Lima' (antes iba a Lima_Airport_A).
--   · Una fila con city='Lima' + zone='Airport_B' → debe ir a Lima_Airport_B.
-- ════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.trg_airport_route_pricing_obs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  m record;
  zone_in   text := nullif(trim(coalesce(NEW.zone, '')), '');
  is_legacy boolean;
BEGIN
  IF NEW.city IS NULL OR NEW.country IS NULL THEN
    RETURN NEW;
  END IF;

  FOR m IN
    SELECT base_city, city_from, city_to, zone_from_value, zone_to_value
    FROM airport_markers
    WHERE country = NEW.country AND active = true
  LOOP
    is_legacy := false;
    IF NEW.city = m.base_city THEN
      NULL;
    ELSIF NEW.city = m.base_city || '_Airport' THEN
      is_legacy := true;
    ELSE
      CONTINUE;
    END IF;

    -- 1-2. Zona: única señal de ruteo (mig 178).
    IF zone_in IS NOT NULL THEN
      IF m.zone_from_value IS NOT NULL AND zone_in = m.zone_from_value THEN
        NEW.city := m.city_from;
        RETURN NEW;
      END IF;
      IF m.zone_to_value IS NOT NULL AND zone_in = m.zone_to_value THEN
        NEW.city := m.city_to;
        RETURN NEW;
      END IF;
    END IF;

    -- 3. Sin zona de aeropuerto. Legacy → base_city. Base ya, no cambia.
    IF is_legacy THEN
      NEW.city := m.base_city;
    END IF;

    RETURN NEW;
  END LOOP;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.trg_airport_route_pricing_obs() IS
  'Rutea pricing_observations.city a la ciudad de aeropuerto SOLO por NEW.zone '
  '(mig 178). El match por keywords en point_a/point_b se eliminó: producía '
  'falsos positivos con calles homónimas (Av. Jorge Chavez → Lima_Airport_A).';
