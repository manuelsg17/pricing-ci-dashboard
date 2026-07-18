-- ============================================================
-- Migration 20: RPC para comparativa Bot vs Hubs
-- Devuelve precio efectivo promedio y conteo por
-- ciudad / categoría / competidor / fuente de datos
-- ============================================================

CREATE OR REPLACE FUNCTION get_bot_vs_hubs_summary(p_country text DEFAULT 'Peru')
RETURNS TABLE(
  city             text,
  category         text,
  competition_name text,
  data_source      text,
  obs_count        bigint,
  avg_effective    numeric
) LANGUAGE sql STABLE AS $$
  SELECT
    city,
    category,
    competition_name,
    data_source,
    COUNT(*)::bigint AS obs_count,
    ROUND(
      AVG(
        CASE
          -- InDrive con bids: promedio de bids no-cero
          WHEN competition_name = 'InDrive'
               AND (  COALESCE(bid_1,0) + COALESCE(bid_2,0) + COALESCE(bid_3,0)
                    + COALESCE(bid_4,0) + COALESCE(bid_5,0)) > 0
          THEN (
              COALESCE(NULLIF(bid_1,0),0) + COALESCE(NULLIF(bid_2,0),0)
            + COALESCE(NULLIF(bid_3,0),0) + COALESCE(NULLIF(bid_4,0),0)
            + COALESCE(NULLIF(bid_5,0),0)
          )::numeric / NULLIF(
              (CASE WHEN COALESCE(bid_1,0)>0 THEN 1 ELSE 0 END
             + CASE WHEN COALESCE(bid_2,0)>0 THEN 1 ELSE 0 END
             + CASE WHEN COALESCE(bid_3,0)>0 THEN 1 ELSE 0 END
             + CASE WHEN COALESCE(bid_4,0)>0 THEN 1 ELSE 0 END
             + CASE WHEN COALESCE(bid_5,0)>0 THEN 1 ELSE 0 END), 0)
          -- InDrive sin bids: precio recomendado
          WHEN competition_name = 'InDrive'
          THEN recommended_price
          -- Resto: precio con descuento si existe, sino sin descuento
          ELSE COALESCE(NULLIF(price_with_discount, 0), price_without_discount)
        END
      )::numeric, 2
    ) AS avg_effective
  FROM pricing_observations
  WHERE (p_country IS NULL OR country = p_country)
    AND data_source IN ('manual', 'bot')
    AND competition_name IS NOT NULL
  GROUP BY city, category, competition_name, data_source
  ORDER BY city, category, competition_name, data_source;
$$;
