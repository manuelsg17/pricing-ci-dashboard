-- ============================================================
-- MIGRACIÓN 148: Hora real de captura en Ingresar CI (grilla)
-- ============================================================
--
-- Contexto: DataEntry.jsx (la grilla manual) siempre guardaba
-- observed_time = hora FIJA del turno (08:00/13:00/18:00), nunca la hora
-- real en la que el hub cargó el dato. Pasa a guardar la hora real.
--
-- La columna `timeslot` (text) YA EXISTE desde 01_schema.sql — hoy solo la
-- escribe Upload.jsx (import Excel masivo, valores 'Morning'/'Midday'/
-- 'Evening'); la grilla nunca la tocaba. Pasa a ser el identificador
-- ESTABLE de "a qué turno pertenece esta fila" para la grilla también,
-- independiente de observed_time:
--   • El DELETE-antes-de-INSERT de performSave (DataEntry.jsx) se acota por
--     `timeslot` en vez de por `observed_time` — si no, cada "Guardar
--     Progreso" sucesivo dentro del mismo turno dejaría de encontrar las
--     filas viejas (que ahora tienen una hora real distinta cada vez) y
--     generaría FILAS DUPLICADAS silenciosas en cada guardado incremental.
--   • loadObservationsIntoForm mapea las filas de vuelta al turno correcto
--     por `timeslot` (la etiqueta), no por hora exacta.
--   • time_of_day (filtro "Franja horaria" del dashboard) pasa a derivar de
--     `timeslot` cuando está presente (nunca cambia aunque la hora real
--     cruce de franja, ej. Tarde guardada a las 18:05 sigue siendo
--     'midday') — solo cae a derivar de observed_time si timeslot es NULL
--     (bot/Excel siguen exactamente igual que antes).
--   • rush_hour NO se toca: ya se calcula del lado del cliente con la hora
--     CANÓNICA del turno (ts.start_time), no con observed_time — sigue
--     estampado explícito en cada insert, el trigger nunca lo pisa.
-- ============================================================

BEGIN;

-- ── 1. time_of_day: preferir `timeslot` (estable) sobre observed_time
--       (real, puede cruzar de franja) cuando timeslot viene poblado ──

CREATE OR REPLACE FUNCTION trg_assign_computed_fields()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Bracket (solo si no viene ya asignado)
  IF NEW.distance_bracket IS NULL AND NEW.distance_km IS NOT NULL THEN
    NEW.distance_bracket := get_distance_bracket(NEW.city, NEW.category, NEW.distance_km);
  END IF;

  -- Año e ISO week — SIEMPRE derivados de observed_date (mig 94).
  IF NEW.observed_date IS NOT NULL THEN
    NEW.year := EXTRACT(isoyear FROM NEW.observed_date)::int;
    NEW.week := EXTRACT(week    FROM NEW.observed_date)::int;
  END IF;

  -- Rush hour (no sobreescribir si ya viene del bot o del cliente)
  IF NEW.rush_hour IS NULL AND NEW.observed_time IS NOT NULL THEN
    NEW.rush_hour := (
      (NEW.observed_time >= '07:00' AND NEW.observed_time <= '09:00') OR
      (NEW.observed_time >= '17:00' AND NEW.observed_time <= '20:00')
    );
  END IF;

  -- Time of day (5 franjas horarias). `timeslot` ('Morning'/'Midday'/
  -- 'Evening', ver mig 148) es el identificador ESTABLE del turno cuando
  -- está presente — evita que la hora REAL de captura (que puede cruzar
  -- de franja) corrompa el filtro. Sin timeslot (bot/Excel legacy), cae a
  -- derivar de observed_time como siempre.
  IF NEW.time_of_day IS NULL AND NEW.timeslot IS NOT NULL THEN
    NEW.time_of_day := lower(NEW.timeslot);
  ELSIF NEW.time_of_day IS NULL AND NEW.observed_time IS NOT NULL THEN
    NEW.time_of_day := get_time_of_day(NEW.observed_time::time);
  END IF;

  RETURN NEW;
END;
$$;

-- ── 2. Backfill: filas de grilla (data_source='manual') que quedaron sin
--       `timeslot` poblado (nunca lo escribió DataEntry.jsx hasta ahora) —
--       se infiere del bucket de su observed_time histórico (que hasta hoy
--       siempre fue la hora canónica del turno). Título-caso para que
--       coincida con la convención ya usada por Upload.jsx ──

UPDATE pricing_observations
SET timeslot = INITCAP(get_time_of_day(observed_time::time))
WHERE data_source = 'manual'
  AND timeslot IS NULL
  AND observed_time IS NOT NULL;

COMMIT;
