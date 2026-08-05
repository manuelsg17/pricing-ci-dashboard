-- ════════════════════════════════════════════════════════════════════════
-- simulate-cambios-tarea.sql — mig 215. Supabase LOCAL, nunca producción.
--
--   docker exec -i supabase_db_pricing-ci-dashboard psql -U postgres -X \
--     < scripts/simulate-cambios-tarea.sql
--
-- LA PREGUNTA: cuando el admin le mueve el vencimiento o le cambia el dueño a
-- una tarea, ¿el hub se entera? Y las dos contracaras, que es donde se rompen
-- estas cosas: ¿se entera UNA vez (no dos), y NO se entera cuando no pasó nada?
--
-- Por qué importa la segunda: la regla vive en un trigger justamente para que
-- no haya dos textos que sincronizar a mano. Si `reassign_task` conservara su
-- INSERT viejo, cada reasignación dejaría dos comentarios idénticos y la
-- bitácora de la reunión sería el doble de larga.
--
-- Por qué importa la tercera: el trigger está acotado con `UPDATE OF`, que
-- mira qué columnas MENCIONA el UPDATE, no si el valor cambió. Guardar la
-- planilla sin tocar nada no puede ensuciar la bitácora.
--
-- Corre como `authenticated` con JWT simulado. Transacción revertida.
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

/** Comentarios de sistema de una tarea, del más nuevo al más viejo. */
CREATE OR REPLACE FUNCTION pg_temp.sistema(p_task uuid)
RETURNS TABLE (body text) LANGUAGE sql AS $$
  SELECT c.body FROM task_comments c
  WHERE c.task_id = p_task AND c.kind = 'system'
  ORDER BY c.id DESC;
$$;

CREATE OR REPLACE FUNCTION pg_temp.n_sistema(p_task uuid)
RETURNS int LANGUAGE sql AS $$
  SELECT count(*)::int FROM task_comments c
  WHERE c.task_id = p_task AND c.kind = 'system';
$$;

-- ── Elenco ────────────────────────────────────────────────────────────
INSERT INTO roles (name, label, permissions) VALUES
  ('qa215_hub_pe', 'QA215 hub PE', '{"sections": ["projects"], "countries": ["Peru"]}'),
  ('qa215_hub_co', 'QA215 hub CO', '{"sections": ["projects"], "countries": ["Colombia"]}');

INSERT INTO user_profiles (email, role_id, is_active) VALUES
  ('qa215.admin@local.test',    (SELECT id FROM roles WHERE name  = 'admin' LIMIT 1), true),
  ('qa215.ana@local.test',      (SELECT id FROM roles WHERE label = 'QA215 hub PE'),  true),
  ('qa215.beto@local.test',     (SELECT id FROM roles WHERE label = 'QA215 hub PE'),  true),
  ('qa215.baja@local.test',     (SELECT id FROM roles WHERE label = 'QA215 hub PE'),  false),
  ('qa215.colombia@local.test', (SELECT id FROM roles WHERE label = 'QA215 hub CO'),  true);

CREATE TEMP TABLE qa215 (proyecto uuid, tarea uuid);

INSERT INTO projects (country, name, created_by)
VALUES ('Peru', 'QA215 proyecto', 'qa215.admin@local.test');

INSERT INTO qa215 (proyecto) SELECT id FROM projects WHERE name = 'QA215 proyecto';

-- `country` lo pone el trigger de la mig 183, la app nunca lo manda.
INSERT INTO project_tasks (project_id, title, owner_email, due_date, created_by)
SELECT proyecto, 'QA215 revisar rutas', 'qa215.ana@local.test',
       DATE '2026-08-20', 'qa215.admin@local.test'
FROM qa215;

UPDATE qa215 SET tarea = (SELECT id FROM project_tasks WHERE title = 'QA215 revisar rutas');

