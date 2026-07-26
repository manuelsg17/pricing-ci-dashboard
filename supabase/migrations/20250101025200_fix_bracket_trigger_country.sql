-- ════════════════════════════════════════════════════════════════════════
-- 171_fix_bracket_trigger_country.sql — bug real encontrado revisando el
-- overload de 3 argumentos de get_distance_bracket (auditoría 2026-07-26).
--
-- trg_assign_computed_fields (trigger BEFORE INSERT/UPDATE de
-- pricing_observations) calculaba el bracket con
-- get_distance_bracket(NEW.city, NEW.category, NEW.distance_km) — el
-- overload de 3 args, que hardcodea country='Peru' internamente (ver
-- 61_definer_search_path_and_timeouts.sql). Para cualquier fila de
-- Colombia/Nepal que llegue SIN distance_bracket explícito pero CON
-- distance_km, el trigger calcularía el bracket usando los umbrales de
-- distancia de PERÚ en vez de los del país real — silencioso, sin error.
--
-- Verificado antes de este fix: hoy ninguna fila de un país distinto a
-- Peru tiene distance_km cargado (bug LATENTE, no activo todavía) — pero
-- Colombia ya está en onboarding, así que se corrige antes de que
-- empiece a entrar data real que lo dispare.
--
-- Fix: pasar NEW.country explícito → usa el overload de 4 argumentos
-- (el mismo que ya usa recompute_brackets_for, el RPC de recálculo
-- manual desde Config). El overload de 3 args NO se borra en esta
-- migración — no se tocó si algo más lo llama (no se encontraron otros
-- callers, pero se prefiere no borrar código en la misma mig que arregla
-- el bug real).
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.trg_assign_computed_fields()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  -- Bracket (solo si no viene ya asignado) — 4 args, país explícito.
  IF NEW.distance_bracket IS NULL AND NEW.distance_km IS NOT NULL THEN
    NEW.distance_bracket := get_distance_bracket(NEW.country, NEW.city, NEW.category, NEW.distance_km);
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

COMMIT;
