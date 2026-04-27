-- ============================================================
-- MIGRACIÓN 40: Trigger respeta distance_bracket cuando viene del caller
-- ============================================================
--
-- BUG QUE ARREGLA:
--   El trigger trg_assign_computed_fields siempre sobreescribía
--   NEW.distance_bracket llamando a get_distance_bracket(country, city,
--   category, distance_km). La data del bot trae distance_bracket ya
--   clasificado (Short, Long, etc.) pero NO trae distance_km — entonces
--   get_distance_bracket caía al fallback `RETURN 'very_long'` y todas las
--   filas del bot quedaban como 'very_long' a pesar de venir clasificadas.
--
-- COMPORTAMIENTO NUEVO:
--   - Si el caller pasa distance_bracket → se respeta (data del bot, upload
--     de Excel del bot, manual entry, etc.).
--   - Si distance_bracket llega NULL pero hay distance_km → se deriva del
--     km (camino tradicional del Excel manual).
--   - Si ambos son NULL → fallback histórico 'very_long'.
--
-- IMPORTANTE: tras correr esta migración hay que re-sync de los rows del
-- bot que quedaron con bracket incorrecto. Ver el bloque opcional al final.
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION trg_assign_computed_fields()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Solo derivar bracket cuando NO viene del caller. Esto preserva la
  -- clasificación del bot (que trae bracket pero no km) y la del Excel
  -- (que trae ambos).
  IF NEW.distance_bracket IS NULL THEN
    NEW.distance_bracket := get_distance_bracket(
      COALESCE(NEW.country, 'Peru'),
      NEW.city,
      NEW.category,
      NEW.distance_km
    );
  END IF;

  IF NEW.year IS NULL THEN
    NEW.year := EXTRACT(isoyear FROM NEW.observed_date);
  END IF;
  IF NEW.week IS NULL THEN
    NEW.week := EXTRACT(week FROM NEW.observed_date)::int;
  END IF;

  IF NEW.rush_hour IS NULL AND NEW.observed_time IS NOT NULL THEN
    NEW.rush_hour := (
      (NEW.observed_time >= '07:00' AND NEW.observed_time <= '09:00') OR
      (NEW.observed_time >= '17:00' AND NEW.observed_time <= '20:00')
    );
  END IF;

  RETURN NEW;
END;
$$;

COMMIT;

-- ============================================================
-- LIMPIEZA + RE-SYNC (correr manualmente, no automático)
-- ============================================================
-- Después de aplicar la migración, los rows del bot existentes ya están
-- corruptos (todos como very_long). Para re-sync limpio:
--
--   -- 1) Borrar rows del bot
--   DELETE FROM pricing_observations
--    WHERE country = 'Peru' AND data_source = 'bot';
--
--   -- 2) Resetear watermark para que la próxima corrida traiga todo
--   UPDATE bot_sync_watermark
--      SET last_synced_at = '1970-01-01T00:00:00+00:00'
--    WHERE country = 'Peru';
--
--   -- 3) Disparar workflow Bot Sync con limit alto desde el dashboard,
--   --    o repetidamente hasta alcanzar la fecha actual.
-- ============================================================
