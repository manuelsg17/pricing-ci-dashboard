-- ════════════════════════════════════════════════════════════════════════
-- Migración 65 — RPCs sin DEFAULT 'Peru' (p_country requerido)
--
-- PROBLEMA QUE RESUELVE:
--   Históricamente las RPCs nacieron con `p_country text DEFAULT 'Peru'`
--   como retrocompat para callers viejos pre multi-país. Hoy el frontend
--   pasa p_country siempre, pero el default sigue ahí:
--   - Si un dev futuro olvida pasarlo → la query devuelve DATOS DE PERÚ
--     silenciosamente para el contexto de Bolivia/Nepal/etc.
--   - Si un script ad-hoc llama la RPC sin p_country → mismo problema.
--
--   Es un foot-gun multi-tenant: errores invisibles que producen
--   conclusiones equivocadas.
--
-- SOLUCIÓN:
--   Re-crear cada RPC removiendo el DEFAULT 'Peru'. Si el caller no pasa
--   p_country, la llamada falla explícitamente con "function does not
--   exist" en lugar de devolver datos errados.
--
-- ALCANCE: 9 RPCs (todas las que tenían DEFAULT 'Peru'):
--   1. get_dashboard_data_weekly      (mig 41, hot path del dashboard)
--   2. get_dashboard_data_daily       (mig 41, hot path)
--   3. get_available_zones            (mig 28)
--   4. get_indrive_summary            (mig 28)
--   5. get_indrive_weekly             (mig 28)
--   6. get_indrive_counts             (mig 28)
--   7. apply_indrive_bot_prices       (mig 28)
--   8. upsert_pricing_batch           (mig 28)
--   9. get_bot_vs_hubs_summary        (mig 20)
--
--   freeze_pricing_wa y recompute_brackets_for YA tienen p_country
--   requerido (sin DEFAULT). sync_bot_quotes se actualizó en mig 64.
--
-- COMPAT:
--   CREATE OR REPLACE FUNCTION mantiene los grants, deps de vistas, etc.
--   Solo cambia el default. Frontend NO requiere cambios (todos los
--   callsites ya pasan p_country).
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. get_dashboard_data_weekly ──────────────────────────────
-- DROP necesario: Postgres NO permite CREATE OR REPLACE quitar DEFAULTs
-- de parámetros. Drop+create con la firma exacta de la función actual
-- (que puede tener distintas variantes históricas — usamos IF EXISTS).

DROP FUNCTION IF EXISTS get_dashboard_data_weekly(text, text, text, text, boolean, int, int, int, int, text, text[]);
DROP FUNCTION IF EXISTS get_dashboard_data_weekly(text, text, text, text, boolean, int, int, int, int, text);
DROP FUNCTION IF EXISTS get_dashboard_data_weekly(text, text, text, text, boolean, int, int, int, int);

CREATE OR REPLACE FUNCTION get_dashboard_data_weekly(
  p_city        text,
  p_category    text,
  p_country     text,                  -- antes DEFAULT 'Peru'
  p_zone        text    DEFAULT NULL,
  p_surge       boolean DEFAULT NULL,
  p_week_start  int     DEFAULT NULL,
  p_year_start  int     DEFAULT NULL,
  p_week_end    int     DEFAULT NULL,
  p_year_end    int     DEFAULT NULL,
  p_data_source text    DEFAULT NULL,
  p_time_of_day text[]  DEFAULT NULL
) RETURNS TABLE (
  competition_name  text,
  distance_bracket  text,
  week              int,
  year              int,
  week_start_date   date,
  avg_price         numeric,
  observation_count bigint,
  surge             boolean
)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    competition_name,
    distance_bracket,
    week,
    year,
    MIN(week_start_date)                                                                            AS week_start_date,
    ROUND((SUM(avg_price * observation_count) / NULLIF(SUM(observation_count), 0))::numeric, 2)     AS avg_price,
    SUM(observation_count)                                                                          AS observation_count,
    surge
  FROM v_bracket_weekly_avg
  WHERE country  = p_country
    AND city     = p_city
    AND category = p_category
    AND (p_zone        IS NULL OR zone = p_zone OR p_zone = 'All')
    AND (p_surge       IS NULL OR surge = p_surge)
    AND (p_data_source IS NULL OR data_source = p_data_source)
    AND (
      p_year_start IS NULL OR
      (year > p_year_start) OR
      (year = p_year_start AND week >= p_week_start)
    )
    AND (
      p_year_end IS NULL OR
      (year < p_year_end) OR
      (year = p_year_end AND week <= p_week_end)
    )
  GROUP BY competition_name, distance_bracket, week, year, surge
  ORDER BY competition_name, distance_bracket, year, week;
