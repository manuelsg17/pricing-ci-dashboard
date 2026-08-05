-- ════════════════════════════════════════════════════════════════════════
-- simulate-doble-clic.sql — mig 217. Supabase LOCAL, nunca producción.
--
--   docker exec -i supabase_db_pricing-ci-dashboard psql -U postgres -X \
--     < scripts/simulate-doble-clic.sql
--
-- LA PREGUNTA: cuando el hub hace doble clic porque la respuesta tarda, ¿la
-- bitácora queda limpia?
--
-- Este archivo cubre la mitad SECUENCIAL (dos llamadas una detrás de otra, que
-- es lo que produce el cliente cuando el ref no alcanza a frenar la segunda).
-- La mitad CONCURRENTE —dos sesiones de verdad peleando por la misma fila— no
-- se puede escribir en un solo script de psql: va en
-- scripts/simulate-doble-clic-concurrente.sh, y es la que prueba el `FOR
-- UPDATE`.
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

CREATE OR REPLACE FUNCTION pg_temp.n_comentarios(p_task uuid, p_kind text DEFAULT NULL)
RETURNS int LANGUAGE sql AS $$
  SELECT count(*)::int FROM task_comments c
  WHERE c.task_id = p_task AND (p_kind IS NULL OR c.kind = p_kind);
$$;

CREATE OR REPLACE FUNCTION pg_temp.n_log(p_task uuid)
RETURNS int LANGUAGE sql AS $$
  SELECT count(*)::int FROM task_status_log s WHERE s.task_id = p_task;
$$;

-- ── Elenco ────────────────────────────────────────────────────────────
INSERT INTO roles (name, label, permissions) VALUES
  ('qa217_hub', 'QA217 hub', '{"sections": ["projects"], "countries": ["Peru"]}');

INSERT INTO user_profiles (email, role_id, is_active) VALUES
  ('qa217.admin@local.test', (SELECT id FROM roles WHERE name  = 'admin' LIMIT 1), true),
  ('qa217.hub@local.test',   (SELECT id FROM roles WHERE label = 'QA217 hub'),     true);

CREATE TEMP TABLE qa217 (tarea uuid);

INSERT INTO projects (country, name, created_by)
VALUES ('Peru', 'QA217 proyecto', 'qa217.admin@local.test');

INSERT INTO project_tasks (project_id, title, owner_email, created_by)
SELECT id, 'QA217 tarea', 'qa217.hub@local.test', 'qa217.admin@local.test'
FROM projects WHERE name = 'QA217 proyecto';

INSERT INTO qa217 SELECT id FROM project_tasks WHERE title = 'QA217 tarea';

-- ── 1. El doble clic con comentario ───────────────────────────────────
DO $$
DECLARE v_t uuid := (SELECT tarea FROM qa217);
BEGIN
  RAISE NOTICE E'\n── Doble clic en "En curso" con un comentario escrito ──';

  PERFORM pg_temp.como('qa217.hub@local.test');
  PERFORM set_task_status(v_t, 'doing', 'Avancé la mitad');
  -- El segundo clic: mismo estado destino, mismo texto. Antes de la 217 esto
  -- dejaba 2 comentarios y 2 filas de log para la misma transición.
  PERFORM set_task_status(v_t, 'doing', 'Avancé la mitad');
  RESET ROLE;

  PERFORM pg_temp.esperar('el estado quedó en doing',
    (SELECT status FROM project_tasks WHERE id = v_t), 'doing');
  PERFORM pg_temp.esperar('UNA sola transición en el log', pg_temp.n_log(v_t)::text, '1');
  PERFORM pg_temp.esperar('UN solo comentario del hub',
                          pg_temp.n_comentarios(v_t, 'progress')::text, '1');
END $$;

-- ── 2. Un comentario repetido MÁS TARDE sí entra ──────────────────────
DO $$
DECLARE v_t uuid := (SELECT tarea FROM qa217);
BEGIN
  RAISE NOTICE E'\n── La ventana es corta a propósito ─────────────────────';
  -- Se envejece el comentario anterior para simular que pasaron minutos.
  UPDATE task_comments SET created_at = now() - interval '5 minutes'
  WHERE task_id = v_t AND kind = 'progress';

  PERFORM pg_temp.como('qa217.hub@local.test');
  PERFORM add_task_comment(v_t, 'Avancé la mitad');
  RESET ROLE;

  -- Escribir lo mismo cinco minutos después es un reporte legítimo, no un
  -- accidente: la guarda NO puede comérselo.
  PERFORM pg_temp.esperar('el mismo texto 5 minutos después SÍ entra',
                          pg_temp.n_comentarios(v_t, 'progress')::text, '2');
END $$;

