-- ════════════════════════════════════════════════════════════════════════
-- Migración 250 — freeze_pricing_wa respeta el corte Ponderado→Simple
--                 (2026-W25) que el cliente ya aplica en vivo.
--
-- POR QUÉ:
--   Auditoría 2026-09-12. `src/algorithms/weightedAverage.js` decidió en
--   jul-2026 (SIMPLE_AVG_SINCE = {year:2026, week:25}) que el WA en vivo
--   pasa de Promedio Ponderado a Promedio Simple desde la semana ISO 2026-
--   W25 en adelante, para TODOS los países — ver `computePeriodAvg`, único
--   punto que decide simple vs ponderado en el cliente.
--   La función SQL `freeze_pricing_wa` (verificada con
--   `pg_get_functiondef` contra prod, no contra un archivo de migración
--   viejo — regla de este repo) nunca se enteró de ese corte: sigue
--   calculando SIEMPRE ponderado
--   (`SUM(avg_price*weight)/SUM(weight)`), sin importar la semana.
--
--   Hoy es un bug LATENTE, no activo: `pricing_wa_frozen` tiene 0 filas en
--   producción (nadie usó el botón "Guardar con snapshot" todavía). Pero en
--   cuanto se congele una semana >= 2026-W25, el snapshot guardaría un
--   número PONDERADO mientras el dashboard en vivo sigue mostrando el
--   SIMPLE para esa misma semana — el snapshot "mentiría" respecto de lo
--   que se veía en pantalla al momento de congelarlo, que es justo lo que
--   un snapshot existe para evitar.
--
-- LA REGLA (idéntica a computePeriodAvg, solo trasladada a SQL):
--   year > 2026, o (year = 2026 y week >= 25)  → PROMEDIO SIMPLE
--     (media aritmética de los brackets con avg_price > 1, sin pesos)
--   cualquier otro caso                        → PROMEDIO PONDERADO
--     (cascada de bracket_weights sin cambios, igual que antes)
--
--   Nota: la comparación de semana/año se hace en el propio SELECT (CASE a
--   nivel de grupo, pb.year/pb.week ya son columnas del GROUP BY) — no hace
--   falta un JOIN nuevo ni tocar el resto de la función.
--
-- VERIFICACIÓN (local, antes de aplicar a prod):
--   scripts/simulate-freeze-pricing-wa-corte.sql reproduce 2 semanas
--   sintéticas (una <2026-W25 ponderada, otra >=2026-W25 simple) con pesos
--   deliberadamente desiguales para que ponderado y simple den números
--   DISTINTOS y detectables, y confirma que freeze_pricing_wa elige la
--   fórmula correcta en cada una — antes y después de este fix.
-- ════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.freeze_pricing_wa(p_country text, p_label text DEFAULT NULL::text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  cnt bigint := 0;
BEGIN
  IF NOT can_access_section('config') THEN
    RAISE EXCEPTION 'access_denied: congelar promedios requiere la sección Configuración'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM require_country_access(p_country);

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
  FROM v_bracket_weekly_avg_mv v
  WHERE v.country          = p_country
    AND v.country          IS NOT NULL
    AND v.city             IS NOT NULL
    AND v.category         IS NOT NULL
    AND v.competition_name IS NOT NULL
    AND v.distance_bracket IS NOT NULL
  GROUP BY v.country, v.city, v.category, v.year, v.week,
           v.competition_name, v.distance_bracket
  ON CONFLICT (country, city, category, year, week, competition_name, distance_bracket)
  DO NOTHING;

  GET DIAGNOSTICS cnt = ROW_COUNT;

  INSERT INTO pricing_wa_frozen (
    country, city, category, year, week,
    competition_name, distance_bracket,
    avg_price, observation_count, frozen_label
  )
  WITH per_bracket AS (
    SELECT
      v.country, v.city, v.category, v.year, v.week,
      v.competition_name, v.distance_bracket,
      SUM(v.avg_price * v.observation_count) / NULLIF(SUM(v.observation_count), 0) AS avg_price,
      SUM(v.observation_count) AS total_count
    FROM v_bracket_weekly_avg_mv v
    WHERE v.country          = p_country
      AND v.country          IS NOT NULL
      AND v.city             IS NOT NULL
      AND v.category         IS NOT NULL
      AND v.competition_name IS NOT NULL
      AND v.distance_bracket IS NOT NULL
    GROUP BY v.country, v.city, v.category, v.year, v.week,
             v.competition_name, v.distance_bracket
  ),
  weights_resolved AS (
    SELECT
      d.country, d.city, d.category, d.bracket,
      COALESCE(
        (SELECT bw.weight FROM bracket_weights bw
          WHERE bw.country=d.country AND bw.city=d.city AND bw.category=d.category AND bw.bracket=d.bracket
          LIMIT 1),
        (SELECT bw.weight FROM bracket_weights bw
          WHERE bw.country=d.country AND bw.city=d.city AND bw.category='all' AND bw.bracket=d.bracket
          LIMIT 1),
        (SELECT bw.weight FROM bracket_weights bw
          WHERE bw.country=d.country AND bw.city='all' AND bw.category=d.category AND bw.bracket=d.bracket
          LIMIT 1),
        (SELECT bw.weight FROM bracket_weights bw
          WHERE bw.country=d.country AND bw.city='all' AND bw.category='all' AND bw.bracket=d.bracket
          LIMIT 1),
        CASE d.bracket
          WHEN 'very_short' THEN 0.0983
          WHEN 'short'      THEN 0.1967
          WHEN 'median'     THEN 0.1939
          WHEN 'average'    THEN 0.1384
          WHEN 'long'       THEN 0.0750
          WHEN 'very_long'  THEN 0.2970
          ELSE 0
        END
      ) AS weight
    FROM (
      SELECT DISTINCT country, city, category, distance_bracket AS bracket
      FROM per_bracket
    ) d
  ),
  wa_rows AS (
    SELECT
      pb.country, pb.city, pb.category, pb.year, pb.week,
      pb.competition_name,
      '_wa' AS distance_bracket,
      ROUND(
        -- Mismo corte que computePeriodAvg (src/algorithms/weightedAverage.js):
        -- semana ISO >= 2026-W25 → promedio SIMPLE; antes → PONDERADO.
        (CASE
          WHEN (pb.year > 2026) OR (pb.year = 2026 AND pb.week >= 25) THEN
            AVG(CASE WHEN pb.avg_price > 1 THEN pb.avg_price END)
          ELSE
            SUM(CASE WHEN pb.avg_price > 1 THEN pb.avg_price * wr.weight ELSE 0 END)
            / NULLIF(SUM(CASE WHEN pb.avg_price > 1 THEN wr.weight ELSE 0 END), 0)
        END)::numeric,
        2
      ) AS avg_price,
      SUM(pb.total_count) AS observation_count
    FROM per_bracket pb
    JOIN weights_resolved wr
      ON wr.country  = pb.country
     AND wr.city     = pb.city
     AND wr.category = pb.category
     AND wr.bracket  = pb.distance_bracket
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
$function$;
