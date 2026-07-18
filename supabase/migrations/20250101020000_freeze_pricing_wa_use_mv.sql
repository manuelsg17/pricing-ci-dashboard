-- ════════════════════════════════════════════════════════════════════════
-- Migración 121 — freeze_pricing_wa: leer de la MV + dedup de la cascada de pesos
--
-- SÍNTOMA:
--   Al guardar los ajustes de InDrive (Config → Competidores → InDrive), el
--   handler llama `freeze_pricing_wa` para snapshotear los promedios ANTES de
--   que el trigger recompute los precios del bot. Fallaba con
--   "canceling statement due to statement timeout" (el browser llama el RPC como
--   `authenticated`, statement_timeout = 8s).
--
-- CAUSA (dos problemas, ambos corregidos aquí):
--   1) Leía de la VISTA regular `v_bracket_weekly_avg` (escanea pricing_observations
--      ~600k filas, con sorts a disco): ~25s por agregación.
--   2) La cascada de pesos (`weights_resolved`) tenía UNA fila por cada fila de
--      `per_bracket` (~12k), y el JOIN por (country,city,category,bracket) era
--      MUCHOS-A-MUCHOS (varias semanas/competidores comparten el mismo bracket) →
--      explosión cartesiana a ~1.4M filas y 1.4M ejecuciones de las subconsultas.
--      Medido: el bloque (b) tardaba ~20s SOLO por esto. Además la explosión
--      **distorsionaba el WA** (cada bracket se contaba K veces, K variable por
--      bracket) → el promedio ponderado frozen quedaba mal.
--
-- FIX:
--   1) Ambas agregaciones leen de la MV `v_bracket_weekly_avg_mv` (idéntica por
--      construcción; parity verificada). Seq scan ~75k filas: ~1.5s.
--   2) `weights_resolved` se resuelve UNA vez por (country,city,category,bracket)
--      DISTINTO (~200 combos), y el JOIN queda muchos-a-uno → sin explosión y con
--      el WA correcto. Medido: bloque (b) baja de ~20s a ~0.33s.
--   Total esperado: ~3-4s, cómodo bajo los 8s de `authenticated`.
--   Cuerpo idéntico al anterior salvo estos dos puntos. Idempotente (CREATE OR REPLACE).
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
  -- a) Promedios por bracket (mismo IS NOT NULL guard que mig 52) — desde la MV
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

  -- b) WA agregado con cascada por categoría — desde la MV, pesos deduplicados
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
  -- ★ CASCADA resuelta UNA vez por (country,city,category,bracket) DISTINTO
  --   (el peso no depende de year/week/competition) → join muchos-a-uno, sin explosión
  weights_resolved AS (
    SELECT
      d.country, d.city, d.category, d.bracket,
      COALESCE(
        -- (1) Match exacto: (country, city, category, bracket)
        (SELECT bw.weight FROM bracket_weights bw
          WHERE bw.country=d.country AND bw.city=d.city AND bw.category=d.category AND bw.bracket=d.bracket
          LIMIT 1),
        -- (2) Misma city, category='all'
        (SELECT bw.weight FROM bracket_weights bw
          WHERE bw.country=d.country AND bw.city=d.city AND bw.category='all' AND bw.bracket=d.bracket
          LIMIT 1),
        -- (3) city='all', category exacta
        (SELECT bw.weight FROM bracket_weights bw
          WHERE bw.country=d.country AND bw.city='all' AND bw.category=d.category AND bw.bracket=d.bracket
          LIMIT 1),
        -- (4) city='all', category='all'
        (SELECT bw.weight FROM bracket_weights bw
          WHERE bw.country=d.country AND bw.city='all' AND bw.category='all' AND bw.bracket=d.bracket
          LIMIT 1),
        -- (5) Defaults hardcoded (último recurso)
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
        SUM(CASE WHEN pb.avg_price > 1 THEN pb.avg_price * wr.weight ELSE 0 END)
        / NULLIF(SUM(CASE WHEN pb.avg_price > 1 THEN wr.weight ELSE 0 END), 0)::numeric,
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
