-- ============================================================
-- MIGRACIÓN 43: Hard copy — snapshot de promedios ponderados
-- ============================================================
--
-- QUÉ HACE:
--   Cuando el usuario cambia pesos de distribución, umbrales de km
--   o cualquier configuración que afecta datos históricos, el sistema
--   primero crea un "hard copy" de los valores computados actuales.
--   Los datos históricos anteriores al snapshot usan los valores fijos
--   almacenados, de modo que futuros cambios ya no los alteran.
--
-- TABLA:
--   pricing_wa_frozen — almacena promedios por (bracket + WA calculado)
--     con los pesos vigentes al momento del snapshot.
--
-- RPC:
--   freeze_pricing_wa(p_country, p_label) → bigint (filas insertadas)
--     Materializa v_bracket_weekly_avg y calcula el WA con los pesos
--     actuales de bracket_weights. No sobreescribe datos ya congelados.
--
--   get_dashboard_data_weekly_frozen(…) → igual que la RPC normal pero
--     usa datos congelados cuando existen.
-- ============================================================

BEGIN;

-- ── 1. Tabla de snapshots ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS pricing_wa_frozen (
  id               bigserial    PRIMARY KEY,
  country          text         NOT NULL,
  city             text         NOT NULL,
  category         text         NOT NULL,
  year             int          NOT NULL,
  week             int          NOT NULL,
  competition_name text         NOT NULL,
  distance_bracket text         NOT NULL,   -- bracket real o '_wa'
  avg_price        numeric,
  observation_count bigint,
  frozen_at        timestamptz  NOT NULL DEFAULT now(),
  frozen_label     text,
  UNIQUE (country, city, category, year, week, competition_name, distance_bracket)
);

CREATE INDEX IF NOT EXISTS idx_wa_frozen_lookup
  ON pricing_wa_frozen(country, city, category, year, week);

-- ── 2. RPC: crear snapshot ─────────────────────────────────────
--
-- Calcula el WA usando los pesos actuales de bracket_weights y los
-- almacena como distance_bracket = '_wa'. Los promedios por bracket
-- individual también se guardan para congelar las vistas de detalle.
--
-- Lógica de pesos: primero busca peso ciudad-específico, luego 'all',
-- luego usa defaults de la constante JS (replicados aquí como fallback).

CREATE OR REPLACE FUNCTION freeze_pricing_wa(
  p_country text,
  p_label   text DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  cnt bigint := 0;
BEGIN
  -- a) Insertar promedios por bracket (aggregando data_source, surge, time_of_day)
  INSERT INTO pricing_wa_frozen (
    country, city, category, year, week,
    competition_name, distance_bracket,
    avg_price, observation_count, frozen_label
  )
  SELECT
    v.country, v.city, v.category, v.year, v.week,
    v.competition_name, v.distance_bracket,
    ROUND(
      (SUM(v.avg_price * v.observation_count) / NULLIF(SUM(v.observation_count), 0))::numeric,
      2
    ) AS avg_price,
    SUM(v.observation_count) AS observation_count,
    p_label
  FROM v_bracket_weekly_avg v
  WHERE v.country = p_country
  GROUP BY v.country, v.city, v.category, v.year, v.week,
           v.competition_name, v.distance_bracket
  ON CONFLICT (country, city, category, year, week, competition_name, distance_bracket)
  DO NOTHING;  -- No sobreescribir datos ya congelados de periodos previos

  GET DIAGNOSTICS cnt = ROW_COUNT;

  -- b) Calcular e insertar WA con pesos actuales (distance_bracket = '_wa')
  INSERT INTO pricing_wa_frozen (
    country, city, category, year, week,
    competition_name, distance_bracket,
    avg_price, observation_count, frozen_label
  )
  WITH per_bracket AS (
    -- Promedio por bracket (ya sin surge/time_of_day para el WA global)
    SELECT
      v.country, v.city, v.category, v.year, v.week,
      v.competition_name, v.distance_bracket,
      SUM(v.avg_price * v.observation_count) / NULLIF(SUM(v.observation_count), 0) AS avg_price,
      SUM(v.observation_count) AS total_count
    FROM v_bracket_weekly_avg v
    WHERE v.country = p_country
    GROUP BY v.country, v.city, v.category, v.year, v.week,
             v.competition_name, v.distance_bracket
  ),
  weights_resolved AS (
    -- Pesos: ciudad específica si existe, si no 'all', si no defaults hardcoded
    SELECT
      pb.country, pb.city, pb.distance_bracket AS bracket,
      COALESCE(
        (SELECT bw.weight FROM bracket_weights bw
          WHERE bw.country = pb.country AND bw.city = pb.city
            AND bw.bracket = pb.distance_bracket LIMIT 1),
        (SELECT bw.weight FROM bracket_weights bw
          WHERE bw.country = pb.country AND bw.city = 'all'
            AND bw.bracket = pb.distance_bracket LIMIT 1),
        CASE pb.distance_bracket
          WHEN 'very_short' THEN 0.0983
          WHEN 'short'      THEN 0.1967
          WHEN 'median'     THEN 0.1939
          WHEN 'average'    THEN 0.1384
          WHEN 'long'       THEN 0.0750
          WHEN 'very_long'  THEN 0.2970
          ELSE 0
        END
      ) AS weight
    FROM per_bracket pb
  ),
  wa_rows AS (
    SELECT
      pb.country, pb.city, pb.category, pb.year, pb.week,
      pb.competition_name,
      '_wa' AS distance_bracket,
      -- Exclusión de brackets con precio <= 1 (igual que JS computeWeightedAvg)
      ROUND(
        SUM(CASE WHEN pb.avg_price > 1 THEN pb.avg_price * wr.weight ELSE 0 END)
        / NULLIF(SUM(CASE WHEN pb.avg_price > 1 THEN wr.weight ELSE 0 END), 0)::numeric,
        2
      ) AS avg_price,
      SUM(pb.total_count) AS observation_count
    FROM per_bracket pb
    JOIN weights_resolved wr
      ON wr.country = pb.country
      AND wr.city   = pb.city
      AND wr.bracket = pb.distance_bracket
    GROUP BY pb.country, pb.city, pb.category, pb.year, pb.week, pb.competition_name
  )
  SELECT country, city, category, year, week, competition_name, distance_bracket,
         avg_price, observation_count, p_label
  FROM wa_rows
  WHERE avg_price IS NOT NULL
  ON CONFLICT (country, city, category, year, week, competition_name, distance_bracket)
  DO NOTHING;

  GET DIAGNOSTICS cnt = ROW_COUNT;
  RETURN cnt;
