-- ════════════════════════════════════════════════════════════════════════
-- seed.sql — data sintética chica para desarrollo LOCAL (Fase 0).
--
-- Corre automático después de las migraciones en `supabase start` /
-- `supabase db reset`. NO se aplica nunca a producción — es solo para
-- tener algo que ver en el dashboard local sin necesitar las 1.3M+ filas
-- reales de pricing_observations. country_config/roles ya vienen
-- sembrados por las migraciones (67 y 129) — acá solo se agrega:
--   1. Un usuario admin local para poder loguearse.
--   2. Un puñado de observaciones sintéticas (Perú + Colombia, últimas
--      semanas) para que Dashboard/Competitividad/etc. tengan data real
--      para renderizar.
-- ════════════════════════════════════════════════════════════════════════

-- ── 1. Usuario admin local ──────────────────────────────────────────────
-- Mismo patrón que se usa para crear credenciales reales en producción
-- (auth.users + auth.identities + user_profiles). Credenciales obvias y
-- solo válidas en este Postgres local — nunca reales.
DO $$
DECLARE
  v_user_id uuid := gen_random_uuid();
  v_email   text := 'admin@local.test';
  v_password text := 'local12345';
BEGIN
  IF EXISTS (SELECT 1 FROM auth.users WHERE email = v_email) THEN
    RETURN; -- idempotente: seed.sql corre de nuevo en cada `supabase db reset`
  END IF;

  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at, confirmation_token, recovery_token,
    email_change_token_new, email_change
  ) VALUES (
    '00000000-0000-0000-0000-000000000000', v_user_id, 'authenticated', 'authenticated',
    v_email, extensions.crypt(v_password, extensions.gen_salt('bf')),
    now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
    now(), now(), '', '', '', ''
  );

  INSERT INTO auth.identities (
    id, user_id, provider_id, identity_data, provider, created_at, updated_at
  ) VALUES (
    gen_random_uuid(), v_user_id, v_user_id::text,
    jsonb_build_object('sub', v_user_id::text, 'email', v_email),
    'email', now(), now()
  );

  INSERT INTO user_profiles (email, role_id, is_active)
  VALUES (v_email, 1, true); -- role_id 1 = admin
END $$;

-- ── 2. Observaciones sintéticas — Perú (Lima) ───────────────────────────
-- 4 semanas recientes x 3 días muestreados x 6 brackets x 4 competidores.
-- Precio = base por bracket + jitter aleatorio, para que percentiles y
-- gráficos de volatilidad tengan variación real que mostrar.
INSERT INTO pricing_observations (
  country, city, category, competition_name, observed_date, observed_time,
  distance_km, distance_bracket, price_without_discount, price_with_discount,
  data_source
)
SELECT
  'Peru', 'Lima', 'Economy/Comfort', comp.name,
  d.day::date,
  ('08:00'::time + (random() * interval '12 hours')),
  bracket.km + (random() * 1.5),
  bracket.name,
  ROUND((bracket.base_price + (random() * bracket.base_price * 0.4) + comp.price_offset)::numeric, 2),
  ROUND((bracket.base_price + (random() * bracket.base_price * 0.4) + comp.price_offset)::numeric * 0.95, 2),
  'manual'
FROM generate_series(CURRENT_DATE - interval '27 days', CURRENT_DATE, interval '9 days') AS d(day)
CROSS JOIN (VALUES
  ('very_short', 1.0,  8.0),
  ('short',      3.0, 13.0),
  ('median',     5.0, 18.0),
  ('average',    7.0, 24.0),
  ('long',       9.0, 30.0),
  ('very_long', 15.0, 42.0)
) AS bracket(name, km, base_price)
CROSS JOIN (VALUES
  ('Yango',   0.0),
  ('Uber',    1.5),
  ('InDrive', -1.0),
  ('Didi',    0.5)
) AS comp(name, price_offset);

-- ── 3. Observaciones sintéticas — Colombia (Bogotá), set más chico ─────
INSERT INTO pricing_observations (
  country, city, category, competition_name, observed_date, observed_time,
  distance_km, distance_bracket, price_without_discount, price_with_discount,
  data_source
)
SELECT
  'Colombia', 'Bogota', 'Economy/Comfort', comp.name,
  d.day::date,
  ('08:00'::time + (random() * interval '12 hours')),
  bracket.km + (random() * 1.5),
  bracket.name,
  ROUND((bracket.base_price + (random() * bracket.base_price * 0.4) + comp.price_offset)::numeric, 2),
  ROUND((bracket.base_price + (random() * bracket.base_price * 0.4) + comp.price_offset)::numeric * 0.95, 2),
  'manual'
FROM generate_series(CURRENT_DATE - interval '13 days', CURRENT_DATE, interval '6 days') AS d(day)
CROSS JOIN (VALUES
  ('very_short', 1.0,  6000.0),
  ('short',      3.0, 10000.0),
  ('median',     5.0, 14000.0),
  ('average',    7.0, 18000.0),
  ('long',       9.0, 23000.0),
  ('very_long', 15.0, 32000.0)
) AS bracket(name, km, base_price)
CROSS JOIN (VALUES
  ('Yango', 0.0),
  ('Uber',  600.0),
  ('Didi',  -400.0)
) AS comp(name, price_offset);
