-- ============================================================
-- RPC: get_indrive_analysis()
-- Agrega bids vs precio recomendado para datos manuales de InDrive.
-- Retorna una fila por ciudad+categoría (y opcionalmente por semana).
-- Evita traer miles de filas al cliente.
-- ============================================================

-- Vista summary: por ciudad + categoría
CREATE OR REPLACE FUNCTION get_indrive_summary(
  outlier_threshold numeric DEFAULT 100
)
RETURNS TABLE (
  city            text,
  category        text,
  obs_with_bids   bigint,
  outlier_recs    bigint,
  avg_rec         numeric,
  min_rec         numeric,
  max_rec         numeric,
  avg_bid         numeric
)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  WITH bid_proxy AS (
    SELECT
      city,
      category,
      recommended_price,
      -- Proxy de bid: bid individual promedio → price_without_discount → minimal_bid
      CASE
        WHEN COALESCE(bid_1,0) > 0 OR COALESCE(bid_2,0) > 0 OR COALESCE(bid_3,0) > 0
          OR COALESCE(bid_4,0) > 0 OR COALESCE(bid_5,0) > 0
        THEN (
          SELECT AVG(v) FROM UNNEST(ARRAY[
            NULLIF(bid_1,0), NULLIF(bid_2,0), NULLIF(bid_3,0),
            NULLIF(bid_4,0), NULLIF(bid_5,0)
          ]) t(v) WHERE v IS NOT NULL
        )
        WHEN price_without_discount > 0 THEN price_without_discount
        WHEN minimal_bid > 0 THEN minimal_bid
        ELSE NULL
      END AS bid_avg
    FROM pricing_observations
    WHERE competition_name = 'InDrive'
      AND data_source = 'manual'
  ),
  with_bids AS (
    SELECT * FROM bid_proxy WHERE bid_avg IS NOT NULL
  )
  SELECT
    city,
    category,
    COUNT(*)                                                              AS obs_with_bids,
    COUNT(*) FILTER (WHERE recommended_price > outlier_threshold)        AS outlier_recs,
    ROUND(AVG(recommended_price) FILTER (WHERE recommended_price > 0
      AND recommended_price <= outlier_threshold), 2)                    AS avg_rec,
    ROUND(MIN(recommended_price) FILTER (WHERE recommended_price > 0
      AND recommended_price <= outlier_threshold), 2)                    AS min_rec,
    ROUND(MAX(recommended_price) FILTER (WHERE recommended_price > 0
      AND recommended_price <= outlier_threshold), 2)                    AS max_rec,
    ROUND(AVG(bid_avg), 2)                                               AS avg_bid
  FROM with_bids
  GROUP BY city, category
  ORDER BY city, category
$$;

-- Vista semanal: por ciudad + categoría + semana ISO
CREATE OR REPLACE FUNCTION get_indrive_weekly(
  outlier_threshold numeric DEFAULT 100
)
RETURNS TABLE (
  city      text,
  category  text,
  week      text,
  obs       bigint,
  avg_rec   numeric,
  avg_bid   numeric
)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  WITH bid_proxy AS (
    SELECT
      city,
      category,
      observed_date,
      TO_CHAR(
        DATE_TRUNC('week', observed_date::date + INTERVAL '1 day') - INTERVAL '1 day',
        'IYYY"-W"IW'
      ) AS iso_week,
      recommended_price,
      CASE
        WHEN COALESCE(bid_1,0) > 0 OR COALESCE(bid_2,0) > 0 OR COALESCE(bid_3,0) > 0
          OR COALESCE(bid_4,0) > 0 OR COALESCE(bid_5,0) > 0
        THEN (
          SELECT AVG(v) FROM UNNEST(ARRAY[
            NULLIF(bid_1,0), NULLIF(bid_2,0), NULLIF(bid_3,0),
            NULLIF(bid_4,0), NULLIF(bid_5,0)
          ]) t(v) WHERE v IS NOT NULL
        )
        WHEN price_without_discount > 0 THEN price_without_discount
        WHEN minimal_bid > 0 THEN minimal_bid
        ELSE NULL
      END AS bid_avg
    FROM pricing_observations
    WHERE competition_name = 'InDrive'
      AND data_source = 'manual'
  ),
  with_bids AS (
    SELECT * FROM bid_proxy WHERE bid_avg IS NOT NULL
  )
  SELECT
    city,
    category,
    iso_week                                                             AS week,
    COUNT(*)                                                             AS obs,
    ROUND(AVG(recommended_price) FILTER (WHERE recommended_price > 0
      AND recommended_price <= outlier_threshold), 2)                   AS avg_rec,
    ROUND(AVG(bid_avg), 2)                                              AS avg_bid
  FROM with_bids
  GROUP BY city, category, iso_week
  ORDER BY city, category, iso_week DESC
$$;

-- También: conteo total de filas InDrive manual en BD (para el diagnóstico)
CREATE OR REPLACE FUNCTION get_indrive_counts()
RETURNS TABLE (total_rows bigint, rows_with_bids bigint)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT
    COUNT(*) AS total_rows,
    COUNT(*) FILTER (
      WHERE COALESCE(bid_1,0) > 0 OR COALESCE(bid_2,0) > 0 OR COALESCE(bid_3,0) > 0
         OR COALESCE(bid_4,0) > 0 OR COALESCE(bid_5,0) > 0
         OR COALESCE(price_without_discount,0) > 0
         OR COALESCE(minimal_bid,0) > 0
    ) AS rows_with_bids
  FROM pricing_observations
  WHERE competition_name = 'InDrive'
    AND data_source = 'manual'
$$;

-- Permisos
GRANT EXECUTE ON FUNCTION get_indrive_summary(numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION get_indrive_weekly(numeric)  TO authenticated;
GRANT EXECUTE ON FUNCTION get_indrive_counts()         TO authenticated;
