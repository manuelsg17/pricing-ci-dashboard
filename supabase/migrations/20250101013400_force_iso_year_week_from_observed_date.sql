-- ════════════════════════════════════════════════════════════════════════
-- Migración 94 — year/week siempre derivados de observed_date
--
-- PROBLEMA:
--   Los Excel del campo traen una columna "Week" (y opcionalmente "Year")
--   prerellenada con un cálculo distinto al ISO 8601 (típicamente Excel
--   WEEKNUM con offset). Upload.jsx mapeaba esas columnas → pricing_observations
--   y el trigger trg_assign_computed_fields sólo computaba cuando NEW.week
--   era NULL ("IF NEW.week IS NULL THEN..."). Resultado: filas con week
--   sistemáticamente -1 del valor ISO correcto.
--
--   Diagnóstico 2026-05-26: ~46k filas Peru con stored = iso_real - 1.
--
-- DECISIÓN:
--   year y week son DERIVADOS de observed_date — no datos independientes.
--   Permitir override es un bug latente. El trigger ahora SIEMPRE
--   sobreescribe ambos campos desde observed_date.
--
-- QUÉ HACE:
--   1. Reemplaza trg_assign_computed_fields() para forzar el recompute.
--   2. Backfill de pricing_observations: actualiza year/week en filas
--      donde no coincidan con observed_date.
--
-- PERFORMANCE:
--   El UPDATE masivo toma ~30-60s sobre 600k filas. Idempotente:
--   re-ejecuciones no tocan filas correctas.
--
-- COMPLEMENTO EN FRONTEND:
--   Upload.jsx debería quitar 'Week'/'Week (for pivot)'/'Year' del COL_MAP
--   para evitar que el cliente siga mandando valores que serán ignorados
--   (commit del frontend va junto a esta mig).
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Trigger function: SIEMPRE recompute year/week ────────────────────
CREATE OR REPLACE FUNCTION trg_assign_computed_fields()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Bracket (solo si no viene ya asignado)
  IF NEW.distance_bracket IS NULL AND NEW.distance_km IS NOT NULL THEN
    NEW.distance_bracket := get_distance_bracket(NEW.city, NEW.category, NEW.distance_km);
  END IF;

  -- Año e ISO week — SIEMPRE derivados de observed_date.
  -- Mig 94: antes sólo se computaba si NEW.year/week eran NULL, lo que
  -- permitía que Excels con "Week" prerellenado mal calculado contaminaran
  -- la BD. Ahora cualquier valor de entrada se descarta.
  IF NEW.observed_date IS NOT NULL THEN
    NEW.year := EXTRACT(isoyear FROM NEW.observed_date)::int;
    NEW.week := EXTRACT(week    FROM NEW.observed_date)::int;
  END IF;

  -- Rush hour (no sobreescribir si ya viene del bot)
  IF NEW.rush_hour IS NULL AND NEW.observed_time IS NOT NULL THEN
    NEW.rush_hour := (
      (NEW.observed_time >= '07:00' AND NEW.observed_time <= '09:00') OR
      (NEW.observed_time >= '17:00' AND NEW.observed_time <= '20:00')
    );
  END IF;

  -- Time of day (5 franjas horarias)
  IF NEW.time_of_day IS NULL AND NEW.observed_time IS NOT NULL THEN
    NEW.time_of_day := get_time_of_day(NEW.observed_time::time);
  END IF;

  RETURN NEW;
END;
$$;

-- ── 2. Backfill: corregir filas con year/week incorrecto ────────────────
DO $backfill$
DECLARE
  v_updated bigint;
BEGIN
  WITH upd AS (
    UPDATE pricing_observations
    SET year = EXTRACT(isoyear FROM observed_date)::int,
        week = EXTRACT(week    FROM observed_date)::int
    WHERE observed_date IS NOT NULL
      AND (year IS DISTINCT FROM EXTRACT(isoyear FROM observed_date)::int
        OR week IS DISTINCT FROM EXTRACT(week    FROM observed_date)::int)
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_updated FROM upd;

  RAISE NOTICE 'Mig 94: % filas con year/week corregidos al ISO real', v_updated;
END
$backfill$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
--   SELECT COUNT(*) AS desalineadas
--   FROM pricing_observations
--   WHERE observed_date IS NOT NULL
--     AND (year IS DISTINCT FROM EXTRACT(isoyear FROM observed_date)::int
--       OR week IS DISTINCT FROM EXTRACT(week    FROM observed_date)::int);
--   → Esperado: 0.
-- ════════════════════════════════════════════════════════════════════════
