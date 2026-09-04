-- ════════════════════════════════════════════════════════════════════════
-- Migración 240 — create_country_setup(jsonb): alta de país en UNA transacción
--
-- POR QUÉ:
--   El wizard de países (src/components/config/CountryWizard.jsx) hacía 8
--   escrituras separadas desde el cliente, una detrás de otra, sin
--   transacción:
--
--     1. country_config            upsert
--     2. bracket_weights           upsert (solo si los pesos suman 100)
--     3. bot_rules                 upsert
--     4. distance_thresholds       upsert (defaults por city × category × bracket)
--     5. price_validation_rules    upsert (outlier país = 3 × max_price)
--     6. semaforo_config           count + insert (solo si el país no tenía bandas)
--     7. rush_hour_windows         upsert (07-09 y 17-20 por ciudad)
--     8. indrive_config            upsert best-effort (adjustment_pct = 0)
--
--   Si cualquiera fallaba a mitad de camino (RLS, red, constraint) el país
--   quedaba a medio crear: country_config existía pero sin umbrales, o con
--   pesos pero sin semáforo. El wizard mostraba "Error al crear país" y el
--   usuario, al reintentar, pisaba con upsert lo que sí se había guardado.
--   Ese estado intermedio es invisible desde la UI y solo se descubre cuando
--   el dashboard cae a 'very_long' por todo (mig 46) o el semáforo usa el
--   fallback hardcodeado.
--
-- QUÉ HACE:
--   Una sola RPC SECURITY DEFINER que recibe el draft del wizard como jsonb,
--   lo valida y hace las 8 escrituras dentro de la misma transacción: o
--   queda todo o no queda nada. Devuelve jsonb con lo creado (conteo por
--   tabla) para que el cliente lo muestre.
--
-- PAYLOAD (mismas claves que el draft del wizard):
--   {
--     country_key, label, currency, locale?, iso2?, native_label?,
--     outlier_threshold?, max_price?,
--     cities:   [{ uiName, dbName, botKey, isVirtual, categories:
--                  [{ name, dbName, competitors[], yangoDisplayName }] }],
--     botRules: [{ app, vc, ovc?, competition_name, category, cities? }],
--     weights:  { very_short, short, median, average, long, very_long } | null
--               (porcentajes; se guardan solo si suman 100 ± 0.5, como antes)
--   }
--
-- VALIDACIONES (todas cortan con excepción, nada se escribe):
--   · country_key con forma ^[A-Z][A-Za-z0-9]+$ (misma regex que el wizard)
--   · label y currency no vacíos
--   · el país NO existe todavía en country_config (antes el wizard hacía
--     upsert y podía pisar un país real si alguien tipeaba 'Peru')
--   · weights, si vienen, suman 100 ± 0.5
--
-- GATE (§3 de CLAUDE.md):
--   La sección `config` NO es adminOnly (App.jsx), y las 8 tablas están en
--   section_write_grants con gate='section' bajo `config`. Hoy cada escritura
--   pasa por RLS = can_write_table(tabla) AND can_access_country(país). La RPC
--   replica EXACTAMENTE ese gate, no lo afloja ni lo endurece:
--     · can_access_section('config')            — quién puede configurar
--     · can_write_table(t) para las 8 tablas     — el mapa sigue mandando: si
--       mañana una de las tablas sale del mapa, la RPC deja de escribirla
--     · require_country_access(country_key)     — sobre CUÁL país (mig 193)
--   Nota: un país recién creado solo lo puede dar de alta un rol con
--   countries=['all'] (o admin), porque el país todavía no existe en ninguna
--   lista de permisos. Es el mismo comportamiento que tenía el upsert
--   directo: no es una restricción nueva.
--
-- DATOS SEMBRADOS EN ESPAÑOL (excepción §6 documentada):
--   Los `note` del semáforo ('Yango competitivo', …) y los `label` de las
--   ventanas de hora pico ('Mañana', 'Tarde') son DATOS persistidos en tablas
--   de configuración, no strings de UI: el usuario los edita después desde
--   /config y las pantallas los muestran tal cual, como cualquier otro valor
--   configurado. Por eso NO pasan por i18n, igual que los nombres de brackets
--   y turnos. Los textos que el usuario ve en el wizard antes de guardar sí
--   pasan por t() (cliente).
--
-- SEGURIDAD:
--   SECURITY DEFINER con search_path fijo. EXECUTE solo para authenticated
--   (REVOKE de PUBLIC y anon). Los triggers de auditoría (log_changes) y de
--   optimistic lock siguen corriendo: auth.email() se resuelve igual dentro
--   de la función porque el JWT del caller sigue en request.jwt.claims.
--   Los errores de validación llevan ERRCODE para que el cliente los pueda
--   distinguir sin parsear texto: 22023 (invalid_parameter_value) para
--   payload inválido, 23505 (unique_violation) para país existente,
--   42501 (insufficient_privilege) para el gate.
-- ════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.create_country_setup(jsonb);

