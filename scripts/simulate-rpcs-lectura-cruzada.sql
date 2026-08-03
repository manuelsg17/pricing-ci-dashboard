-- ════════════════════════════════════════════════════════════════════════
-- simulate-rpcs-lectura-cruzada.sql — mig 206, parte A.
-- Correr contra Supabase LOCAL, nunca producción.
--
--   docker exec -i supabase_db_pricing-ci-dashboard psql -U postgres -X \
--     < scripts/simulate-rpcs-lectura-cruzada.sql
--
-- LA PREGUNTA: ¿el gate nuevo de `get_ci_session_turno_timings` y
-- `get_active_sessions_presence` cierra al que no tiene la sección SIN romper
-- al hub que sí la tiene? Las dos features que dependen de estas RPCs —el
-- relevo entre hubs y el puntito verde de presencia— son de uso normal del hub,
-- así que un gate de más acá se ve como "el relevo dejó de andar".
--
-- TODO CORRE COMO `authenticated` CON JWT SIMULADO. Correrlo como `postgres`
-- no probaría nada: SECURITY DEFINER + superusuario pasa por arriba de todo, y
-- así fue exactamente como una batería anterior de este repo dio verde sobre
-- una fuga abierta (sesión 2026-08-02).
--
-- Transacción que se REVIERTE: no deja roles, perfiles ni sesiones de prueba.
-- No toca auth.users (CLAUDE.md §2).
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

\set ON_ERROR_STOP on
\pset pager off