-- ── 3. Doble Enter en el campo de comentario ──────────────────────────
DO $$
DECLARE v_t uuid := (SELECT tarea FROM qa217); v_antes int;
BEGIN
  RAISE NOTICE E'\n── Doble Enter ─────────────────────────────────────────';
  v_antes := pg_temp.n_comentarios(v_t, 'progress');

  PERFORM pg_temp.como('qa217.hub@local.test');
  PERFORM add_task_comment(v_t, 'Ya terminé SJM');
  PERFORM add_task_comment(v_t, 'Ya terminé SJM');
  RESET ROLE;

  PERFORM pg_temp.esperar('deja un solo comentario',
                          pg_temp.n_comentarios(v_t, 'progress')::text, (v_antes + 1)::text);
END $$;

-- ── 4. Dos personas distintas con el mismo texto NO se pisan ──────────
DO $$
DECLARE v_t uuid := (SELECT tarea FROM qa217); v_antes int;
BEGIN
  RAISE NOTICE E'\n── La guarda es por AUTOR, no global ───────────────────';
  v_antes := pg_temp.n_comentarios(v_t, 'progress');

  PERFORM pg_temp.como('qa217.hub@local.test');
  PERFORM add_task_comment(v_t, 'ok');
  RESET ROLE;
  PERFORM pg_temp.como('qa217.admin@local.test');
  PERFORM add_task_comment(v_t, 'ok');
  RESET ROLE;

  -- Que dos personas escriban "ok" a la vez es normal. Si la guarda fuera
  -- global, el segundo perdería su comentario sin enterarse.
  PERFORM pg_temp.esperar('los dos "ok" entran',
                          pg_temp.n_comentarios(v_t, 'progress')::text, (v_antes + 2)::text);
END $$;

-- ── 5. El comentario de sistema tampoco se duplica ────────────────────
DO $$
DECLARE v_t uuid := (SELECT tarea FROM qa217);
BEGIN
  RAISE NOTICE E'\n── Admin tocando una tarea ajena, dos veces ────────────';
  PERFORM pg_temp.como('qa217.admin@local.test');
  PERFORM set_task_status(v_t, 'done', NULL);
  PERFORM set_task_status(v_t, 'done', NULL);
  RESET ROLE;

  PERFORM pg_temp.esperar('un solo aviso al dueño',
                          pg_temp.n_comentarios(v_t, 'system')::text, '1');
  PERFORM pg_temp.esperar('y una sola transición nueva', pg_temp.n_log(v_t)::text, '2');
END $$;

-- ── 6. Lo que NO se puede romper: trabar sigue exigiendo motivo ───────
DO $$
DECLARE v_t uuid := (SELECT tarea FROM qa217); v text;
BEGIN
  RAISE NOTICE E'\n── Las reglas viejas siguen en pie ─────────────────────';
  PERFORM pg_temp.como('qa217.hub@local.test');
  BEGIN
    PERFORM set_task_status(v_t, 'blocked', '   ');
    v := 'aceptado';
  EXCEPTION WHEN OTHERS THEN v := 'rechazado';
  END;
  RESET ROLE;
  PERFORM pg_temp.esperar('trabar sin motivo se rechaza', v, 'rechazado');

  PERFORM pg_temp.como('qa217.admin@local.test');
  BEGIN
    PERFORM set_task_status(v_t, 'inventado', NULL);
    v := 'aceptado';
  EXCEPTION WHEN OTHERS THEN v := 'rechazado';
  END;
  RESET ROLE;
  PERFORM pg_temp.esperar('un estado inválido se rechaza', v, 'rechazado');
END $$;

-- ── 7. Y el aislamiento por país / dueño ──────────────────────────────
INSERT INTO roles (name, label, permissions) VALUES
  ('qa217_co', 'QA217 CO', '{"sections": ["projects"], "countries": ["Colombia"]}');
INSERT INTO user_profiles (email, role_id, is_active) VALUES
  ('qa217.co@local.test', (SELECT id FROM roles WHERE label = 'QA217 CO'), true);

DO $$
DECLARE v_t uuid := (SELECT tarea FROM qa217); v text;
BEGIN
  PERFORM pg_temp.como('qa217.co@local.test');
  BEGIN
    PERFORM set_task_status(v_t, 'todo', NULL);
    v := 'pasó';
  EXCEPTION WHEN insufficient_privilege THEN v := 'denegado';
  END;
  RESET ROLE;
  PERFORM pg_temp.esperar('un hub de otro país no puede tocarla', v, 'denegado');
END $$;

DO $$ BEGIN RAISE NOTICE E'\n  ✓ mig 217: el doble clic ya no ensucia la bitácora\n'; END $$;

ROLLBACK;
