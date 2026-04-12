-- ============================================================
-- Backfill: minimal_bid y price_without_discount desde bids
-- Aplica solo a filas InDrive manuales donde esos campos están
-- en 0 o NULL pero los bids individuales (bid_1..bid_5) tienen valores.
-- Causa: fórmulas de Excel no evaluadas al subir.
-- ============================================================

-- Paso 1: Corregir minimal_bid = MIN(bid_1..bid_5)
UPDATE pricing_observations
SET minimal_bid = LEAST(
  NULLIF(bid_1, 0),
  NULLIF(bid_2, 0),
  NULLIF(bid_3, 0),
  NULLIF(bid_4, 0),
  NULLIF(bid_5, 0)
)
WHERE competition_name = 'InDrive'
  AND data_source = 'manual'
  AND (minimal_bid IS NULL OR minimal_bid = 0)
  AND (COALESCE(bid_1,0) > 0 OR COALESCE(bid_2,0) > 0 OR COALESCE(bid_3,0) > 0
       OR COALESCE(bid_4,0) > 0 OR COALESCE(bid_5,0) > 0);

-- Paso 2: Corregir price_without_discount = AVG(bid_1..bid_5 + minimal_bid)
-- Equivalente a DataEntry.calcIndriveAvg(bids, minBid)
UPDATE pricing_observations
SET price_without_discount = (
  SELECT ROUND(AVG(v)::numeric, 2)
  FROM UNNEST(ARRAY[
    NULLIF(bid_1, 0),
    NULLIF(bid_2, 0),
    NULLIF(bid_3, 0),
    NULLIF(bid_4, 0),
    NULLIF(bid_5, 0),
    NULLIF(minimal_bid, 0)
  ]) AS t(v)
  WHERE v IS NOT NULL
)
WHERE competition_name = 'InDrive'
  AND data_source = 'manual'
  AND (price_without_discount IS NULL OR price_without_discount = 0)
  AND (COALESCE(bid_1,0) > 0 OR COALESCE(bid_2,0) > 0 OR COALESCE(bid_3,0) > 0
       OR COALESCE(bid_4,0) > 0 OR COALESCE(bid_5,0) > 0);

-- Verificación: ver filas afectadas por ciudad y categoría
SELECT city, category, COUNT(*) AS filas,
       AVG(minimal_bid) AS avg_min_bid,
       AVG(price_without_discount) AS avg_pwo_disc
FROM pricing_observations
WHERE competition_name = 'InDrive' AND data_source = 'manual'
GROUP BY city, category
ORDER BY city, category;