$$;


-- ── 2. get_dashboard_data_daily ───────────────────────────────

DROP FUNCTION IF EXISTS get_dashboard_data_daily(text, text, text, text, boolean, date, date, text, text[]);
DROP FUNCTION IF EXISTS get_dashboard_data_daily(text, text, text, text, boolean, date, date, text);
DROP FUNCTION IF EXISTS get_dashboard_data_daily(text, text, text, text, boolean, date, date);

CREATE OR REPLACE FUNCTION get_dashboard_data_daily(
  p_city        text,
  p_category    text,
  p_country     text,                  -- antes DEFAULT 'Peru'
  p_zone        text    DEFAULT NULL,
  p_surge       boolean DEFAULT NULL,
  p_date_start  date    DEFAULT NULL,
  p_date_end    date    DEFAULT NULL,
  p_data_source text    DEFAULT NULL,
  p_time_of_day text[]  DEFAULT NULL
) RETURNS TABLE (
  competition_name  text,
  distance_bracket  text,
  observed_date     date,
  avg_price         numeric,
  observation_count bigint,
  surge             boolean
)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    competition_name,
    distance_bracket,
    observed_date,
    ROUND((SUM(avg_price * observation_count) / NULLIF(SUM(observation_count), 0))::numeric, 2) AS avg_price,
    SUM(observation_count)                                                                       AS observation_count,
    surge
  FROM v_bracket_daily_avg
  WHERE country  = p_country
    AND city     = p_city
    AND category = p_category
    AND (p_zone        IS NULL OR zone = p_zone OR p_zone = 'All')
    AND (p_surge       IS NULL OR surge = p_surge)
    AND (p_data_source IS NULL OR data_source = p_data_source)
    AND (p_date_start  IS NULL OR observed_date >= p_date_start)
    AND (p_date_end    IS NULL OR observed_date <= p_date_end)
  GROUP BY competition_name, distance_bracket, observed_date, surge
  ORDER BY competition_name, distance_bracket, observed_date;
$$;


-- ── 3. get_available_zones ────────────────────────────────────

DROP FUNCTION IF EXISTS get_available_zones(text, text, text);

CREATE OR REPLACE FUNCTION get_available_zones(
  p_city     text,
  p_category text,
  p_country  text                       -- antes DEFAULT 'Peru'
) RETURNS TABLE (zone text)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT DISTINCT COALESCE(po.zone, 'All') AS zone
  FROM pricing_observations po
  WHERE po.country  = p_country
    AND po.city     = p_city
    AND po.category = p_category
  ORDER BY 1;
$$;


-- ── 4. get_indrive_summary ────────────────────────────────────
-- Reorder de parámetros: el original era (outlier_threshold, p_country)
-- ambos con DEFAULT. Para hacer p_country requerido y que quede al frente
-- (semántica de "primero el tenant, después los flags"), DROP + CREATE.
-- Frontend pasa por nombre → orden no importa para PostgREST.

DROP FUNCTION IF EXISTS get_indrive_summary(numeric, text);