CREATE OR REPLACE FUNCTION public.create_country_setup(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_country        text;
  v_label          text;
  v_currency       text;
  v_locale         text;
  v_iso2           text;
  v_native_label   text;
  v_outlier        numeric;
  v_max_price      numeric;
  v_cities         jsonb;
  v_bot_rules      jsonb;
  v_weights        jsonb;
  v_weight_sum     numeric;
  v_tbl            text;
  v_city           jsonb;
  v_city_name      text;
  v_cat            jsonb;
  v_cat_name       text;
  v_bracket        text;
  v_rule           jsonb;
  v_n              int;
  v_n_weights      int := 0;
  v_n_rules        int := 0;
  v_n_thresholds   int := 0;
  v_n_semaforo     int := 0;
  v_n_rush         int := 0;
  v_n_indrive      int := 0;
  v_indrive_err    text := NULL;
  -- Umbrales de distancia por defecto (km máximo de cada bracket). Iguales
  -- para todas las monedas: la distancia geográfica no depende del país.
  -- very_long no tiene tope. Antes vivían en el cliente
  -- (DEFAULT_DISTANCE_THRESHOLDS_KM en CountryWizard.jsx); ahora la base es la
  -- única dueña para que un país creado por cualquier camino arranque igual.
  v_thresholds     jsonb := '{"very_short":2,"short":4,"median":6,"average":8,"long":10,"very_long":null}'::jsonb;
  v_brackets       text[] := ARRAY['very_short','short','median','average','long','very_long'];
  v_tables         text[] := ARRAY[
    'country_config','bracket_weights','bot_rules','distance_thresholds',
    'price_validation_rules','semaforo_config','rush_hour_windows','indrive_config'
  ];
BEGIN
  -- ── Gate: sección + mapa de escritura + país ───────────────────────
  IF NOT can_access_section('config') THEN
    RAISE EXCEPTION 'access_denied: crear un país requiere la sección Configuración'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  FOREACH v_tbl IN ARRAY v_tables LOOP
    IF NOT can_write_table(v_tbl) THEN
      RAISE EXCEPTION 'access_denied: tu rol no puede escribir % (section_write_grants)', v_tbl
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END LOOP;

  -- ── Validación del payload ─────────────────────────────────────────
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'invalid_payload: se esperaba un objeto jsonb'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_country  := btrim(coalesce(p_payload->>'country_key', ''));
  v_label    := btrim(coalesce(p_payload->>'label', ''));
  v_currency := upper(btrim(coalesce(p_payload->>'currency', '')));

  IF v_country !~ '^[A-Z][A-Za-z0-9]+$' THEN
    RAISE EXCEPTION 'invalid_payload: country_key debe empezar con mayúscula y contener solo letras/números (recibido: %)',
      coalesce(nullif(v_country, ''), '<vacío>')
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_label = '' THEN
    RAISE EXCEPTION 'invalid_payload: label es obligatorio'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_currency = '' THEN
    RAISE EXCEPTION 'invalid_payload: currency es obligatorio'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- El país todavía no existe: recién ahora sabemos cuál es, y el gate por
  -- país va DESPUÉS de saber que la clave tiene forma válida.
  PERFORM require_country_access(v_country);

  IF EXISTS (SELECT 1 FROM country_config WHERE country_key = v_country) THEN
    RAISE EXCEPTION 'country_exists: el país % ya existe en country_config; editalo desde Configuración → Países', v_country
      USING ERRCODE = 'unique_violation';
  END IF;

  v_locale       := coalesce(nullif(btrim(p_payload->>'locale'), ''), 'en-US');
  v_iso2         := nullif(btrim(coalesce(p_payload->>'iso2', '')), '');
  v_native_label := coalesce(nullif(btrim(p_payload->>'native_label'), ''), v_label);
  -- Numéricos validados por tipo: un '"abc"' del cliente reventaría con un
  -- 22P02 crudo de Postgres en vez del mensaje de validación del resto.
  IF p_payload ? 'outlier_threshold'
     AND jsonb_typeof(p_payload->'outlier_threshold') NOT IN ('number', 'null') THEN
    RAISE EXCEPTION 'invalid_payload: outlier_threshold debe ser un número'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_payload ? 'max_price'
     AND jsonb_typeof(p_payload->'max_price') NOT IN ('number', 'null') THEN
    RAISE EXCEPTION 'invalid_payload: max_price debe ser un número'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_outlier      := coalesce((p_payload->>'outlier_threshold')::numeric, 100);
  v_max_price    := coalesce((p_payload->>'max_price')::numeric, 1000);
  v_cities       := coalesce(p_payload->'cities', '[]'::jsonb);
  v_bot_rules    := coalesce(p_payload->'botRules', '[]'::jsonb);
  v_weights      := p_payload->'weights';

  IF jsonb_typeof(v_cities) <> 'array' THEN
    RAISE EXCEPTION 'invalid_payload: cities debe ser un array'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF jsonb_typeof(v_bot_rules) <> 'array' THEN
    RAISE EXCEPTION 'invalid_payload: botRules debe ser un array'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_weights IS NOT NULL AND jsonb_typeof(v_weights) = 'null' THEN
    v_weights := NULL;
  END IF;
  IF v_weights IS NOT NULL THEN
    IF jsonb_typeof(v_weights) <> 'object' THEN
      RAISE EXCEPTION 'invalid_payload: weights debe ser un objeto bracket → porcentaje'
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    SELECT coalesce(sum(coalesce((v_weights->>b)::numeric, 0)), 0)
      INTO v_weight_sum
      FROM unnest(v_brackets) b;
    IF abs(v_weight_sum - 100) >= 0.5 THEN
      RAISE EXCEPTION 'invalid_payload: los pesos deben sumar 100 %% (suman %)', v_weight_sum
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END IF;

  -- ── 1. country_config ──────────────────────────────────────────────
  -- Siempre arranca en draft: el usuario activa después desde /config.
  INSERT INTO country_config (
    country_key, label, currency, locale, iso2, native_label,
    outlier_threshold, max_price, status, sort_order, cities
  ) VALUES (
    v_country, v_label, v_currency, v_locale, v_iso2, v_native_label,
    v_outlier, v_max_price, 'draft', 99, v_cities
  );

  -- ── 2. bracket_weights (city='all', category='all') ────────────────
  IF v_weights IS NOT NULL THEN
    FOREACH v_bracket IN ARRAY v_brackets LOOP
      INSERT INTO bracket_weights (country, city, category, bracket, weight)
      VALUES (v_country, 'all', 'all', v_bracket,
              coalesce((v_weights->>v_bracket)::numeric, 0) / 100)
      ON CONFLICT (country, city, category, bracket)
      DO UPDATE SET weight = EXCLUDED.weight;
      v_n_weights := v_n_weights + 1;
    END LOOP;
  END IF;

  -- ── 3. bot_rules ───────────────────────────────────────────────────
  -- Misma limpieza que hacía el cliente: se saltan las filas incompletas y
  -- app/vc/ovc van en minúscula (el bot manda así).
  FOR v_rule IN SELECT value FROM jsonb_array_elements(v_bot_rules) LOOP
    CONTINUE WHEN nullif(btrim(coalesce(v_rule->>'app', '')), '') IS NULL
              OR nullif(btrim(coalesce(v_rule->>'vc', '')), '') IS NULL
              OR nullif(btrim(coalesce(v_rule->>'competition_name', '')), '') IS NULL
              OR nullif(btrim(coalesce(v_rule->>'category', '')), '') IS NULL;
    INSERT INTO bot_rules (country, app, vc, ovc, competition_name, category, cities, active)
    VALUES (
      v_country,
      lower(btrim(v_rule->>'app')),
      lower(btrim(v_rule->>'vc')),
      lower(coalesce(nullif(btrim(v_rule->>'ovc'), ''), '*')),
      btrim(v_rule->>'competition_name'),
      btrim(v_rule->>'category'),
      coalesce(
        (SELECT array_agg(x) FROM jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(v_rule->'cities') = 'array' THEN v_rule->'cities' ELSE '[]'::jsonb END
        ) x),
        '{}'::text[]
      ),
      true
    )
    ON CONFLICT (country, app, vc, ovc)
    DO UPDATE SET competition_name = EXCLUDED.competition_name,
                  category         = EXCLUDED.category,
                  cities           = EXCLUDED.cities,
                  active           = true;
    v_n_rules := v_n_rules + 1;
  END LOOP;

  -- ── 4. distance_thresholds — sin esto el dashboard cae a very_long ──
  -- Por (city, category, bracket); si la ciudad no tiene categorías, 'all'.
  FOR v_city IN SELECT value FROM jsonb_array_elements(v_cities) LOOP
    v_city_name := coalesce(nullif(btrim(v_city->>'dbName'), ''), nullif(btrim(v_city->>'uiName'), ''));
    CONTINUE WHEN v_city_name IS NULL;
    IF jsonb_typeof(v_city->'categories') = 'array' AND jsonb_array_length(v_city->'categories') > 0 THEN
      FOR v_cat IN SELECT value FROM jsonb_array_elements(v_city->'categories') LOOP
        v_cat_name := coalesce(nullif(btrim(v_cat->>'dbName'), ''), nullif(btrim(v_cat->>'name'), ''));
        CONTINUE WHEN v_cat_name IS NULL;
        FOREACH v_bracket IN ARRAY v_brackets LOOP
          INSERT INTO distance_thresholds (country, city, category, bracket, max_km)
          VALUES (v_country, v_city_name, v_cat_name, v_bracket, (v_thresholds->>v_bracket)::numeric)
          ON CONFLICT (country, city, category, bracket) DO UPDATE SET max_km = EXCLUDED.max_km;
          v_n_thresholds := v_n_thresholds + 1;
        END LOOP;
      END LOOP;
    ELSE
      FOREACH v_bracket IN ARRAY v_brackets LOOP
        INSERT INTO distance_thresholds (country, city, category, bracket, max_km)
        VALUES (v_country, v_city_name, 'all', v_bracket, (v_thresholds->>v_bracket)::numeric)
        ON CONFLICT (country, city, category, bracket) DO UPDATE SET max_km = EXCLUDED.max_km;
        v_n_thresholds := v_n_thresholds + 1;
      END LOOP;
    END IF;
  END LOOP;

  -- ── 5. price_validation_rules — outlier defensivo país = 3 × max_price ─
  INSERT INTO price_validation_rules (country, city, category, competition, max_price)
  VALUES (v_country, 'all', 'all', 'all', v_max_price * 3)
  ON CONFLICT (country, city, category, competition) DO UPDATE SET max_price = EXCLUDED.max_price;

  -- ── 6. semaforo_config — bandas por defecto, solo si el país no tenía ─
  -- Verde 5-10 %, Amarillo 1-5 % y 10-12 %, Rojo el resto. Las `note` son
  -- datos (ver cabecera, excepción §6).
  SELECT count(*) INTO v_n FROM semaforo_config WHERE country = v_country;
  IF v_n = 0 THEN
    INSERT INTO semaforo_config (country, band, min_pct, max_pct, note) VALUES
      (v_country, 'green',  5,    10,   'Yango competitivo'),
      (v_country, 'yellow', 1,    5,    'Cerca pero por debajo'),
      (v_country, 'yellow', 10,   12,   'Cerca pero por arriba'),
      (v_country, 'red',    NULL, 1,    'Yango muy bajo vs mercado'),
      (v_country, 'red',    12,   NULL, 'Yango muy alto vs mercado');
    v_n_semaforo := 5;
  END IF;

  -- ── 7. rush_hour_windows — 07-09 y 17-20 por ciudad ────────────────
  -- Sin esto rush_hour queda NULL en pricing_observations y los filtros de
  -- hora pico no funcionan. `label` es dato (excepción §6).
  FOR v_city IN SELECT value FROM jsonb_array_elements(v_cities) LOOP
    v_city_name := coalesce(nullif(btrim(v_city->>'dbName'), ''), nullif(btrim(v_city->>'uiName'), ''));
    CONTINUE WHEN v_city_name IS NULL;
    INSERT INTO rush_hour_windows (country, city, start_time, end_time, label) VALUES
      (v_country, v_city_name, '07:00', '09:00', 'Mañana'),
      (v_country, v_city_name, '17:00', '20:00', 'Tarde')
    ON CONFLICT (country, city, start_time, end_time) DO UPDATE SET label = EXCLUDED.label;
    v_n_rush := v_n_rush + 2;
  END LOOP;

  -- ── 8. indrive_config — adjustment_pct = 0 por (city, category) ────
  -- Best-effort como antes: si falla no rompe el alta (el admin puede
  -- sembrarlo a mano). Un bloque BEGIN/EXCEPTION es una subtransacción: lo
  -- que falle acá se revierte solo, sin tocar los pasos 1-7.
  BEGIN
    FOR v_city IN SELECT value FROM jsonb_array_elements(v_cities) LOOP
      v_city_name := coalesce(nullif(btrim(v_city->>'dbName'), ''), nullif(btrim(v_city->>'uiName'), ''));
      CONTINUE WHEN v_city_name IS NULL OR jsonb_typeof(v_city->'categories') <> 'array';
      FOR v_cat IN SELECT value FROM jsonb_array_elements(v_city->'categories') LOOP
        v_cat_name := coalesce(nullif(btrim(v_cat->>'dbName'), ''), nullif(btrim(v_cat->>'name'), ''));
        CONTINUE WHEN v_cat_name IS NULL;
        INSERT INTO indrive_config (country, city, category, adjustment_pct)
        VALUES (v_country, v_city_name, v_cat_name, 0)
        ON CONFLICT (country, city, category) DO NOTHING;
        v_n_indrive := v_n_indrive + 1;
      END LOOP;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    v_n_indrive := 0;
    v_indrive_err := SQLERRM;
  END;

  RETURN jsonb_build_object(
    'country_key',            v_country,
    'status',                 'draft',
    'country_config',         1,
    'bracket_weights',        v_n_weights,
    'bot_rules',              v_n_rules,
    'distance_thresholds',    v_n_thresholds,
    'price_validation_rules', 1,
    'semaforo_config',        v_n_semaforo,
    'rush_hour_windows',      v_n_rush,
    'indrive_config',         v_n_indrive,
    'indrive_config_error',   v_indrive_err
  );
END;
$$;

COMMENT ON FUNCTION public.create_country_setup(jsonb) IS
  'Mig 240 — alta atómica de país desde el wizard: country_config + bracket_weights + bot_rules + distance_thresholds + price_validation_rules + semaforo_config + rush_hour_windows + indrive_config en una transacción. Gate: can_access_section(config) + can_write_table(×8) + require_country_access.';

REVOKE ALL ON FUNCTION public.create_country_setup(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_country_setup(jsonb) TO authenticated;
