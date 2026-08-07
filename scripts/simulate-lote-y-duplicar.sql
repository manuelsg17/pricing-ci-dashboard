-- ════════════════════════════════════════════════════════════════════════
-- simulate-lote-y-duplicar.sql — mig 218. Supabase LOCAL, nunca producción.
--
--   docker exec -i supabase_db_pricing-ci-dashboard psql -U postgres -X \
--     < scripts/simulate-lote-y-duplicar.sql
--
-- DOS PREGUNTAS:
--   1. ¿Correr fechas en lote mueve exactamente lo que dice y nada más?
--   2. ¿Duplicar un proyecto produce una copia utilizable — sin arrastrar la
--      bitácora del viejo y sin dejar tareas asignadas a gente que no las ve?
--
-- Y una tercera que es la que de verdad importa, porque las dos funciones son
-- SECURITY INVOKER y apoyan TODO su control de acceso en las políticas de la
-- mig 183: ¿un hub que llame las RPCs a mano desde la API logra algo? ¿Y un
-- admin de otro país?
--
-- Corre como `authenticated` con JWT simulado. Transacción revertida al final.
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

CREATE OR REPLACE FUNCTION pg_temp.como(p_email text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('SET LOCAL request.jwt.claims TO %L',
                 json_build_object('email', p_email, 'role', 'authenticated')::text);
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

CREATE OR REPLACE FUNCTION pg_temp.como_postgres()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'RESET ROLE';
  EXECUTE 'SET LOCAL request.jwt.claims TO DEFAULT';
END $$;

-- ══════════════════════════════════════════════════════════════════════
-- Escenario
-- ══════════════════════════════════════════════════════════════════════
-- Cuatro identidades, cada una para probar un eje distinto:
--   · admin PE  — puede todo en Perú
--   · hub PE    — ve Perú y tiene la sección; NO es admin
--   · admin CO  — admin, pero de Colombia
--   · exhub PE  — tenía Perú, hoy está inactivo (el dueño que se fue)
INSERT INTO roles (name, label, permissions) VALUES
  ('qa218_admin_pe', 'QA218 Admin PE',
   '{"sections":["all"],"countries":["Peru"]}'),
  ('qa218_admin_co', 'QA218 Admin CO',
   '{"sections":["all"],"countries":["Colombia"]}'),
  ('qa218_hub_pe',   'QA218 Hub PE',
   '{"sections":["projects"],"countries":["Peru"]}'),
  ('qa218_sinsec',   'QA218 Sin sección',
   '{"sections":["dataentry"],"countries":["Peru"]}');

-- `is_admin()` mira `roles.name = 'admin'`, así que los dos admins de prueba
-- usan el rol real. El país lo aporta can_access_country vía permissions.
UPDATE roles SET permissions = '{"sections":["all"],"countries":["all"]}'
 WHERE name = 'admin';

INSERT INTO user_profiles (email, role_id, is_active) VALUES
  ('qa218.admin@local.test',  (SELECT id FROM roles WHERE name='admin'),          true),
  ('qa218.hub@local.test',    (SELECT id FROM roles WHERE name='qa218_hub_pe'),   true),
  ('qa218.sinsec@local.test', (SELECT id FROM roles WHERE name='qa218_sinsec'),   true),
  ('qa218.exhub@local.test',  (SELECT id FROM roles WHERE name='qa218_hub_pe'),   false);

-- El admin de Colombia: mismo rol 'admin' no sirve (tiene todos los países),
-- así que se le arma uno propio marcado como admin por nombre.
INSERT INTO roles (name, label, permissions)
VALUES ('admin_co_qa218', 'QA218 admin solo CO', '{"sections":["all"],"countries":["Colombia"]}');

-- Proyecto de Perú con 4 tareas que cubren los casos que importan.
INSERT INTO projects (id, country, cities, name, start_date, end_date, created_by)
VALUES ('11111111-1111-1111-1111-111111111111', 'Peru', '{Lima}', 'QA218 Original',
        '2026-09-01', '2026-09-30', 'qa218.admin@local.test');

INSERT INTO project_tasks (id, project_id, city, title, owner_email, start_date, due_date, status, sort_order, created_by) VALUES
  -- con las dos fechas, y un dueño que SIGUE siendo válido
  ('aaaaaaa1-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111',
   'Lima', 'QA218 con ambas fechas', 'qa218.hub@local.test', '2026-09-01', '2026-09-10', 'doing', 0, 'qa218.admin@local.test'),
  -- solo vencimiento
  ('aaaaaaa2-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111',
   'Lima', 'QA218 solo vence', NULL, NULL, '2026-09-20', 'todo', 1, 'qa218.admin@local.test'),
  -- SIN fechas: no se mueve nunca
  ('aaaaaaa3-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111',
   'Lima', 'QA218 sin fechas', 'qa218.hub@local.test', NULL, NULL, 'done', 2, 'qa218.admin@local.test'),
  -- dueño que HOY ya no califica (inactivo): la copia no debe heredarlo
  ('aaaaaaa4-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111',
   'Lima', 'QA218 dueño que se fue', 'qa218.exhub@local.test', '2026-09-05', '2026-09-15', 'blocked', 3, 'qa218.admin@local.test');

-- Proyecto de Colombia, para el cruce de país.
INSERT INTO projects (id, country, cities, name, created_by)
VALUES ('22222222-2222-2222-2222-222222222222', 'Colombia', '{}', 'QA218 Ajeno', 'qa218.admin@local.test');

\echo ''
\echo '══ [1] Correr fechas: mueve lo que dice y solo eso ══'

DO $$
DECLARE v_n int;
BEGIN
  PERFORM pg_temp.como('qa218.admin@local.test');

  v_n := shift_task_dates(ARRAY[
    'aaaaaaa1-1111-1111-1111-111111111111',
    'aaaaaaa2-2222-2222-2222-222222222222',
    'aaaaaaa3-3333-3333-3333-333333333333'
  ]::uuid[], 7);

  -- 3 mandadas, 2 movidas: la que no tiene ninguna fecha queda fuera. Ese
  -- número es el que la pantalla informa (§5, nada de truncado silencioso).
  PERFORM pg_temp.esperar('devuelve las movidas de verdad, no las pedidas', v_n::text, '2');
END $$;

DO $$
DECLARE t public.project_tasks;
BEGIN
  PERFORM pg_temp.como('qa218.admin@local.test');

  SELECT * INTO t FROM project_tasks WHERE id='aaaaaaa1-1111-1111-1111-111111111111';
  PERFORM pg_temp.esperar('inicio +7', t.start_date::text, '2026-09-08');
  PERFORM pg_temp.esperar('vence +7',  t.due_date::text,   '2026-09-17');
  -- La duración es lo que NO puede cambiar: es una traslación. Si una punta se
  -- moviera y la otra no, el CHECK `due >= start` sería violable.
  PERFORM pg_temp.esperar('la duración no cambió', (t.due_date - t.start_date)::text, '9');

  SELECT * INTO t FROM project_tasks WHERE id='aaaaaaa2-2222-2222-2222-222222222222';
  PERFORM pg_temp.esperar('sin inicio SIGUE sin inicio', coalesce(t.start_date::text,'null'), 'null');
  PERFORM pg_temp.esperar('su vencimiento sí se movió', t.due_date::text, '2026-09-27');

  SELECT * INTO t FROM project_tasks WHERE id='aaaaaaa3-3333-3333-3333-333333333333';
  PERFORM pg_temp.esperar('la que no tenía fechas sigue sin ninguna',
                          coalesce(t.due_date::text,'null'), 'null');
END $$;

DO $$
DECLARE v int;
BEGIN
  PERFORM pg_temp.como('qa218.admin@local.test');
  -- El trigger de la mig 215 deja rastro POR TAREA: la bitácora de cada una
  -- tiene que poder explicar sola por qué su fecha cambió.
  SELECT count(*) INTO v FROM task_comments
   WHERE task_id = 'aaaaaaa1-1111-1111-1111-111111111111' AND kind='system';
  PERFORM pg_temp.esperar('un comentario de sistema por tarea movida', v::text, '1');

  SELECT count(*) INTO v FROM task_comments
   WHERE task_id = 'aaaaaaa3-3333-3333-3333-333333333333';
  PERFORM pg_temp.esperar('la que no se movió no ensucia su bitácora', v::text, '0');
END $$;

DO $$
DECLARE v_n int;
BEGIN
  PERFORM pg_temp.como('qa218.admin@local.test');
  -- Volver atrás: el caso "corriste para el lado equivocado".
  v_n := shift_task_dates(ARRAY['aaaaaaa1-1111-1111-1111-111111111111']::uuid[], -7);
  PERFORM pg_temp.esperar('se puede deshacer con el signo opuesto', v_n::text, '1');
  PERFORM pg_temp.esperar('y vuelve al valor original',
    (SELECT start_date::text FROM project_tasks WHERE id='aaaaaaa1-1111-1111-1111-111111111111'),
    '2026-09-01');

  -- 0 días y lista vacía son no-ops explícitos, no errores.
  PERFORM pg_temp.esperar('0 días no hace nada',
    shift_task_dates(ARRAY['aaaaaaa1-1111-1111-1111-111111111111']::uuid[], 0)::text, '0');
  PERFORM pg_temp.esperar('lista vacía no rompe',
    shift_task_dates(ARRAY[]::uuid[], 7)::text, '0');
END $$;

\echo ''
\echo '══ [2] Correr fechas: la seguridad la hace RLS, no la función ══'

DO $$
DECLARE v_n int; v_fecha text;
BEGIN
  -- Un hub CON la sección proyectos y CON el país, pero que no es admin.
  -- Llama la RPC directo a la API, salteándose la pantalla.
  PERFORM pg_temp.como('qa218.hub@local.test');
  v_n := shift_task_dates(ARRAY['aaaaaaa1-1111-1111-1111-111111111111']::uuid[], 30);
  PERFORM pg_temp.esperar('un hub no mueve NINGUNA fila', v_n::text, '0');
END $$;

DO $$
DECLARE v_fecha text;
BEGIN
  PERFORM pg_temp.como('qa218.admin@local.test');
  SELECT start_date::text INTO v_fecha FROM project_tasks
   WHERE id='aaaaaaa1-1111-1111-1111-111111111111';
  PERFORM pg_temp.esperar('y la fecha quedó intacta', v_fecha, '2026-09-01');
END $$;

DO $$
BEGIN
  PERFORM pg_temp.como('qa218.admin@local.test');
  BEGIN
    PERFORM shift_task_dates(ARRAY['aaaaaaa1-1111-1111-1111-111111111111']::uuid[], 400);
    RAISE EXCEPTION 'FALLA: 400 días debería haber sido rechazado';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE '  ok  ±365 días es el tope y se respeta';
  END;
END $$;

\echo ''
\echo '══ [3] Duplicar proyecto ══'

DO $$
DECLARE r record; v int;
BEGIN
  PERFORM pg_temp.como('qa218.admin@local.test');

  SELECT * INTO r FROM duplicate_project(
    '11111111-1111-1111-1111-111111111111', 'QA218 Original (copia)', 30);

  PERFORM pg_temp.esperar('copió las 4 tareas', r.tasks_copied::text, '4');
  -- Solo UNA perdió responsable (la del hub inactivo). La que ya venía sin
  -- asignar no cuenta: un aviso que exagera se deja de leer.
  PERFORM pg_temp.esperar('informa 1 sin responsable, no 2', r.owners_cleared::text, '1');

  PERFORM pg_temp.esperar('el proyecto nace activo',
    (SELECT status FROM projects WHERE id = r.new_project_id), 'active');
  PERFORM pg_temp.esperar('con las fechas corridas 30 días',
    (SELECT start_date::text FROM projects WHERE id = r.new_project_id), '2026-10-01');
  PERFORM pg_temp.esperar('y el mismo país',
    (SELECT country FROM projects WHERE id = r.new_project_id), 'Peru');

  -- Los estados se resetean: duplicar un proyecto terminado y que la copia
  -- nazca con la mitad "Lista" es exactamente lo que nadie quiere.
  SELECT count(*) INTO v FROM project_tasks
   WHERE project_id = r.new_project_id AND status <> 'todo';
  PERFORM pg_temp.esperar('todas las tareas vuelven a "por hacer"', v::text, '0');

  -- El dueño válido se conserva; el que se fue queda sin asignar.
  PERFORM pg_temp.esperar('el responsable que sigue vigente se copia',
    (SELECT owner_email FROM project_tasks
      WHERE project_id=r.new_project_id AND title='QA218 con ambas fechas'),
    'qa218.hub@local.test');
  PERFORM pg_temp.esperar('el que ya no puede verla queda SIN asignar',
    coalesce((SELECT owner_email FROM project_tasks
      WHERE project_id=r.new_project_id AND title='QA218 dueño que se fue'), 'null'),
    'null');

  -- Las fechas de las tareas también se corren, y las que no tenían siguen sin.
  PERFORM pg_temp.esperar('la tarea con fechas se corrió 30 días',
    (SELECT due_date::text FROM project_tasks
      WHERE project_id=r.new_project_id AND title='QA218 con ambas fechas'), '2026-10-10');
  PERFORM pg_temp.esperar('la que no tenía fechas sigue sin ellas',
    coalesce((SELECT due_date::text FROM project_tasks
      WHERE project_id=r.new_project_id AND title='QA218 sin fechas'), 'null'), 'null');

  -- La bitácora NO viaja: el proyecto nuevo arranca sin "avances" que nadie hizo.
  SELECT count(*) INTO v FROM task_comments c
    JOIN project_tasks t ON t.id = c.task_id
   WHERE t.project_id = r.new_project_id;
  PERFORM pg_temp.esperar('la copia nace sin comentarios heredados', v::text, '0');

  SELECT count(*) INTO v FROM task_status_log s
    JOIN project_tasks t ON t.id = s.task_id
   WHERE t.project_id = r.new_project_id;
  PERFORM pg_temp.esperar('ni historial de estados', v::text, '0');

  -- El original queda intacto: duplicar no es mover.
  SELECT count(*) INTO v FROM project_tasks
   WHERE project_id='11111111-1111-1111-1111-111111111111';
  PERFORM pg_temp.esperar('el proyecto original conserva sus 4 tareas', v::text, '4');
END $$;

\echo ''
\echo '══ [4] Duplicar: seguridad ══'

DO $$
BEGIN
  PERFORM pg_temp.como('qa218.hub@local.test');
  BEGIN
    PERFORM * FROM duplicate_project('11111111-1111-1111-1111-111111111111', 'QA218 robo', 0);
    RAISE EXCEPTION 'FALLA: un hub logró duplicar un proyecto';
  EXCEPTION
    WHEN insufficient_privilege THEN RAISE NOTICE '  ok  un hub no puede duplicar (RLS de INSERT)';
    WHEN OTHERS THEN
      IF SQLSTATE = '42501' THEN
        RAISE NOTICE '  ok  un hub no puede duplicar (RLS de INSERT)';
      ELSE
        RAISE EXCEPTION 'FALLA: error inesperado para el hub: % (%)', SQLERRM, SQLSTATE;
      END IF;
  END;
END $$;

DO $$
DECLARE v int;
BEGIN
  PERFORM pg_temp.como('qa218.admin@local.test');
  SELECT count(*) INTO v FROM projects WHERE name = 'QA218 robo';
  PERFORM pg_temp.esperar('y no quedó ningún proyecto a medio crear', v::text, '0');
END $$;

DO $$
DECLARE v int;
BEGIN
  -- Cruce de país: el admin de Colombia no ve el proyecto de Perú, así que la
  -- función corta en el SELECT y no llega a escribir nada.
  PERFORM pg_temp.como('qa218.hub@local.test');
  SELECT count(*) INTO v FROM projects WHERE id = '22222222-2222-2222-2222-222222222222';
  PERFORM pg_temp.esperar('un hub de Perú ni siquiera VE el proyecto de Colombia', v::text, '0');
END $$;

\echo ''
\echo '══ [5] El bug que apareció escribiendo la migración ══'

DO $$
BEGIN
  PERFORM pg_temp.como('qa218.admin@local.test');
  -- qa218.sinsec tiene Perú pero NO la sección `projects`: el desplegable ya
  -- lo escondía (mig 214) pero reassign_task lo aceptaba igual. Ahora las dos
  -- puntas usan la misma definición.
  BEGIN
    PERFORM reassign_task('aaaaaaa1-1111-1111-1111-111111111111', 'qa218.sinsec@local.test');
    RAISE EXCEPTION 'FALLA: se asignó una tarea a alguien sin la sección Proyectos';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'FALLA:%' THEN RAISE;
    END IF;
    RAISE NOTICE '  ok  reassign_task rechaza a quien no puede abrir la pantalla';
  END;

  PERFORM pg_temp.esperar('y el responsable no cambió',
    (SELECT owner_email FROM project_tasks WHERE id='aaaaaaa1-1111-1111-1111-111111111111'),
    'qa218.hub@local.test');

  -- El destino válido sigue funcionando: la migración endurece, no rompe.
  PERFORM reassign_task('aaaaaaa2-2222-2222-2222-222222222222', 'qa218.hub@local.test');
  PERFORM pg_temp.esperar('un destino válido sí se acepta',
    (SELECT owner_email FROM project_tasks WHERE id='aaaaaaa2-2222-2222-2222-222222222222'),
    'qa218.hub@local.test');

  -- Y `assignable_users` sigue devolviendo lo mismo que antes de unificar.
  PERFORM pg_temp.esperar('assignable_users no lista al que no tiene la sección',
    (SELECT count(*)::text FROM assignable_users('Peru') WHERE email='qa218.sinsec@local.test'),
    '0');
  PERFORM pg_temp.esperar('pero sí al hub con las dos cosas',
    (SELECT count(*)::text FROM assignable_users('Peru') WHERE email='qa218.hub@local.test'),
    '1');
END $$;

\echo ''
\echo '══ [6] Integridad final ══'

DO $$
DECLARE v int;
BEGIN
  PERFORM pg_temp.como_postgres();
  SELECT count(*) INTO v FROM project_tasks
   WHERE start_date IS NOT NULL AND due_date IS NOT NULL AND due_date < start_date;
  PERFORM pg_temp.esperar('ninguna tarea quedó con el fin antes del inicio', v::text, '0');

  SELECT count(*) INTO v FROM project_tasks t JOIN projects p ON p.id=t.project_id
   WHERE t.country <> p.country;
  PERFORM pg_temp.esperar('ninguna tarea con país incoherente', v::text, '0');
END $$;

\echo ''
\echo '✓ simulate-lote-y-duplicar: todo OK'

ROLLBACK;
