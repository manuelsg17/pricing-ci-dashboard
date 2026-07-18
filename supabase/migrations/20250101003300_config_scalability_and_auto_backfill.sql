-- ============================================================
-- MIGRACIÓN 33: Escalabilidad multi-país + auto-backfill de brackets
-- ============================================================
-- Objetivos:
-- 1. get_distance_bracket acepta p_country para evitar cruces entre
--    países cuando Colombia/Nepal/Bolivia usen nombres de ciudad que
--    podrían colisionar con Perú.
-- 2. El trigger pasa el country al llamar get_distance_bracket.
-- 3. semaforo_config recibe country + constraint UNIQUE(country, band, min_pct)
--    para que cada país tenga su propio semáforo.
-- 4. competitor_commissions: nuevo UNIQUE(country, competitor_name, city)
--    — antes el constraint ignoraba country y creaba colisiones cross-country.
-- 5. competitor_bonuses: nuevo UNIQUE(country, competitor_name, bonus_type,
--    threshold, city) — antes no tenía constraint.
-- 6. NUEVO RPC recompute_brackets_for(country, city, category): re-clasifica
--    filas existentes tras un cambio de umbrales desde el panel Config.
--    El frontend lo llama automáticamente después de saveThresholds.
-- ============================================================

BEGIN;

-- ── 1. get_distance_bracket con country ─────────────────────

CREATE OR REPLACE FUNCTION get_distance_bracket(
  p_country  text,
  p_city     text,
  p_category text,
  p_distance numeric
) RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE
  r RECORD;
BEGIN
  -- Busca específico de (country, city, category)
  FOR r IN
    SELECT bracket, max_km
    FROM distance_thresholds
    WHERE country = p_country
      AND city     = p_city
      AND category = p_category
    ORDER BY COALESCE(max_km, 999999) ASC
  LOOP
    IF r.max_km IS NULL OR p_distance <= r.max_km THEN
      RETURN r.bracket;
    END IF;
  END LOOP;

  -- Fallback a category='all' del mismo país/ciudad
  FOR r IN
    SELECT bracket, max_km
    FROM distance_thresholds
    WHERE country = p_country
      AND city     = p_city
      AND category = 'all'
    ORDER BY COALESCE(max_km, 999999) ASC
  LOOP
    IF r.max_km IS NULL OR p_distance <= r.max_km THEN
      RETURN r.bracket;
    END IF;
  END LOOP;

  RETURN 'very_long';
END;
$$;

-- Sobrecarga legacy (3-arg) para no romper llamadas existentes hasta
-- que todo el código pase a la versión de 4 args. Asume country='Peru'.
CREATE OR REPLACE FUNCTION get_distance_bracket(
  p_city     text,
  p_category text,
  p_distance numeric
) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT get_distance_bracket('Peru', p_city, p_category, p_distance);
$$;


-- ── 2. Trigger: pasa country a get_distance_bracket ─────────

CREATE OR REPLACE FUNCTION trg_assign_computed_fields()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.distance_bracket := get_distance_bracket(
    COALESCE(NEW.country, 'Peru'),
    NEW.city,
    NEW.category,
    NEW.distance_km
  );

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


-- ── 3. semaforo_config: country + unique constraint ─────────

ALTER TABLE semaforo_config
  ADD COLUMN IF NOT EXISTS country text NOT NULL DEFAULT 'Peru';

ALTER TABLE semaforo_config
  DROP CONSTRAINT IF EXISTS semaforo_config_band_min_pct_key;

ALTER TABLE semaforo_config
  DROP CONSTRAINT IF EXISTS semaforo_config_country_band_min_pct_key;

ALTER TABLE semaforo_config
  ADD CONSTRAINT semaforo_config_country_band_min_pct_key
  UNIQUE (country, band, min_pct);

CREATE INDEX IF NOT EXISTS idx_semaforo_country
  ON semaforo_config(country);


-- ── 4. competitor_commissions: unique con country ───────────

ALTER TABLE competitor_commissions
  DROP CONSTRAINT IF EXISTS competitor_commissions_competitor_name_city_key;

ALTER TABLE competitor_commissions
  DROP CONSTRAINT IF EXISTS competitor_commissions_country_competitor_name_city_key;

-- Postgres no permite UNIQUE sobre NULLs de forma clásica; en PG15+
-- hay NULLS NOT DISTINCT, pero preferimos un índice parcial + uno no-parcial
-- para cubrir city=null.
CREATE UNIQUE INDEX IF NOT EXISTS competitor_commissions_ctry_comp_city_idx
  ON competitor_commissions (country, competitor_name, city)
  WHERE city IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS competitor_commissions_ctry_comp_null_idx
  ON competitor_commissions (country, competitor_name)
  WHERE city IS NULL;


-- ── 5. competitor_bonuses: unique con country ───────────────

ALTER TABLE competitor_bonuses
  ADD COLUMN IF NOT EXISTS country text NOT NULL DEFAULT 'Peru';

CREATE UNIQUE INDEX IF NOT EXISTS competitor_bonuses_ctry_comp_type_thr_city_idx
  ON competitor_bonuses (country, competitor_name, bonus_type, threshold, city)
  WHERE city IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS competitor_bonuses_ctry_comp_type_thr_null_idx
  ON competitor_bonuses (country, competitor_name, bonus_type, threshold)
  WHERE city IS NULL;


-- ── 6. RPC recompute_brackets_for ───────────────────────────
-- Llamado por el panel Config tras cambiar umbrales de distancia,
-- para que los datos ya existentes queden clasificados con los
-- nuevos umbrales sin necesidad de correr SQL manual.

CREATE OR REPLACE FUNCTION recompute_brackets_for(
  p_country  text,
  p_city     text,
  p_category text
) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  updated_count int;
BEGIN
  UPDATE pricing_observations
  SET distance_bracket = get_distance_bracket(
    p_country, city, category, distance_km
  )
  WHERE country  = p_country
    AND city     = p_city
    AND category = p_category
    AND distance_km IS NOT NULL;

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$;

GRANT EXECUTE ON FUNCTION recompute_brackets_for(text, text, text) TO authenticated;


COMMIT;


-- ── Verificación ────────────────────────────────────────────
-- Corre esto después del COMMIT para confirmar que todo existe:

-- 1. La función con p_country
SELECT proname, pg_get_function_arguments(oid) AS args
FROM pg_proc
WHERE proname IN ('get_distance_bracket', 'recompute_brackets_for', 'trg_assign_computed_fields')
ORDER BY proname, args;

-- 2. Semaforo con country
SELECT column_name, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'semaforo_config' AND column_name = 'country';

-- 3. Índices únicos multi-país
SELECT indexname FROM pg_indexes
WHERE tablename IN ('competitor_commissions', 'competitor_bonuses', 'semaforo_config')
  AND indexname LIKE '%country%' OR indexname LIKE '%ctry%';

-- 4. Probar el RPC manualmente (cuenta cuántas filas re-clasificaría)
-- SELECT recompute_brackets_for('Peru', 'Lima', 'Economy/Comfort');