-- ── 1. La planilla del admin: UPDATE crudo ────────────────────────────
-- Es el camino REAL que usaba la app y el que no dejaba ningún rastro.
DO $$
DECLARE v_t uuid := (SELECT tarea FROM qa215);
BEGIN
  RAISE NOTICE E'\n── UPDATE crudo del admin (el camino que no registraba nada) ──';
  PERFORM pg_temp.esperar('la tarea arranca sin comentarios de sistema',
                          pg_temp.n_sistema(v_t)::text, '0');

  PERFORM pg_temp.como('qa215.admin@local.test');
  UPDATE project_tasks SET due_date = DATE '2026-08-14' WHERE id = v_t;
  RESET ROLE;

  PERFORM pg_temp.esperar('mover el vencimiento deja UN comentario',
                          pg_temp.n_sistema(v_t)::text, '1');
  PERFORM pg_temp.esperar('y dice de qué fecha a qué fecha',
    (SELECT body FROM pg_temp.sistema(v_t) LIMIT 1),
    'qa215.admin@local.test movió el vencimiento del 2026-08-20 al 2026-08-14');
END $$;

-- ── 2. Un UPDATE que no cambia nada ───────────────────────────────────
DO $$
DECLARE v_t uuid := (SELECT tarea FROM qa215);
BEGIN
  RAISE NOTICE E'\n── Guardar sin tocar nada ──────────────────────────────';
  PERFORM pg_temp.como('qa215.admin@local.test');
  -- `UPDATE OF` dispara el trigger igual: la salida temprana es lo único que
  -- evita que esto ensucie la bitácora.
  UPDATE project_tasks SET due_date = due_date, owner_email = owner_email WHERE id = v_t;
  RESET ROLE;

  PERFORM pg_temp.esperar('no agrega ruido', pg_temp.n_sistema(v_t)::text, '1');
END $$;

-- ── 3. La RPC de reasignación: UNA vez, no dos ────────────────────────
DO $$
DECLARE v_t uuid := (SELECT tarea FROM qa215);
BEGIN
  RAISE NOTICE E'\n── reassign_task ───────────────────────────────────────';
  PERFORM pg_temp.como('qa215.admin@local.test');
  PERFORM reassign_task(v_t, 'qa215.beto@local.test');
  RESET ROLE;

  -- Antes de la 215 la RPC insertaba su propio comentario. Con el trigger
  -- puesto, conservarlo habría dado 3 acá en vez de 2.
  PERFORM pg_temp.esperar('la reasignación deja UN comentario, no dos',
                          pg_temp.n_sistema(v_t)::text, '2');
  PERFORM pg_temp.esperar('con los dos dueños',
    (SELECT body FROM pg_temp.sistema(v_t) LIMIT 1),
    'qa215.admin@local.test reasignó la tarea de qa215.ana@local.test a qa215.beto@local.test');
  PERFORM pg_temp.esperar('y la tarea quedó en el destino',
    (SELECT owner_email FROM project_tasks WHERE id = v_t), 'qa215.beto@local.test');
END $$;

-- ── 4. Dos cambios en un mismo UPDATE = un comentario ─────────────────
DO $$
DECLARE v_t uuid := (SELECT tarea FROM qa215);
BEGIN
  RAISE NOTICE E'\n── Mover fecha y reasignar de una ──────────────────────';
  PERFORM pg_temp.como('qa215.admin@local.test');
  UPDATE project_tasks
     SET owner_email = 'qa215.ana@local.test', due_date = DATE '2026-09-01'
   WHERE id = v_t;
  RESET ROLE;

  PERFORM pg_temp.esperar('un solo comentario para los dos cambios',
                          pg_temp.n_sistema(v_t)::text, '3');
  PERFORM pg_temp.esperar('que menciona los dos',
    (SELECT body FROM pg_temp.sistema(v_t) LIMIT 1),
    'qa215.admin@local.test reasignó la tarea de qa215.beto@local.test a qa215.ana@local.test'
    || ' · movió el vencimiento del 2026-08-14 al 2026-09-01');
END $$;

