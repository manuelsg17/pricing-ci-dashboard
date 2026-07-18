-- ════════════════════════════════════════════════════════════════════════
-- Migración 44 — RPCs para la pestaña Análisis > Mercado
--
-- POR QUÉ:
--   Los componentes Heatmap, RushVsValley y DiscountIntensity necesitan
--   agregar 50K+ filas de pricing_observations. Hacerlo en el cliente
--   (SELECT crudo) topa con el cap de respuesta de PostgREST y devuelve
--   solo ~1000 filas, dejando celdas vacías. Estas RPCs corren la
--   agregación server-side y devuelven pocas filas listas para renderizar.
--
-- FUNCIONES:
--   • get_heatmap_dow_tod(country, city, category, start_date, end_date)
--       → (competition_name, dow, time_of_day, avg_price, n)
--   • get_rush_valley_stats(country, city, category, start_date, end_date)
--       → (competition_name, rush_avg, rush_n, valley_avg, valley_n)
--   • get_discount_stats(country, city, category, start_date, end_date)
--       → (competition_name, list_avg, final_avg, with_discount, n_total)
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- Para todos los apps, el "precio efectivo" (sin surge) es:
--   InDrive  → recommended_price (precio sugerido al pasajero)
--   Otros    → price_without_discount
-- Se filtran filas sin precio o con precio inválido.

-- ── 1. Heatmap día × hora ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION get_heatmap_dow_tod(
  p_country     text,
  p_city        text,
  p_category    text,
  p_start_date  date,
  p_end_date    date
) RETURNS TABLE (
  competition_name text,
  dow              int,
  time_of_day      text,
  avg_price        numeric,
  n                bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    competition_name,
    EXTRACT(isodow FROM observed_date)::int AS dow,
    time_of_day,
    AVG(CASE
      WHEN competition_name = 'InDrive' THEN recommended_price
      ELSE price_without_discount
    END)::numeric(10,2)                      AS avg_price,
    COUNT(*)                                 AS n
  FROM pricing_observations
  WHERE country  = p_country
    AND city     = p_city
    AND category = p_category
    AND observed_date BETWEEN p_start_date AND p_end_date
    AND time_of_day IS NOT NULL
    AND (
      (competition_name = 'InDrive' AND recommended_price IS NOT NULL AND recommended_price > 0)
      OR (competition_name <> 'InDrive' AND price_without_discount IS NOT NULL AND price_without_discount > 0)
    )
  GROUP BY competition_name, dow, time_of_day;
$$;

GRANT EXECUTE ON FUNCTION get_heatmap_dow_tod(text, text, text, date, date) TO authenticated;


-- ── 2. Rush vs Valley ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION get_rush_valley_stats(
  p_country     text,
  p_city        text,
  p_category    text,
  p_start_date  date,
  p_end_date    date
) RETURNS TABLE (
  competition_name text,
  rush_avg         numeric,
  rush_n           bigint,
  valley_avg       numeric,
  valley_n         bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH base AS (
    SELECT
      competition_name,
      rush_hour,
      CASE
        WHEN competition_name = 'InDrive' THEN recommended_price
        ELSE price_without_discount
      END AS price
    FROM pricing_observations
    WHERE country  = p_country
      AND city     = p_city
      AND category = p_category
      AND observed_date BETWEEN p_start_date AND p_end_date
      AND rush_hour IS NOT NULL
  ),
  filtered AS (
    SELECT * FROM base WHERE price IS NOT NULL AND price > 0
  )
  SELECT
    competition_name,
    AVG(price) FILTER (WHERE rush_hour = true)::numeric(10,2)  AS rush_avg,
    COUNT(*)   FILTER (WHERE rush_hour = true)                  AS rush_n,
    AVG(price) FILTER (WHERE rush_hour = false)::numeric(10,2) AS valley_avg,
    COUNT(*)   FILTER (WHERE rush_hour = false)                 AS valley_n
  FROM filtered
  GROUP BY competition_name;
$$;

GRANT EXECUTE ON FUNCTION get_rush_valley_stats(text, text, text, date, date) TO authenticated;


-- ── 3. Discount intensity ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION get_discount_stats(
  p_country     text,
  p_city        text,
  p_category    text,
  p_start_date  date,
  p_end_date    date
) RETURNS TABLE (
  competition_name text,
  list_avg         numeric,
  final_avg        numeric,
  with_discount    bigint,
  n_total          bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH paired AS (
    SELECT
      competition_name,
      CASE
        WHEN competition_name = 'InDrive' THEN recommended_price
        ELSE price_without_discount
      END AS list_price,
      CASE
        WHEN competition_name = 'InDrive' THEN minimal_bid
        ELSE price_with_discount
      END AS final_price
    FROM pricing_observations
    WHERE country  = p_country
      AND city     = p_city
      AND category = p_category
      AND observed_date BETWEEN p_start_date AND p_end_date
  ),
  filtered AS (
    SELECT * FROM paired
    WHERE list_price IS NOT NULL AND list_price > 0
      AND final_price IS NOT NULL AND final_price > 0
  )
  SELECT
    competition_name,
    AVG(list_price)::numeric(10,2)                                          AS list_avg,
    AVG(final_price)::numeric(10,2)                                         AS final_avg,
    COUNT(*) FILTER (WHERE final_price < list_price * 0.99)                  AS with_discount,
    COUNT(*)                                                                 AS n_total
  FROM filtered
  GROUP BY competition_name;
$$;

GRANT EXECUTE ON FUNCTION get_discount_stats(text, text, text, date, date) TO authenticated;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- Para verificar después de aplicar:
--
-- SELECT * FROM get_heatmap_dow_tod('Peru', 'Lima', 'Economy/Comfort',
--   CURRENT_DATE - 56, CURRENT_DATE);
--
-- SELECT * FROM get_rush_valley_stats('Peru', 'Lima', 'Economy/Comfort',
--   CURRENT_DATE - 56, CURRENT_DATE);
--
-- SELECT * FROM get_discount_stats('Peru', 'Lima', 'Economy/Comfort',
--   CURRENT_DATE - 56, CURRENT_DATE);
-- ════════════════════════════════════════════════════════════════════════
