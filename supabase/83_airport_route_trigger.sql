-- ════════════════════════════════════════════════════════════════════════
-- Migración 83 — Trigger BEFORE INSERT: airport routing unificado
--
-- DEPENDE DE: mig 78 (airport_markers) + mig 82 (zone columns)
--
-- POR QUÉ UN TRIGGER:
--   Los inserts a pricing_observations vienen de DOS canales:
--     - bot:    via Python script (bot_sync_push.py)
--     - manual: via Excel upload del UI (RPC upsert_pricing_batch)
--   Tener la lógica de "detectar aeropuerto y re-rutear city" duplicada
--   en ambos canales es frágil y se desincroniza. Un BEFORE INSERT
--   trigger en la tabla aplica la misma regla a TODA fila nueva, sin
--   importar de dónde venga.
--
--   El patch del Python (resolve_airport_route) sigue funcionando: cuando
--   el bot ya manda city='Lima_AeroFrom', el trigger no lo cambia (no
--   matchea base_city ni legacy). Es decir, defensive duplicate compute
--   sin conflicto.
--
-- LÓGICA (paridad con Python resolve_airport_route):
--   1. NEW.zone match con marker.zone_from_value  → NEW.city = city_from
--   2. NEW.zone match con marker.zone_to_value    → NEW.city = city_to
--   3. Keyword en NEW.point_a                     → NEW.city = city_from
--   4. Keyword solo en NEW.point_b                → NEW.city = city_to
--   5. Sin match + city era legacy _Airport       → NEW.city = base_city
--   6. Sin match + city ya era base_city          → SIN CAMBIOS
--
-- SOLO BEFORE INSERT (no UPDATE):
--   El trigger no se dispara en UPDATEs para evitar:
--     - Re-evaluación cara en cada `apply_indrive_bot_prices` (UPDATE masivo)
--     - Sobreescribir un city que el user editó manualmente
--   Si hace falta re-clasificar data existente, se usa un backfill SQL
--   explícito (como mig 81).
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION trg_airport_route_pricing_obs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  m record;
  zone_in     text := nullif(trim(coalesce(NEW.zone, '')), '');
  pa_lower    text := lower(coalesce(NEW.point_a, ''));
  pb_lower    text := lower(coalesce(NEW.point_b, ''));
  is_legacy   boolean;
BEGIN
  -- Si no hay city o country, no podemos hacer nada
  IF NEW.city IS NULL OR NEW.country IS NULL THEN
    RETURN NEW;
  END IF;

  -- Buscar el marker que aplica: por base_city o por legacy <base>_Airport
  FOR m IN
    SELECT base_city, city_from, city_to, keywords,
           zone_from_value, zone_to_value
    FROM airport_markers
    WHERE country = NEW.country AND active = true
  LOOP
    is_legacy := false;
    IF NEW.city = m.base_city THEN
      NULL;  -- match directo base_city
    ELSIF NEW.city = m.base_city || '_Airport' THEN
      is_legacy := true;
    ELSE
      CONTINUE;  -- este marker no aplica
    END IF;

    -- 1-2. Zone-based (source of truth si el upload lo etiqueta)
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

    -- 3. Keyword en point_a → city_from
    IF pa_lower <> '' AND EXISTS (
      SELECT 1 FROM unnest(m.keywords) kw
      WHERE pa_lower LIKE '%' || kw || '%'
    ) THEN
      NEW.city := m.city_from;
      RETURN NEW;
    END IF;

    -- 4. Keyword solo en point_b → city_to
    IF pb_lower <> '' AND EXISTS (
      SELECT 1 FROM unnest(m.keywords) kw
      WHERE pb_lower LIKE '%' || kw || '%'
    ) THEN
      NEW.city := m.city_to;
      RETURN NEW;
    END IF;

    -- 5. Sin match. Legacy → base_city (fallback). Base ya, no cambia.
    IF is_legacy THEN
      NEW.city := m.base_city;
    END IF;

    -- Solo un marker puede aplicar (por base_city o legacy), salir
    RETURN NEW;
  END LOOP;

  RETURN NEW;
END;
$$;

-- DROP por idempotencia (en caso de re-aplicar la mig)
DROP TRIGGER IF EXISTS airport_route_before_insert ON public.pricing_observations;

CREATE TRIGGER airport_route_before_insert
  BEFORE INSERT ON public.pricing_observations
  FOR EACH ROW
  EXECUTE FUNCTION trg_airport_route_pricing_obs();

COMMENT ON FUNCTION trg_airport_route_pricing_obs() IS
  'Re-rutea pricing_observations.city a city_from / city_to definidos en airport_markers según zone (preferido) o keywords en point_a/point_b. Mismo algoritmo que resolve_airport_route() del Python — defensive duplicate compute para garantizar que bot Y manual upload terminan con la misma clasificación.';

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
--   1. Trigger creado:
--      SELECT tgname, tgenabled FROM pg_trigger
--      WHERE tgrelid = 'public.pricing_observations'::regclass
--        AND tgname LIKE '%airport%';
--      → airport_route_before_insert | O (enabled)
--
--   2. Smoke test (no commit):
--      BEGIN;
--      INSERT INTO pricing_observations (country, city, category,
--        competition_name, data_source, observed_date, point_a, point_b, zone)
--      VALUES ('Peru', 'Lima', 'Economy/Comfort', 'Yango', 'manual',
--              CURRENT_DATE, 'Origen', 'Aeropuerto Internacional Jorge Chavez',
--              NULL);
--      SELECT city FROM pricing_observations
--      WHERE point_b = 'Aeropuerto Internacional Jorge Chavez'
--      ORDER BY id DESC LIMIT 1;
--      -- esperás: Lima_AeroTo
--      ROLLBACK;
-- ════════════════════════════════════════════════════════════════════════