CREATE OR REPLACE FUNCTION get_indrive_summary(
  p_country         text,                -- ahora requerido y al frente
  outlier_threshold numeric DEFAULT 100
)
RETURNS TABLE (
  city          text,
  category      text,
  obs_with_bids bigint,
  outlier_recs  bigint,
  avg_rec       numeric,
  min_rec       numeric,
  max_rec       numeric,
  avg_bid       numeric
)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH bid_proxy AS (
    SELECT
      city,
      category,
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
        WHEN minimal_bid > 0           THEN minimal_bid
        ELSE NULL
      END AS bid_avg
    FROM pricing_observations
    WHERE competition_name = 'InDrive'
      AND data_source = 'manual'
      AND country = p_country
  ),
  with_bids AS (SELECT * FROM bid_proxy WHERE bid_avg IS NOT NULL)
  SELECT
    city,
    category,
    COUNT(*)                                                              AS obs_with_bids,
    COUNT(*) FILTER (WHERE recommended_price > outlier_threshold)         AS outlier_recs,
    ROUND(AVG(recommended_price) FILTER (WHERE recommended_price > 0
      AND recommended_price <= outlier_threshold), 2)                     AS avg_rec,
    ROUND(MIN(recommended_price) FILTER (WHERE recommended_price > 0
      AND recommended_price <= outlier_threshold), 2)                     AS min_rec,
    ROUND(MAX(recommended_price) FILTER (WHERE recommended_price > 0
      AND recommended_price <= outlier_threshold), 2)                     AS max_rec,
    ROUND(AVG(bid_avg), 2)                                                AS avg_bid
  FROM with_bids
  GROUP BY city, category
  ORDER BY city, category;
$$;


-- ── 5. get_indrive_weekly ─────────────────────────────────────
-- Mismo reorder que get_indrive_summary.

DROP FUNCTION IF EXISTS get_indrive_weekly(numeric, text);

CREATE OR REPLACE FUNCTION get_indrive_weekly(
  p_country         text,
  outlier_threshold numeric DEFAULT 100
)
RETURNS TABLE (
  city     text,
  category text,
  week     text,
  obs      bigint,
  avg_rec  numeric,
  avg_bid  numeric
)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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
        WHEN minimal_bid > 0           THEN minimal_bid
        ELSE NULL
      END AS bid_avg
    FROM pricing_observations
    WHERE competition_name = 'InDrive'
      AND data_source = 'manual'
      AND country = p_country
  ),
  with_bids AS (SELECT * FROM bid_proxy WHERE bid_avg IS NOT NULL)
  SELECT
    city,
    category,
    iso_week                                                             AS week,
    COUNT(*)                                                             AS obs,
    ROUND(AVG(recommended_price) FILTER (WHERE recommended_price > 0
      AND recommended_price <= outlier_threshold), 2)                    AS avg_rec,
    ROUND(AVG(bid_avg), 2)                                               AS avg_bid
  FROM with_bids
  GROUP BY city, category, iso_week
  ORDER BY city, category, iso_week DESC;
$$;


-- ── 6. get_indrive_counts ─────────────────────────────────────

DROP FUNCTION IF EXISTS get_indrive_counts(text);

CREATE OR REPLACE FUNCTION get_indrive_counts(
  p_country text                              -- antes DEFAULT 'Peru'
)
RETURNS TABLE (total_rows bigint, rows_with_bids bigint)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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
$$;


-- ── 7. apply_indrive_bot_prices ───────────────────────────────
-- Original tenía p_country al final con DEFAULT y p_city/p_category al
-- frente con DEFAULT NULL. Para hacer p_country requerido, movemos al
-- frente. Frontend pasa por nombre.

DROP FUNCTION IF EXISTS apply_indrive_bot_prices(text, text, text);

