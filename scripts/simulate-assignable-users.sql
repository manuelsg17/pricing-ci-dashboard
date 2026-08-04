-- ════════════════════════════════════════════════════════════════════════
-- Mig 214 — `assignable_users` filtraba por país y no por sección, así que se
-- podía asignar una tarea a alguien que no puede abrir Proyectos.
--
-- Lo que hay que probar es el agujero (el candidato sin sección desaparece) Y
-- que no se cierre de más: el admin, el comodín 'all' y el flujo de quien
-- pregunta tienen que seguir funcionando.
--
-- Corre con `docker exec ... psql -U postgres` y revierte todo al final.
-- ════════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP on
\pset pager off

BEGIN;

CREATE OR REPLACE FUNCTION pg_temp.ok(p_cond boolean, p_msg text, p_got text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_cond THEN RAISE NOTICE '  ok  % %', p_msg, COALESCE('→ ' || p_got, '');
  ELSE RAISE EXCEPTION 'FALLÓ: % %', p_msg, COALESCE('→ ' || p_got, '');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.rol(p_nombre text, p_perms jsonb) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE v_id int;
BEGIN
  INSERT INTO roles (name, label, permissions) VALUES (p_nombre, p_nombre, p_perms)
  ON CONFLICT (name) DO UPDATE SET permissions = EXCLUDED.permissions
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.usuario(p_email text, p_rol int, p_activo boolean DEFAULT true)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO user_profiles (email, role_id, is_active) VALUES (p_email, p_rol, p_activo)
  ON CONFLICT (email) DO UPDATE SET role_id = EXCLUDED.role_id, is_active = EXCLUDED.is_active;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.como(p_email text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', p_email, 'role','authenticated')::text, true);
END $$;

DO $$
DECLARE
  r_con    int; r_sin int; r_all int; r_adm int; r_otro int;
  v_lista  text[];
BEGIN
  -- El escenario real: mismo país, distinta sección.
  r_con  := pg_temp.rol('qa214_con',  '{"sections":["projects","dataentry"],"countries":["Peru"]}');
  r_sin  := pg_temp.rol('qa214_sin',  '{"sections":["dataentry"],"countries":["Peru"]}');
  r_all  := pg_temp.rol('qa214_all',  '{"sections":["all"],"countries":["Peru"]}');
  r_adm  := pg_temp.rol('admin',      (SELECT permissions FROM roles WHERE name='admin'));
  r_otro := pg_temp.rol('qa214_otro', '{"sections":["projects"],"countries":["Colombia"]}');

  PERFORM pg_temp.usuario('qa214.con@local.test',  r_con);
  PERFORM pg_temp.usuario('qa214.sin@local.test',  r_sin);
  PERFORM pg_temp.usuario('qa214.all@local.test',  r_all);
  PERFORM pg_temp.usuario('qa214.baja@local.test', r_con, false);
  PERFORM pg_temp.usuario('qa214.otro@local.test', r_otro);

  PERFORM pg_temp.como('qa214.con@local.test');
  SELECT array_agg(email ORDER BY email) INTO v_lista FROM assignable_users('Peru');

  RAISE NOTICE '';
  RAISE NOTICE '── El agujero que cierra la 214 ─────────────────────────────';
  PERFORM pg_temp.ok(NOT ('qa214.sin@local.test' = ANY(v_lista)),
    'un candidato CON el país pero SIN la sección ya NO aparece', 'era el agujero');

  RAISE NOTICE '';
  RAISE NOTICE '── Y lo que NO se puede cerrar de más ───────────────────────';
  PERFORM pg_temp.ok('qa214.con@local.test' = ANY(v_lista),
    'con el país Y la sección proyectos → aparece');
  PERFORM pg_temp.ok('qa214.all@local.test' = ANY(v_lista),
    'el comodín sections:[all] → aparece');
  PERFORM pg_temp.ok(NOT ('qa214.baja@local.test' = ANY(v_lista)),
    'un usuario dado de baja no aparece');
  PERFORM pg_temp.ok(NOT ('qa214.otro@local.test' = ANY(v_lista)),
    'un candidato de otro país no aparece');
  PERFORM pg_temp.ok(
    EXISTS (SELECT 1 FROM user_profiles up JOIN roles r ON r.id=up.role_id
             WHERE r.name='admin' AND up.is_active AND up.email = ANY(v_lista)),
    'el admin aparece siempre (can_access_section cortocircuita en is_admin)');
END $$;

DO $$
DECLARE v_n int;
BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '── El gate de QUIEN PREGUNTA no cambió ──────────────────────';
  -- Un hub de Colombia preguntando por Perú: la RPC no debe listarle nada.
  PERFORM pg_temp.como('qa214.otro@local.test');
  SELECT count(*) INTO v_n FROM assignable_users('Peru');
  PERFORM pg_temp.ok(v_n = 0,
    'quien no tiene el país sigue recibiendo lista vacía', v_n::text);
END $$;

DO $$ BEGIN
  RAISE NOTICE '';
  RAISE NOTICE '✓ TODAS LAS SIMULACIONES DE LA 214 PASARON';
END $$;

ROLLBACK;
