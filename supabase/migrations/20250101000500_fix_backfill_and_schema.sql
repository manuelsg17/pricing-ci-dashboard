-- ============================================================
-- MIGRACIÓN 06: Corregir year/week faltantes + schema fixes
-- Ejecutar en Supabase SQL Editor
-- ============================================================

-- ──────────────────────────────────────────────────────────
-- 1. Hacer distance_km NULLABLE
--    (filas del bot no tienen distancia en km, solo bracket)
-- ──────────────────────────────────────────────────────────
ALTER TABLE pricing_observations
  ALTER COLUMN distance_km DROP NOT NULL;


-- ──────────────────────────────────────────────────────────
-- 2. Corregir el trigger para respetar distance_bracket
--    cuando distance_km es NULL (datos del bot)
-- ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION trg_assign_computed_fields()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Asignar bracket SOLO si distance_km está disponible
  -- (si ya viene un bracket del bot, respetarlo)
  IF NEW.distance_km IS NOT NULL THEN
    NEW.distance_bracket := get_distance_bracket(NEW.city, NEW.category, NEW.distance_km);
  END IF;
  -- Si distance_km es NULL y distance_bracket también es NULL, dejar NULL
  -- (no sobreescribir el bracket que ya trae el bot)

  -- Asignar año e ISO week si no vienen
  IF NEW.year IS NULL THEN
    NEW.year := EXTRACT(year FROM NEW.observed_date)::int;
  END IF;
  IF NEW.week IS NULL THEN
    NEW.week := EXTRACT(week FROM NEW.observed_date)::int;
  END IF;

  -- Asignar rush_hour si no viene
  IF NEW.rush_hour IS NULL AND NEW.observed_time IS NOT NULL THEN
    NEW.rush_hour := (
      (NEW.observed_time >= '07:00' AND NEW.observed_time <= '09:00') OR
      (NEW.observed_time >= '17:00' AND NEW.observed_time <= '20:00')
    );
  END IF;

  RETURN NEW;
END;
$$;


-- ──────────────────────────────────────────────────────────
-- 3. Diagnóstico: ¿cuántas filas tienen year/week NULL?
--    Corre este SELECT primero para ver el impacto
-- ──────────────────────────────────────────────────────────
/*
SELECT
  city,
  COUNT(*)               AS total_filas,
  COUNT(year)            AS con_year,
  COUNT(*) - COUNT(year) AS sin_year,
  COUNT(week)            AS con_week,
  COUNT(*) - COUNT(week) AS sin_week
FROM pricing_observations
GROUP BY city
ORDER BY city;
*/


-- ──────────────────────────────────────────────────────────
-- 4. BACKFILL: rellenar year, week, rush_hour para todas
--    las filas donde faltan (datos subidos antes del trigger)
--
--    ATENCIÓN: Esto puede tardar 30-60 segundos si hay
--    más de 100k filas. Es seguro ejecutarlo.
-- ──────────────────────────────────────────────────────────
UPDATE pricing_observations
SET
  year = EXTRACT(year FROM observed_date)::int,
  week = EXTRACT(week FROM observed_date)::int,
  rush_hour = CASE
    WHEN observed_time IS NOT NULL THEN
      (observed_time >= '07:00' AND observed_time <= '09:00') OR
      (observed_time >= '17:00' AND observed_time <= '20:00')
    ELSE NULL
  END
WHERE year IS NULL OR week IS NULL;


-- ──────────────────────────────────────────────────────────
-- 5. Verificación: después del backfill no debe haber NULLs
-- ──────────────────────────────────────────────────────────
/*
SELECT
  city,
  COUNT(*) AS total_filas,
  COUNT(*) - COUNT(year) AS sin_year_tras_fix,
  COUNT(*) - COUNT(week) AS sin_week_tras_fix
FROM pricing_observations
GROUP BY city;
*/
