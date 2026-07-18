-- ════════════════════════════════════════════════════════════════════════
-- Migración 34 — PLAN para conexión directa a la BD del bot
-- (NO ejecutar tal cual; este archivo sirve como contrato y documentación
-- del pipeline. Cuando el usuario tenga las credenciales/replica de la BD
-- del bot esto se convierte en migración real.)
-- ════════════════════════════════════════════════════════════════════════
--
-- ESCENARIO
-- ─────────
-- Hoy: el bot exporta CSV → usuario sube CSV manualmente desde /upload/bot.
-- Futuro: la BD del bot está disponible como Foreign Data Wrapper o como
-- esquema replicado. Queremos un job que ingiera filas nuevas
-- automáticamente, aplicando la misma normalización + filtros
-- (filas vacías, montos fuera de rango) que ya hacemos en JS.
--
-- COMPONENTES
-- ───────────
-- 1) bot_raw_observations (tabla staging)
--    Recibe el dump tal cual del bot. Sin restricciones de NOT NULL ni
--    chequeos de rangos — solo INSERT bulk, rápido. Incluye:
--      ingest_id          uuid                -- batch (para rollback)
--      bot_row_id         text                -- id del bot, para idempotencia
--      raw_payload        jsonb               -- por si cambian columnas
--      country, city, observed_date, observed_time,
--      app, vehicle_category, observed_vehicle_category,
--      price_recommended, price_with_discount, price_without_discount,
--      distance_km, eta_min, surge, rush_hour, ...
--      ingested_at        timestamptz default now()
--
-- 2) sanitize_bot_batch(p_ingest_id uuid) RETURNS table(...)
--    Función que convierte filas de bot_raw_observations en candidatas
--    pricing_observations. Aplica EN SQL exactamente las mismas reglas
--    que ingestionFilters.js:
--       (a) require: country, city, observed_date, app, vehicle_category,
--                    al menos un precio.
--       (b) normaliza vía bot_rules (data-driven, ya existe en
--                    constants.js como botRules — debe migrarse a una
--                    tabla bot_rules para que SQL la lea).
--       (c) llama get_distance_bracket(country, city, category, distance)
--                    para asignar distance_bracket consistente con la UI.
--       (d) busca price_validation_rules para descartar outliers o
--                    marcarlos en una tabla bot_outliers para revisión.
--
-- 3) commit_bot_batch(p_ingest_id uuid) RETURNS int
--    INSERT ... SELECT desde sanitize_bot_batch a pricing_observations.
--    Devuelve cuántas filas entraron al dashboard. Idempotente:
--    si hay (city, observed_date, observed_time, competition_name,
--    category, distance_km) duplicado, hace UPDATE.
--
-- 4) bot_outliers (tabla)
--    Filas que pasaron normalización pero violan price_validation_rules.
--    Con UI ad-hoc en /upload/bot/outliers el usuario las revisa y
--    decide: aceptar (marca outlier=false → re-corre commit) o descartar.
--
-- 5) Vista materializada de monitoreo:
--    v_bot_ingest_stats (ingest_id, ingested_at, total, accepted,
--                        dropped_incomplete, dropped_outlier, dropped_dup)
--
-- ════════════════════════════════════════════════════════════════════════
-- Lo que sigue es el ESQUELETO SQL. Comentado para evitar ejecución
-- accidental — descomentar cuando se confirme el contrato del bot.
-- ════════════════════════════════════════════════════════════════════════