END;
$$;

GRANT EXECUTE ON FUNCTION freeze_pricing_wa(text, text) TO authenticated;

-- ── 3. RPC: datos del dashboard priorizando datos congelados ───

CREATE OR REPLACE FUNCTION get_dashboard_data_weekly_with_freeze(
  p_city        text,
  p_category    text,
  p_country     text     DEFAULT 'Peru',
  p_zone        text     DEFAULT NULL,
  p_surge       boolean  DEFAULT NULL,
  p_week_start  int      DEFAULT NULL,
  p_year_start  int      DEFAULT NULL,
  p_week_end    int      DEFAULT NULL,
  p_year_end    int      DEFAULT NULL,
  p_data_source text     DEFAULT NULL,
  p_time_of_day text[]   DEFAULT NULL,
  p_use_frozen  boolean  DEFAULT true
) RETURNS TABLE (
  competition_name  text,
  distance_bracket  text,
  week              int,
  year              int,
  week_start_date   date,
  avg_price         numeric,
  observation_count bigint,
  surge             boolean,
  is_frozen         boolean
)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  -- Datos vivos (semanas no congeladas o si p_use_frozen = false)
  SELECT
    competition_name, distance_bracket, week, year,
    MIN(week_start_date)                                                            AS week_start_date,
    ROUND((SUM(avg_price * observation_count) / NULLIF(SUM(observation_count), 0))::numeric, 2) AS avg_price,
    SUM(observation_count)                                                          AS observation_count,
    surge,
    false AS is_frozen
  FROM v_bracket_weekly_avg
  WHERE country  = p_country
    AND city     = p_city
    AND category = p_category
    AND (p_zone        IS NULL OR zone = p_zone OR p_zone = 'All')
    AND (p_surge       IS NULL OR surge = p_surge)
    AND (p_data_source IS NULL OR data_source = p_data_source)
    AND (p_time_of_day IS NULL
         OR (time_of_day IS NOT NULL AND time_of_day = ANY(p_time_of_day)))
    AND (p_year_start IS NULL OR (year > p_year_start)
         OR (year = p_year_start AND week >= p_week_start))
    AND (p_year_end IS NULL OR (year < p_year_end)
         OR (year = p_year_end AND week <= p_week_end))
    -- Excluir semanas que ya tienen datos congelados (si p_use_frozen = true)
    AND (
      NOT p_use_frozen
      OR NOT EXISTS (
        SELECT 1 FROM pricing_wa_frozen f
        WHERE f.country = p_country AND f.city = p_city AND f.category = p_category
          AND f.year = v_bracket_weekly_avg.year AND f.week = v_bracket_weekly_avg.week
          AND f.competition_name = v_bracket_weekly_avg.competition_name
          AND f.distance_bracket = v_bracket_weekly_avg.distance_bracket
      )
    )
  GROUP BY competition_name, distance_bracket, week, year, surge

  UNION ALL

  -- Datos congelados
  SELECT
    competition_name, distance_bracket, week, year,
    NULL::date AS week_start_date,
    avg_price,
    observation_count,
    NULL::boolean AS surge,
    true AS is_frozen
  FROM pricing_wa_frozen
  WHERE country  = p_country
    AND city     = p_city
    AND category = p_category
    AND p_use_frozen
    AND (p_year_start IS NULL OR (year > p_year_start)
         OR (year = p_year_start AND week >= p_week_start))
    AND (p_year_end IS NULL OR (year < p_year_end)
         OR (year = p_year_end AND week <= p_week_end))

  ORDER BY competition_name, distance_bracket, year, week;
$$;

GRANT EXECUTE ON FUNCTION get_dashboard_data_weekly_with_freeze(text, text, text, text, boolean, int, int, int, int, text, text[], boolean) TO authenticated;

COMMIT;