CREATE OR REPLACE FUNCTION pg_temp.esperar(p_caso text, p_obtenido text, p_esperado text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_obtenido IS DISTINCT FROM p_esperado THEN
    RAISE EXCEPTION E'\n  ✗ FALLA: %\n    esperado=% obtenido=%', p_caso, p_esperado, p_obtenido;
  END IF;
  RAISE NOTICE '  ok  % → %', p_caso, p_obtenido;
END $$;

-- Corre una expresión como el usuario dado y devuelve 'ok', 'denegado' o el
-- SQLSTATE crudo si falló por otra cosa. Distinguir eso importa: un 42P01 o un
-- 42883 disfrazado de "denegado" haría pasar el test por el motivo equivocado.
CREATE OR REPLACE FUNCTION pg_temp.como(p_email text, p_sql text)
RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('SET LOCAL request.jwt.claims TO %L',
                 json_build_object('email', p_email, 'role', 'authenticated')::text);
  SET LOCAL ROLE authenticated;
  BEGIN
    EXECUTE p_sql;
    RESET ROLE;
    RETURN 'ok';
  EXCEPTION
    WHEN insufficient_privilege THEN RESET ROLE; RETURN 'denegado';
    WHEN OTHERS THEN RESET ROLE; RETURN SQLSTATE;
  END;
END $$;

-- ── Roles de prueba ───────────────────────────────────────────────────
INSERT INTO roles (name, label, permissions) VALUES
  ('qa206_sin_seccion',  'QA sin sección',  '{"sections": [],            "countries": ["Peru"]}'),
  ('qa206_hub',          'QA hub',          '{"sections": ["dataentry"], "countries": ["Peru"]}'),
  ('qa206_otra_seccion', 'QA otra sección', '{"sections": ["dashboard"], "countries": ["Peru"]}');

INSERT INTO user_profiles (email, role_id, is_active)
SELECT 'qa206.' || split_part(r.name, '_', 2) || '@local.test', r.id, true
FROM roles r WHERE r.name LIKE 'qa206_%';

-- Nombres reales de los perfiles recién creados (el split de arriba deja
-- 'qa206.sin@local.test', etc. — se leen de la tabla para no adivinar).
CREATE TEMP TABLE qa_users AS
SELECT r.name AS rol, up.email
FROM roles r JOIN user_profiles up ON up.role_id = r.id
WHERE r.name LIKE 'qa206_%';

-- ── Datos que las RPCs tienen que poder devolver ──────────────────────
INSERT INTO ci_sessions (user_email, country, city, zone, observed_date,
                         started_at, ended_at, rows_saved, turno_timings)
VALUES ('otro.hub@local.test', 'Peru', 'Lima', '', current_date,
        now() - interval '2 hours', now() - interval '1 hour', 108,
        '{"Mañana": {"start": "2026-08-03T09:00:00Z", "end": "2026-08-03T10:00:00Z"}}'::jsonb);

INSERT INTO ci_active_sessions (user_email, country, city, zone, observed_date, last_seen_at, fronts)
VALUES ('otro.hub@local.test', 'Peru', 'Lima', NULL, current_date, now(), NULL);

DO $$
DECLARE
  v_sin  text := (SELECT email FROM qa_users WHERE rol = 'qa206_sin_seccion');
  v_hub  text := (SELECT email FROM qa_users WHERE rol = 'qa206_hub');
  v_otra text := (SELECT email FROM qa_users WHERE rol = 'qa206_otra_seccion');
  -- SELECT, no PERFORM: `EXECUTE` corre SQL plano, no plpgsql. La primera
  -- versión usaba PERFORM y daba 42601 (error de sintaxis) — que el helper
  -- devuelva el SQLSTATE crudo en vez de 'denegado' es justo lo que evitó que
  -- este test pasara por el motivo equivocado.
  v_timings text := format(
    'SELECT get_ci_session_turno_timings(%L, %L, %L, %L::date)',
    'Peru', 'Lima', '', current_date);
  v_presencia text := 'SELECT * FROM get_active_sessions_presence(''Peru'')';
  v_timings_co text := format(
    'SELECT get_ci_session_turno_timings(%L, %L, %L, %L::date)',
    'Colombia', 'Bogota', '', current_date);
BEGIN
  RAISE NOTICE E'\n── El agujero que la 206 cierra ─────────────────────────';
  -- Antes de la 206 los tres decían 'ok': alcanzaba con tener el país.
  PERFORM pg_temp.esperar('sin ninguna sección · timings',
                          pg_temp.como(v_sin, v_timings), 'denegado');
  PERFORM pg_temp.esperar('sin ninguna sección · presencia',
                          pg_temp.como(v_sin, v_presencia), 'denegado');
  PERFORM pg_temp.esperar('con otra sección (dashboard) · timings',
                          pg_temp.como(v_otra, v_timings), 'denegado');
  PERFORM pg_temp.esperar('con otra sección (dashboard) · presencia',
                          pg_temp.como(v_otra, v_presencia), 'denegado');

  RAISE NOTICE E'\n── Y lo que NO se puede romper: el hub real ─────────────';
  -- Si alguno de estos dice 'denegado', el relevo entre hubs y el puntito
  -- verde de presencia dejaron de funcionar. Es el modo de falla caro de
  -- este cambio, no la fuga.
  PERFORM pg_temp.esperar('hub con dataentry · timings de OTRO hub',
                          pg_temp.como(v_hub, v_timings), 'ok');
  PERFORM pg_temp.esperar('hub con dataentry · presencia de compañeros',
                          pg_temp.como(v_hub, v_presencia), 'ok');

  RAISE NOTICE E'\n── El eje que ya estaba y sigue ─────────────────────────';
  PERFORM pg_temp.esperar('hub con dataentry · país ajeno',
                          pg_temp.como(v_hub, v_timings_co), 'denegado');
END $$;

-- ── El contenido, no solo el permiso ──────────────────────────────────
-- Que devuelva 'ok' no prueba que devuelva algo: una RPC que pasa el gate y
-- trae cero filas también dice 'ok', y el relevo estaría igual de roto.
DO $$
DECLARE
  v_hub text := (SELECT email FROM qa_users WHERE rol = 'qa206_hub');
  v_timings jsonb;
  v_presentes int;
BEGIN
  EXECUTE format('SET LOCAL request.jwt.claims TO %L',
                 json_build_object('email', v_hub, 'role', 'authenticated')::text);
  SET LOCAL ROLE authenticated;
  v_timings := get_ci_session_turno_timings('Peru', 'Lima', '', current_date);
  SELECT count(*) INTO v_presentes FROM get_active_sessions_presence('Peru');
  RESET ROLE;

  RAISE NOTICE E'\n── El dato llega de verdad ─────────────────────────────';
  PERFORM pg_temp.esperar('los timings del otro hub llegan',
                          (v_timings ? 'Mañana')::text, 'true');
  PERFORM pg_temp.esperar('el otro hub aparece en presencia',
                          (v_presentes >= 1)::text, 'true');
END $$;

-- ── anon no llega ni a la puerta ──────────────────────────────────────
DO $$
DECLARE v_r text;
BEGIN
  RAISE NOTICE E'\n── anon ────────────────────────────────────────────────';
  SET LOCAL ROLE anon;
  BEGIN
    PERFORM get_active_sessions_presence('Peru');
    v_r := 'ok';
  EXCEPTION WHEN OTHERS THEN v_r := SQLSTATE;
  END;
  RESET ROLE;
  -- 42501 = sin EXECUTE. Cualquier 'ok' acá sería una fuga sin login.
  PERFORM pg_temp.esperar('anon · presencia', v_r, '42501');
END $$;

ROLLBACK;
