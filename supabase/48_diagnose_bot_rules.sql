-- ════════════════════════════════════════════════════════════════════════
-- Migración 48 — Función diagnóstica para entender qué emite el bot
--
-- PROBLEMA QUE RESUELVE:
--   El query directo a bot_quotes_remote desde el SQL editor de Supabase
--   timeoutea (FDW lenta + API gateway 60s). Esta función corre
--   server-side con statement_timeout=180s y devuelve solo el resumen
--   agregado, lo que evita transferir miles de filas.
--
-- USO:
--   SELECT * FROM diagnose_bot_rules_coverage('Colombia', 2);
--   → Lista cada (app, vc, ovc) que el bot emite, count, y si hay regla
--     activa que lo matchee. Las filas con matched='NO' son las que se
--     dropean en cada sync.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION diagnose_bot_rules_coverage(
  p_country text,
  p_days    int DEFAULT 2
) RETURNS TABLE (
  app                  text,
  vc                   text,
  ovc                  text,
  n_rows               bigint,
  pct_total            numeric,
  matched              text,
  matched_competition  text,
  matched_category     text,
  matched_cities       text[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET statement_timeout = '180s'
AS $$
DECLARE
  v_total bigint;
BEGIN
  -- Total rows en el período para calcular %
  SELECT count(*) INTO v_total
  FROM bot_quotes_remote
  WHERE country = p_country
    AND lower(business_unit) = 'ridehailing'
    AND timestamp_utc > NOW() - (p_days || ' days')::interval;

  RETURN QUERY
  WITH source AS (
    SELECT
      lower(coalesce(s.app, ''))                       AS app,
      lower(coalesce(s.vehicle_category, ''))          AS vc,
      lower(coalesce(s.observed_vehicle_category, '')) AS ovc
    FROM bot_quotes_remote s
    WHERE s.country = p_country
      AND lower(s.business_unit) = 'ridehailing'
      AND s.timestamp_utc > NOW() - (p_days || ' days')::interval
  ),
  agg AS (
    SELECT s.app, s.vc, s.ovc, count(*) AS n_rows
    FROM source s
    GROUP BY 1, 2, 3
  )
  SELECT
    a.app, a.vc, a.ovc, a.n_rows,
    ROUND((100.0 * a.n_rows / NULLIF(v_total, 0))::numeric, 1) AS pct_total,
    CASE WHEN br.id IS NOT NULL THEN 'YES' ELSE 'NO' END AS matched,
    br.competition_name AS matched_competition,
    br.category         AS matched_category,
    br.cities           AS matched_cities
  FROM agg a
  LEFT JOIN bot_rules br
    ON br.country = p_country
   AND br.active
   AND br.app    = a.app
   AND br.vc     = a.vc
   AND (br.ovc = '*' OR br.ovc = a.ovc)
  ORDER BY a.n_rows DESC;
END;
$$;

COMMENT ON FUNCTION diagnose_bot_rules_coverage(text, int) IS
  'Devuelve cada combinación (app, vc, ovc) que el bot emite para un país en los últimos N días, con info de si hay regla activa que la matchee. Útil para ajustar bot_rules cuando el dropped_count es alto.';

GRANT EXECUTE ON FUNCTION diagnose_bot_rules_coverage(text, int) TO authenticated;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- USAR ASÍ:
--
--   SELECT * FROM diagnose_bot_rules_coverage('Colombia', 2);
--
-- Lo que vas a ver (ejemplo):
--   app       | vc       | ovc       | n_rows | pct  | matched | comp    | cat
--   didi      | economy  | express   | 2500   | 28.0 | YES     | Didi    | Economy
--   didi      | comfort  | comfort   | 2000   | 22.4 | YES     | Didi    | Comfort
--   didi      | moto     | bike      | 1500   | 16.8 | YES     | Didi    | Bike
--   yango     | yango_moto | *       | 800    | 9.0  | NO      | (null)  | (null)   ← no matchea
--   indrive   | bike     | (empty)   | 600    | 6.7  | NO      | (null)  | (null)   ← no matchea
--   picap     | moto_a   | clasico   | 500    | 5.6  | NO      | (null)  | (null)   ← no matchea
--   ...
--
-- Las filas con matched='NO' son las que se están dropeando.
-- Mandame el output y armamos un patch de bot_rules en 30 segundos.
-- ════════════════════════════════════════════════════════════════════════
