-- ════════════════════════════════════════════════════════════════════════
-- Migración 108 — get_bot_vs_hubs_summary lee de MV dedicada (fix timeout 8s)
--
-- CONTEXTO (bug del smoke test del cutover Mig 105):
--   get_bot_vs_hubs_summary(p_country) agregaba TODA la historia de
--   pricing_observations (data_source IN ('bot','manual'), sin filtro de
--   fecha) por city/category/competition_name/data_source. Medido ~13.5s
--   (full scan ~73k páginas) para devolver ~132 filas → excede el
--   statement_timeout=8s del rol authenticated → 500 en "Bot vs Hubs".
--
-- APPROACH:
--   MV dedicada v_bot_vs_manual_mv que materializa la agregación EXACTA del
--   RPC (mismo COALESCE de precio: price_without_discount → price_with_discount
--   → recommended_price). El RPC se reescribe para leer de la MV (~264 filas)
--   y pivotear bot/manual → ms. Semántica idéntica al RPC original.
--   La MV se suma a refresh_dashboard_mv() para que el cron horario (mig 106)
--   la mantenga fresca junto a las MVs del dashboard.
--
-- VERIFICACIÓN:
--   EXPLAIN ANALYZE SELECT * FROM get_bot_vs_hubs_summary('Peru');  -- ms (antes ~13.5s)
--   SELECT * FROM cron.job WHERE jobname='refresh-dashboard-mv';     -- ya programado (mig 106)
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── A) MV dedicada: agregación bot/manual exacta ────────────────────────
DROP MATERIALIZED VIEW IF EXISTS v_bot_vs_manual_mv CASCADE;

CREATE MATERIALIZED VIEW v_bot_vs_manual_mv AS
SELECT
  po.country,
  po.city,
  po.category,
  po.competition_name,
  po.data_source,
  COUNT(*) AS cnt,
  AVG(COALESCE(po.price_without_discount, po.price_with_discount, po.recommended_price))::numeric(10,2) AS avg_price
FROM pricing_observations po
WHERE po.data_source IN ('bot', 'manual')
GROUP BY po.country, po.city, po.category, po.competition_name, po.data_source;

-- UNIQUE index (requerido para REFRESH ... CONCURRENTLY). NULLS NOT DISTINCT
-- (PG15+) por si category/competition_name vienen NULL en algún registro.
CREATE UNIQUE INDEX idx_bvm_mv_unique
  ON v_bot_vs_manual_mv (country, city, category, competition_name, data_source)
  NULLS NOT DISTINCT;

-- ── B) RPC reescrito: lee de la MV, pivotea bot/manual ──────────────────
CREATE OR REPLACE FUNCTION public.get_bot_vs_hubs_summary(p_country text)
 RETURNS TABLE(city text, category text, competition_name text, bot_count bigint, manual_count bigint, bot_avg_price numeric, manual_avg_price numeric, price_delta_pct numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM require_country_access(p_country);
  RETURN QUERY
  SELECT
    v.city,
    v.category,
    v.competition_name,
    COALESCE(MAX(CASE WHEN v.data_source='bot'    THEN v.cnt END), 0) AS bot_count,
    COALESCE(MAX(CASE WHEN v.data_source='manual' THEN v.cnt END), 0) AS manual_count,
    MAX(CASE WHEN v.data_source='bot'    THEN v.avg_price END)        AS bot_avg_price,
    MAX(CASE WHEN v.data_source='manual' THEN v.avg_price END)        AS manual_avg_price,
    CASE
      WHEN MAX(CASE WHEN v.data_source='manual' THEN v.avg_price END) > 0 THEN
        ROUND(((MAX(CASE WHEN v.data_source='bot'    THEN v.avg_price END)
              / MAX(CASE WHEN v.data_source='manual' THEN v.avg_price END)) - 1) * 100, 2)
      ELSE NULL
    END                                                              AS price_delta_pct
  FROM v_bot_vs_manual_mv v
  WHERE v.country = p_country
  GROUP BY v.city, v.category, v.competition_name
  ORDER BY v.city, v.category, v.competition_name;
END;
$function$;

-- ── C) Sumar la MV al refresh horario (cron mig 106) ────────────────────
CREATE OR REPLACE FUNCTION public.refresh_dashboard_mv()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  t_start    timestamptz := clock_timestamp();
  weekly_ms  numeric;
  daily_ms   numeric;
  botmv_ms   numeric;
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY v_bracket_weekly_avg_mv;
  weekly_ms := EXTRACT(EPOCH FROM (clock_timestamp() - t_start)) * 1000;

  t_start := clock_timestamp();
  REFRESH MATERIALIZED VIEW CONCURRENTLY v_bracket_daily_avg_mv;
  daily_ms := EXTRACT(EPOCH FROM (clock_timestamp() - t_start)) * 1000;

  t_start := clock_timestamp();
  REFRESH MATERIALIZED VIEW CONCURRENTLY v_bot_vs_manual_mv;
  botmv_ms := EXTRACT(EPOCH FROM (clock_timestamp() - t_start)) * 1000;

  RETURN jsonb_build_object(
    'weekly_ms', weekly_ms,
    'daily_ms',  daily_ms,
    'bot_vs_manual_ms', botmv_ms,
    'refreshed_at', now()
  );
END;
$function$;

COMMIT;
