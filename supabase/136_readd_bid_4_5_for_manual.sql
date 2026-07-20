-- ════════════════════════════════════════════════════════════════════════
-- Migración 136 — Re-agregar bid_4/bid_5 para captura manual de 5 bids InDrive
--
-- CONTEXTO 2026-07-20:
--   Los Hub Experts cargan la CI de InDrive en "Ingresar CI". InDrive muestra
--   varias ofertas de conductores ("bids") por viaje; el precio efectivo que
--   usamos es el PROMEDIO de esos bids (el "mínimo" es solo referencia y NUNCA
--   entra al promedio). Hasta ahora el form topaba en 3 bids porque mig 98
--   había dropeado bid_4/bid_5 — en ese momento eran >99% NULL y la DB estaba
--   pegada al límite free de 500 MB. Hoy la DB corre en plan pago (~1.2 GB),
--   así que esa presión ya no existe, y los hubs necesitan cargar hasta 5 bids
--   y que los 5 cuenten para el promedio de punta a punta (form → BD →
--   dashboard).
--
-- QUÉ HACE:
--   A) Re-agrega bid_4/bid_5 (nullable) a pricing_observations.
--   B) Extiende v_effective_price para promediar bid_1..bid_5 de InDrive.
--   C) Extiende las RPCs de análisis InDrive (summary / weekly / counts).
--
-- COSTO DE STORAGE: ADD COLUMN nullable en Postgres es metadata-only — no
-- reescribe la tabla ni ocupa espacio hasta que se escribe un valor. Las
-- filas históricas quedan con bid_4/bid_5 = NULL, y como NULL suma 0 tanto al
-- numerador como a la cuenta de bids, v_effective_price da EXACTAMENTE el mismo
-- número que hoy para ellas. 100% backward-compatible: no cambia ningún valor
-- histórico del dashboard.
--
-- ⚠ POST-MORTEM mig 98→99: NO usar DROP ... CASCADE acá. Este script usa
-- CREATE OR REPLACE VIEW manteniendo EXACTAMENTE las mismas columnas de salida
-- de v_effective_price (solo cambia la expresión interna del CASE de InDrive),
-- así los materialized views que leen effective_price
-- (v_bracket_weekly_avg_mv / v_bracket_daily_avg_mv) siguen intactos y no hace
-- falta recrearlos.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── (A) Re-agregar columnas (nullable, metadata-only) ──────────────────
ALTER TABLE pricing_observations
  ADD COLUMN IF NOT EXISTS bid_4 numeric,
  ADD COLUMN IF NOT EXISTS bid_5 numeric;

-- ── (B) v_effective_price: promedio de bid_1..bid_5 para InDrive ───────
-- Mismas columnas de salida que mig 99 (solo cambia el cálculo del CASE) →
-- CREATE OR REPLACE no rompe las vistas/MV dependientes.
CREATE OR REPLACE VIEW v_effective_price AS
SELECT
  id,
  country,
  city,
  year,
  week,
  observed_date,
  observed_time,
  time_of_day,
  category,
  zone,
  competition_name,
  distance_km,
  distance_bracket,
  surge,
  rush_hour,
  timeslot,
  data_source,
  upload_batch_id,
  CASE
    WHEN competition_name = 'InDrive'
         AND (COALESCE(bid_1,0) + COALESCE(bid_2,0) + COALESCE(bid_3,0)
              + COALESCE(bid_4,0) + COALESCE(bid_5,0)) > 0
    THEN (
      COALESCE(NULLIF(bid_1, 0), 0) +
      COALESCE(NULLIF(bid_2, 0), 0) +
      COALESCE(NULLIF(bid_3, 0), 0) +
      COALESCE(NULLIF(bid_4, 0), 0) +
      COALESCE(NULLIF(bid_5, 0), 0)
    )::numeric / NULLIF(
      (CASE WHEN COALESCE(bid_1,0) > 0 THEN 1 ELSE 0 END +
       CASE WHEN COALESCE(bid_2,0) > 0 THEN 1 ELSE 0 END +
       CASE WHEN COALESCE(bid_3,0) > 0 THEN 1 ELSE 0 END +
       CASE WHEN COALESCE(bid_4,0) > 0 THEN 1 ELSE 0 END +
       CASE WHEN COALESCE(bid_5,0) > 0 THEN 1 ELSE 0 END), 0)
    ELSE COALESCE(price_without_discount, recommended_price)
  END AS effective_price
FROM pricing_observations;

-- ── (C) RPCs de análisis InDrive: promediar/contar bid_1..bid_5 ────────