CREATE OR REPLACE FUNCTION apply_indrive_bot_prices(
  p_country  text,                            -- requerido, al frente
  p_city     text    DEFAULT NULL,
  p_category text    DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  updated_count integer;
BEGIN
  UPDATE pricing_observations po
  SET price_without_discount = ROUND(
    po.recommended_price * (1 + ic.adjustment_pct / 100.0),
    2
  )
  FROM indrive_config ic
  WHERE po.competition_name  = 'InDrive'
    AND po.data_source        = 'bot'
    AND po.recommended_price IS NOT NULL
    AND po.recommended_price  > 0
    AND po.country            = p_country
    AND po.city               = ic.city
    AND po.category           = ic.category
    AND ic.country            = p_country
    AND (p_city     IS NULL OR po.city     = p_city)
    AND (p_category IS NULL OR po.category = p_category);

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$;


-- ── 8. upsert_pricing_batch ───────────────────────────────────

DROP FUNCTION IF EXISTS upsert_pricing_batch(jsonb, jsonb, uuid, text, int, text);

CREATE OR REPLACE FUNCTION upsert_pricing_batch(
  p_rows        jsonb,
  p_city_ranges jsonb,
  p_batch_id    uuid,
  p_filename    text,
  p_row_count   int,
  p_country     text                          -- antes DEFAULT 'Peru'
) RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_range jsonb;
BEGIN
  FOR v_range IN SELECT * FROM jsonb_array_elements(p_city_ranges) LOOP
    DELETE FROM pricing_observations
    WHERE country      = p_country
      AND city         = v_range->>'city'
      AND data_source  = 'manual'
      AND observed_date BETWEEN (v_range->>'min_date')::date
                             AND (v_range->>'max_date')::date;
  END LOOP;

  INSERT INTO pricing_observations
  SELECT * FROM jsonb_populate_recordset(null::pricing_observations, p_rows);

  INSERT INTO upload_batches (id, filename, row_count, city, country)
  VALUES (p_batch_id, p_filename, p_row_count, 'multi', p_country)
  ON CONFLICT (id) DO NOTHING;

  RETURN p_row_count;
END;
$$;


-- ── 9. get_bot_vs_hubs_summary ────────────────────────────────

DROP FUNCTION IF EXISTS get_bot_vs_hubs_summary(text);

CREATE OR REPLACE FUNCTION get_bot_vs_hubs_summary(
  p_country text                              -- antes DEFAULT 'Peru'
)
RETURNS TABLE (
  city             text,
  category         text,
  competition_name text,
  data_source      text,
  obs_count        bigint,
  avg_effective    numeric
)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    city,
    category,
    competition_name,
    data_source,
    COUNT(*)::bigint AS obs_count,
    ROUND(
      AVG(
        CASE
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
          WHEN competition_name = 'InDrive'
          THEN recommended_price
          ELSE COALESCE(NULLIF(price_with_discount, 0), price_without_discount)
        END
      )::numeric, 2
    ) AS avg_effective
  FROM pricing_observations
  WHERE country = p_country
    AND data_source IN ('manual', 'bot')
    AND competition_name IS NOT NULL
  GROUP BY city, category, competition_name, data_source
  ORDER BY city, category, competition_name, data_source;
$$;


-- ── GRANTs (regrantear porque las firmas pueden haber cambiado) ────────

GRANT EXECUTE ON FUNCTION get_dashboard_data_weekly(text, text, text, text, boolean, int, int, int, int, text, text[])
  TO authenticated;
GRANT EXECUTE ON FUNCTION get_dashboard_data_daily(text, text, text, text, boolean, date, date, text, text[])
  TO authenticated;
GRANT EXECUTE ON FUNCTION get_available_zones(text, text, text)
  TO authenticated;
GRANT EXECUTE ON FUNCTION get_indrive_summary(text, numeric)
  TO authenticated;
GRANT EXECUTE ON FUNCTION get_indrive_weekly(text, numeric)
  TO authenticated;
GRANT EXECUTE ON FUNCTION get_indrive_counts(text)
  TO authenticated;
GRANT EXECUTE ON FUNCTION apply_indrive_bot_prices(text, text, text)
  TO authenticated;
GRANT EXECUTE ON FUNCTION upsert_pricing_batch(jsonb, jsonb, uuid, text, int, text)
  TO authenticated;
GRANT EXECUTE ON FUNCTION get_bot_vs_hubs_summary(text)
  TO authenticated;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN POST-APLICACIÓN
--
-- 1. Llamar sin p_country debe fallar (esperado):
--      SELECT * FROM get_available_zones('Lima', 'Economy');
--      → ERROR: function get_available_zones(text, text) does not exist
--
-- 2. Llamar con p_country debe funcionar normal:
--      SELECT * FROM get_available_zones('Lima', 'Economy', 'Peru');
--
-- 3. Verificar que ningún caller del frontend rompió:
--      Dashboard, BotVsHubs, RawData, InDriveConfig deben renderizar
--      normal — todos ya pasan p_country.
-- ════════════════════════════════════════════════════════════════════════