/*
CREATE TABLE IF NOT EXISTS bot_raw_observations (
  ingest_id            uuid    NOT NULL,
  bot_row_id           text    NOT NULL,
  country              text,
  city                 text,
  observed_date        date,
  observed_time        time,
  app                  text,
  vehicle_category     text,
  observed_vehicle_category text,
  price_recommended    numeric,
  price_with_discount  numeric,
  price_without_discount numeric,
  distance_km          numeric,
  eta_min              numeric,
  surge                boolean,
  rush_hour            boolean,
  raw_payload          jsonb,
  ingested_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ingest_id, bot_row_id)
);

CREATE INDEX IF NOT EXISTS idx_bot_raw_country_date
  ON bot_raw_observations (country, observed_date);

CREATE TABLE IF NOT EXISTS bot_rules (
  id          serial PRIMARY KEY,
  country     text NOT NULL,
  app         text NOT NULL,
  vc          text NOT NULL,
  ovc         text,            -- '*' = wildcard
  city_in     text[],          -- NULL = todas las dbCities del país
  competition_name text NOT NULL,
  ui_category text NOT NULL,   -- el nombre que aparece en el dashboard
  UNIQUE (country, app, vc, ovc)
);

CREATE TABLE IF NOT EXISTS bot_outliers (
  id          bigserial PRIMARY KEY,
  ingest_id   uuid NOT NULL,
  bot_row_id  text NOT NULL,
  reason      text NOT NULL CHECK (reason IN ('outlier','no_rule_match','no_price','incomplete')),
  detail      jsonb,
  reviewed    boolean NOT NULL DEFAULT false,
  reviewed_at timestamptz,
  reviewed_by text,
  decision    text CHECK (decision IN ('accept','discard')),
  UNIQUE (ingest_id, bot_row_id, reason)
);

CREATE OR REPLACE FUNCTION sanitize_bot_batch(p_ingest_id uuid)
RETURNS TABLE (
  country text, city text, observed_date date, observed_time time,
  category text, competition_name text,
  recommended_price numeric, price_with_discount numeric, price_without_discount numeric,
  distance_km numeric, eta_min numeric,
  surge boolean, rush_hour boolean,
  data_source text, distance_bracket text
) LANGUAGE sql STABLE AS $$
  WITH joined AS (
    SELECT b.*, r.competition_name AS map_name, r.ui_category AS map_category
    FROM bot_raw_observations b
    LEFT JOIN bot_rules r
      ON  r.country = b.country
      AND r.app     = lower(b.app)
      AND r.vc      = lower(b.vehicle_category)
      AND (r.ovc = lower(b.observed_vehicle_category) OR r.ovc = '*')
      AND (r.city_in IS NULL OR b.city = ANY(r.city_in))
    WHERE b.ingest_id = p_ingest_id
  )
  SELECT
    country, city, observed_date, observed_time,
    map_category   AS category,
    map_name       AS competition_name,
    price_recommended,
    price_with_discount,
    price_without_discount,
    distance_km, eta_min, surge, rush_hour,
    'bot' AS data_source,
    get_distance_bracket(country, city, map_category, distance_km) AS distance_bracket
  FROM joined
  WHERE country IS NOT NULL
    AND city    IS NOT NULL
    AND observed_date IS NOT NULL
    AND map_name IS NOT NULL
    AND map_category IS NOT NULL
    AND COALESCE(price_recommended, price_without_discount, price_with_discount) IS NOT NULL;
$$;

CREATE OR REPLACE FUNCTION commit_bot_batch(p_ingest_id uuid)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE
  v_count int;
BEGIN
  -- 1) Marcar outliers (no insertan, van a bot_outliers para revisión)
  INSERT INTO bot_outliers (ingest_id, bot_row_id, reason, detail)
  SELECT p_ingest_id, b.bot_row_id, 'outlier',
         jsonb_build_object(
           'price',     COALESCE(b.price_recommended, b.price_without_discount, b.price_with_discount),
           'threshold', r.max_price
         )
  FROM bot_raw_observations b
  JOIN sanitize_bot_batch(p_ingest_id) s
    ON s.country = b.country AND s.city = b.city
    AND s.observed_date = b.observed_date
  LEFT JOIN price_validation_rules r
    ON  r.country = s.country
    AND (r.city = s.city OR r.city = 'all')
    AND (r.category = s.category OR r.category = 'all')
    AND (r.competition = s.competition_name OR r.competition = 'all')
  WHERE r.max_price IS NOT NULL
    AND COALESCE(b.price_recommended, b.price_without_discount, b.price_with_discount) > r.max_price
  ON CONFLICT (ingest_id, bot_row_id, reason) DO NOTHING;

  -- 2) Insertar las filas saneadas (excluyendo outliers)
  INSERT INTO pricing_observations (
    country, city, observed_date, observed_time, category, competition_name,
    recommended_price, price_with_discount, price_without_discount,
    distance_km, eta_min, surge, rush_hour, data_source, distance_bracket
  )
  SELECT s.* FROM sanitize_bot_batch(p_ingest_id) s
  WHERE NOT EXISTS (
    SELECT 1 FROM bot_outliers o
    WHERE o.ingest_id = p_ingest_id AND o.reason = 'outlier'
  );

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE VIEW v_bot_ingest_stats AS
SELECT
  ingest_id,
  MIN(ingested_at) AS ingested_at,
  COUNT(*) AS total
FROM bot_raw_observations
GROUP BY ingest_id;
*/

-- ════════════════════════════════════════════════════════════════════════
-- LADO DE LA APP (JS)
-- ────────────────────
-- En src/algorithms/ingestionFilters.js ya está la lógica equivalente
-- para el flujo CSV manual. Cuando se conecte la BD del bot:
--
-- (A) Si los rows pasan por el cliente (Edge Function que lee de la BD del
--     bot y los manda al dashboard):
--     usar sanitizeBatch(rows, priceRules) → array final.
--
-- (B) Si los rows pasan por SQL directo (FDW, dblink, cron job en
--     Supabase): usar las funciones SQL anteriores. La normalización
--     queda 100% en SQL para minimizar latencia y evitar dependencia del
--     navegador/usuario activo.
--
-- (C) UI: nueva pestaña /upload/bot-sync con:
--     – botón "Importar desde bot DB" (llama Edge Function)
--     – tabla de últimos batches (v_bot_ingest_stats)
--     – tabla de outliers pendientes de revisión (bot_outliers WHERE NOT reviewed)
-- ════════════════════════════════════════════════════════════════════════