-- ── 5. Sacar la fecha, y ponerla desde cero ───────────────────────────
DO $$
DECLARE v_t uuid := (SELECT tarea FROM qa215);
BEGIN
  RAISE NOTICE E'\n── NULLs a los dos lados ───────────────────────────────';
  PERFORM pg_temp.como('qa215.admin@local.test');
  UPDATE project_tasks SET due_date = NULL WHERE id = v_t;
  RESET ROLE;
  PERFORM pg_temp.esperar('quitar la fecha se dice en castellano',
    (SELECT body FROM pg_temp.sistema(v_t) LIMIT 1),
    'qa215.admin@local.test movió el vencimiento del 2026-09-01 al sin fecha');

  PERFORM pg_temp.como('qa215.admin@local.test');
  UPDATE project_tasks SET owner_email = NULL WHERE id = v_t;
  RESET ROLE;
  PERFORM pg_temp.esperar('y desasignar también',
    (SELECT body FROM pg_temp.sistema(v_t) LIMIT 1),
    'qa215.admin@local.test reasignó la tarea de qa215.ana@local.test a sin asignar');
END $$;

-- ── 6. Lo que la RPC sigue haciendo y el trigger no puede ─────────────
-- El trigger registra; validar el destino es de la RPC. Si la app volviera al
-- UPDATE crudo perdería esto, que es la otra mitad del arreglo.
CREATE OR REPLACE FUNCTION pg_temp.reasignar(p_admin text, p_to text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_msg text; v_t uuid := (SELECT tarea FROM qa215);
BEGIN
  PERFORM pg_temp.como(p_admin);
  BEGIN
    PERFORM reassign_task(v_t, p_to);
    RESET ROLE;
    RETURN 'ok';
  EXCEPTION
    WHEN insufficient_privilege THEN RESET ROLE; RETURN 'denegado';
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      RESET ROLE;
      RETURN 'rechazado';
  END;
END $$;

DO $$
DECLARE v_t uuid := (SELECT tarea FROM qa215); v_n int;
BEGIN
  RAISE NOTICE E'\n── Destinos que la RPC rechaza (§15.2) ─────────────────';
  v_n := pg_temp.n_sistema(v_t);

  PERFORM pg_temp.esperar('email inexistente',
                          pg_temp.reasignar('qa215.admin@local.test', 'qa215.nadie@local.test'), 'rechazado');
  PERFORM pg_temp.esperar('usuario dado de baja',
                          pg_temp.reasignar('qa215.admin@local.test', 'qa215.baja@local.test'), 'rechazado');
  PERFORM pg_temp.esperar('hub de otro país (sería un agujero negro)',
                          pg_temp.reasignar('qa215.admin@local.test', 'qa215.colombia@local.test'), 'rechazado');
  PERFORM pg_temp.esperar('un hub no puede reasignar',
                          pg_temp.reasignar('qa215.ana@local.test', 'qa215.beto@local.test'), 'denegado');

  PERFORM pg_temp.esperar('ningún rechazo dejó comentario',
                          pg_temp.n_sistema(v_t)::text, v_n::text);
  PERFORM pg_temp.esperar('ni movió el dueño',
                          coalesce((SELECT owner_email FROM project_tasks WHERE id = v_t), 'sin asignar'),
                          'sin asignar');
END $$;

-- ── 7. El comentario le llega al hub ──────────────────────────────────
-- De nada sirve escribirlo si RLS se lo esconde: el hub lee task_comments por
-- la política de SELECT por país, y el trigger es SECURITY DEFINER.
DO $$
DECLARE v_t uuid := (SELECT tarea FROM qa215); v_visibles int;
BEGIN
  RAISE NOTICE E'\n── ¿Lo ve el hub? ──────────────────────────────────────';
  PERFORM pg_temp.como('qa215.ana@local.test');
  SELECT count(*) INTO v_visibles FROM task_comments WHERE task_id = v_t AND kind = 'system';
  RESET ROLE;
  PERFORM pg_temp.esperar('el hub de Perú ve los comentarios de sistema',
                          v_visibles::text, pg_temp.n_sistema(v_t)::text);

  PERFORM pg_temp.como('qa215.colombia@local.test');
  SELECT count(*) INTO v_visibles FROM task_comments WHERE task_id = v_t;
  RESET ROLE;
  PERFORM pg_temp.esperar('el de Colombia no ve ninguno', v_visibles::text, '0');
END $$;

DO $$ BEGIN RAISE NOTICE E'\n  ✓ mig 215: los cambios del admin dejan rastro, una sola vez\n'; END $$;

ROLLBACK;