-- get_indrive_counts: rows_with_bids ahora también cuenta bid_4/bid_5.
CREATE OR REPLACE FUNCTION public.get_indrive_counts(p_country text)
 RETURNS TABLE(total_rows bigint, rows_with_bids bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM require_country_access(p_country);
  RETURN QUERY
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
    AND country = p_country;
END;
$function$;

-- get_indrive_summary: bid_avg promedia bid_1..bid_5.
CREATE OR REPLACE FUNCTION public.get_indrive_summary(p_country text, outlier_threshold numeric DEFAULT 100)
 RETURNS TABLE(city text, category text, obs_with_bids bigint, outlier_recs bigint, avg_rec numeric, min_rec numeric, max_rec numeric, avg_bid numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM require_country_access(p_country);
  RETURN QUERY
  WITH bid_proxy AS (
    SELECT
      po.city,
      po.category,
      po.recommended_price,
      CASE
        WHEN COALESCE(po.bid_1,0) > 0 OR COALESCE(po.bid_2,0) > 0 OR COALESCE(po.bid_3,0) > 0
          OR COALESCE(po.bid_4,0) > 0 OR COALESCE(po.bid_5,0) > 0
        THEN (
          SELECT AVG(v) FROM UNNEST(ARRAY[
            NULLIF(po.bid_1,0), NULLIF(po.bid_2,0), NULLIF(po.bid_3,0),
            NULLIF(po.bid_4,0), NULLIF(po.bid_5,0)
          ]) t(v) WHERE v IS NOT NULL
        )
        WHEN po.price_without_discount > 0 THEN po.price_without_discount
        WHEN po.minimal_bid > 0            THEN po.minimal_bid
        ELSE NULL
      END AS bid_avg
    FROM pricing_observations po
    WHERE po.competition_name = 'InDrive'
      AND po.data_source = 'manual'
      AND po.country = p_country
  ),
  with_bids AS (SELECT * FROM bid_proxy WHERE bid_avg IS NOT NULL)
  SELECT
    wb.city,
    wb.category,
    COUNT(*)                                                              AS obs_with_bids,
    COUNT(*) FILTER (WHERE wb.recommended_price > outlier_threshold)      AS outlier_recs,
    ROUND(AVG(wb.recommended_price) FILTER (WHERE wb.recommended_price > 0
      AND wb.recommended_price <= outlier_threshold), 2)                  AS avg_rec,
    ROUND(MIN(wb.recommended_price) FILTER (WHERE wb.recommended_price > 0
      AND wb.recommended_price <= outlier_threshold), 2)                  AS min_rec,
    ROUND(MAX(wb.recommended_price) FILTER (WHERE wb.recommended_price > 0
      AND wb.recommended_price <= outlier_threshold), 2)                  AS max_rec,
    ROUND(AVG(wb.bid_avg), 2)                                             AS avg_bid
  FROM with_bids wb
  GROUP BY wb.city, wb.category
  ORDER BY wb.city, wb.category;
END;
$function$;

-- get_indrive_weekly: bid_avg promedia bid_1..bid_5.
CREATE OR REPLACE FUNCTION public.get_indrive_weekly(p_country text, outlier_threshold numeric DEFAULT 100)
 RETURNS TABLE(city text, category text, week text, obs bigint, avg_rec numeric, avg_bid numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  PERFORM require_country_access(p_country);
  RETURN QUERY
  WITH bid_proxy AS (
    SELECT
      po.city,
      po.category,
      po.observed_date,
      TO_CHAR(
        DATE_TRUNC('week', po.observed_date::date + INTERVAL '1 day') - INTERVAL '1 day',
        'IYYY"-W"IW'
      ) AS iso_week,
      po.recommended_price,
      CASE
        WHEN COALESCE(po.bid_1,0) > 0 OR COALESCE(po.bid_2,0) > 0 OR COALESCE(po.bid_3,0) > 0
          OR COALESCE(po.bid_4,0) > 0 OR COALESCE(po.bid_5,0) > 0
        THEN (
          SELECT AVG(v) FROM UNNEST(ARRAY[
            NULLIF(po.bid_1,0), NULLIF(po.bid_2,0), NULLIF(po.bid_3,0),
            NULLIF(po.bid_4,0), NULLIF(po.bid_5,0)
          ]) t(v) WHERE v IS NOT NULL
        )
        WHEN po.price_without_discount > 0 THEN po.price_without_discount
        WHEN po.minimal_bid > 0            THEN po.minimal_bid
        ELSE NULL
      END AS bid_avg
    FROM pricing_observations po
    WHERE po.competition_name = 'InDrive'
      AND po.data_source = 'manual'
      AND po.country = p_country
  ),
  with_bids AS (SELECT * FROM bid_proxy WHERE bid_avg IS NOT NULL)
  SELECT
    wb.city,
    wb.category,
    wb.iso_week                                                          AS week,
    COUNT(*)                                                             AS obs,
    ROUND(AVG(wb.recommended_price) FILTER (WHERE wb.recommended_price > 0
      AND wb.recommended_price <= outlier_threshold), 2)                 AS avg_rec,
    ROUND(AVG(wb.bid_avg), 2)                                            AS avg_bid
  FROM with_bids wb
  GROUP BY wb.city, wb.category, wb.iso_week
  ORDER BY wb.city, wb.category, wb.iso_week DESC;
END;
$function$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
--
-- 1. Columnas presentes:
--    SELECT column_name FROM information_schema.columns
--    WHERE table_name='pricing_observations' AND column_name IN ('bid_4','bid_5');
--    → 2 filas.
--
-- 2. La vista no cambió ningún valor histórico (bid_4/bid_5 = NULL):
--    SELECT COUNT(*) FROM v_effective_price WHERE effective_price IS NULL;
--    → mismo conteo que antes de la mig.
--
-- 3. Los MV siguen leyendo effective_price sin recrearse:
--    REFRESH MATERIALIZED VIEW CONCURRENTLY v_bracket_weekly_avg_mv;
--    REFRESH MATERIALIZED VIEW CONCURRENTLY v_bracket_daily_avg_mv;
--    (No es estrictamente necesario: para las filas históricas el número no
--     cambia. pg_cron los refresca @ :10 de todos modos; los datos nuevos con
--     bid_4/bid_5 se reflejan en el próximo refresh.)
-- ════════════════════════════════════════════════════════════════════════
