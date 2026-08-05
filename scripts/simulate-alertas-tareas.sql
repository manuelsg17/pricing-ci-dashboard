-- ════════════════════════════════════════════════════════════════════════
-- simulate-alertas-tareas.sql — mig 216. Supabase LOCAL, nunca producción.
--
--   docker exec -i supabase_db_pricing-ci-dashboard psql -U postgres -X \
--     < scripts/simulate-alertas-tareas.sql
--
-- LA PREGUNTA: ¿el panel de Monitoreo avisa de todo lo que tiene que avisar, y
-- se calla de todo lo que no?
--
-- Las dos mitades importan igual. Un panel de alertas que se pierde una tarea
-- trabada es inútil; uno que grita por tareas archivadas o ya terminadas se
-- ignora a la semana, y entonces también es inútil.
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

/** kind de una tarea en el panel, o 'ausente' si no alerta. */
CREATE OR REPLACE FUNCTION pg_temp.alerta(p_titulo text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  PERFORM pg_temp.como('qa216.admin@local.test');
  SELECT coalesce(a.kind, 'sin_kind') INTO v
  FROM get_project_task_alerts('Peru') a WHERE a.title = p_titulo;
  RESET ROLE;
  RETURN coalesce(v, 'ausente');
END $$;

CREATE OR REPLACE FUNCTION pg_temp.campo(p_titulo text, p_campo text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  PERFORM pg_temp.como('qa216.admin@local.test');
  EXECUTE format(
    'SELECT %I::text FROM get_project_task_alerts(''Peru'') a WHERE a.title = $1', p_campo)
    INTO v USING p_titulo;
  RESET ROLE;
  RETURN coalesce(v, 'ausente');
END $$;

-- ── Elenco ────────────────────────────────────────────────────────────
INSERT INTO roles (name, label, permissions) VALUES
  ('qa216_hub',  'QA216 hub',  '{"sections": ["projects"], "countries": ["Peru"]}'),
  ('qa216_mon',  'QA216 mon',  '{"sections": ["projects","monitoring"], "countries": ["Peru"]}'),
  ('qa216_co',   'QA216 CO',   '{"sections": ["projects","monitoring"], "countries": ["Colombia"]}');

INSERT INTO user_profiles (email, role_id, is_active) VALUES
  ('qa216.admin@local.test', (SELECT id FROM roles WHERE name  = 'admin' LIMIT 1), true),
  ('qa216.hub@local.test',   (SELECT id FROM roles WHERE label = 'QA216 hub'),     true),
  ('qa216.mon@local.test',   (SELECT id FROM roles WHERE label = 'QA216 mon'),     true),
  ('qa216.co@local.test',    (SELECT id FROM roles WHERE label = 'QA216 CO'),      true),
  ('qa216.baja@local.test',  (SELECT id FROM roles WHERE label = 'QA216 hub'),     false);

-- El "hoy" del panel es el de Lima, así que el elenco se arma contra ESE día.
CREATE TEMP TABLE qa216 AS
SELECT (now() AT TIME ZONE (SELECT timezone FROM country_config WHERE country_key = 'Peru'))::date AS hoy;

INSERT INTO projects (country, name, status, created_by) VALUES
  ('Peru', 'QA216 activo',    'active',   'qa216.admin@local.test'),
  ('Peru', 'QA216 archivado', 'archived', 'qa216.admin@local.test');

INSERT INTO project_tasks (project_id, title, owner_email, due_date, status, created_by)
SELECT p.id, v.titulo, v.owner, v.due, v.estado, 'qa216.admin@local.test'
FROM (VALUES
  ('QA216 activo',    'QA216 trabada',        'qa216.hub@local.test',  (SELECT hoy + 5 FROM qa216), 'blocked'),
  ('QA216 activo',    'QA216 vencida',        'qa216.hub@local.test',  (SELECT hoy - 4 FROM qa216), 'doing'),
  ('QA216 activo',    'QA216 en riesgo',      'qa216.hub@local.test',  (SELECT hoy + 2 FROM qa216), 'todo'),
  ('QA216 activo',    'QA216 justo afuera',   'qa216.hub@local.test',  (SELECT hoy + 3 FROM qa216), 'todo'),
  ('QA216 activo',    'QA216 tranquila',      'qa216.hub@local.test',  (SELECT hoy + 40 FROM qa216),'todo'),
  ('QA216 activo',    'QA216 muda',           'qa216.hub@local.test',  NULL,                        'doing'),
  ('QA216 activo',    'QA216 terminada',      'qa216.hub@local.test',  (SELECT hoy - 9 FROM qa216), 'done'),
  ('QA216 activo',    'QA216 dueño de baja',  'qa216.baja@local.test', (SELECT hoy + 40 FROM qa216),'todo'),
  ('QA216 activo',    'QA216 dueño fantasma', 'qa216.nadie@local.test',(SELECT hoy + 40 FROM qa216),'todo'),
  ('QA216 archivado', 'QA216 en proy viejo',  'qa216.hub@local.test',  (SELECT hoy - 9 FROM qa216), 'blocked')
) AS v(proy, titulo, owner, due, estado)
JOIN projects p ON p.name = v.proy;

-- La muda lleva 9 días en curso sin decir nada.
UPDATE project_tasks SET updated_at = now() - interval '9 days' WHERE title = 'QA216 muda';
-- La trabada, 5 días trabada.
UPDATE project_tasks SET updated_at = now() - interval '5 days' WHERE title = 'QA216 trabada';

INSERT INTO task_comments (task_id, author_email, body, kind)
SELECT id, 'qa216.hub@local.test', 'Espero respuesta del hub de Trujillo', 'blocker'
FROM project_tasks WHERE title = 'QA216 trabada';

-- ── 1. Los gates ──────────────────────────────────────────────────────
DO $$
DECLARE v text;
BEGIN
  RAISE NOTICE E'\n── Quién puede pedir el panel ──────────────────────────';

  BEGIN
    PERFORM pg_temp.como('qa216.hub@local.test');
    PERFORM * FROM get_project_task_alerts('Peru');
    RESET ROLE; v := 'pasó';
  EXCEPTION WHEN insufficient_privilege THEN RESET ROLE; v := 'denegado';
  END;
  PERFORM pg_temp.esperar('un hub sin la sección Monitoreo no entra', v, 'denegado');

  BEGIN
    PERFORM pg_temp.como('qa216.mon@local.test');
    PERFORM * FROM get_project_task_alerts('Peru');
    RESET ROLE; v := 'pasó';
  EXCEPTION WHEN insufficient_privilege THEN RESET ROLE; v := 'denegado';
  END;
  -- El gate es por SECCIÓN, no por is_admin(): un rol no-admin con Monitoreo
  -- tiene que poder verlo. Atarlo a is_admin() escondería el aislamiento por
  -- país dentro del chequeo de rol (mig 193).
  PERFORM pg_temp.esperar('un rol NO admin con la sección sí entra', v, 'pasó');

  BEGIN
    PERFORM pg_temp.como('qa216.co@local.test');
    PERFORM * FROM get_project_task_alerts('Peru');
    RESET ROLE; v := 'pasó';
  EXCEPTION WHEN insufficient_privilege THEN RESET ROLE; v := 'denegado';
  END;
  PERFORM pg_temp.esperar('con Monitoreo pero de otro país, no', v, 'denegado');
END $$;

-- ── 2. De qué avisa ───────────────────────────────────────────────────
DO $$
BEGIN
  RAISE NOTICE E'\n── Lo que tiene que aparecer ───────────────────────────';
  PERFORM pg_temp.esperar('trabada',        pg_temp.alerta('QA216 trabada'),   'blocked');
  PERFORM pg_temp.esperar('vencida',        pg_temp.alerta('QA216 vencida'),   'overdue');
  PERFORM pg_temp.esperar('en riesgo (2 días, el umbral)', pg_temp.alerta('QA216 en riesgo'), 'at_risk');
  PERFORM pg_temp.esperar('en curso y muda hace 9 días',   pg_temp.alerta('QA216 muda'),      'silent');

  RAISE NOTICE E'\n── Los días que muestra ────────────────────────────────';
  -- Antes de convertir los timestamps a la zona del país esto daba -1: se
  -- comparaba un `updated_at` en UTC contra un "hoy" de Lima.
  PERFORM pg_temp.esperar('trabada hace 5 días',      pg_temp.campo('QA216 trabada', 'dias'), '5');
  PERFORM pg_temp.esperar('vencida hace 4',           pg_temp.campo('QA216 vencida', 'dias'), '4');
  PERFORM pg_temp.esperar('en riesgo: faltan 2',      pg_temp.campo('QA216 en riesgo','dias'), '2');
  PERFORM pg_temp.esperar('muda hace 9',              pg_temp.campo('QA216 muda',    'dias'), '9');
  PERFORM pg_temp.esperar('y la trabada trae el motivo',
    pg_temp.campo('QA216 trabada', 'motivo'), 'Espero respuesta del hub de Trujillo');
END $$;

-- ── 3. De qué NO avisa ────────────────────────────────────────────────
DO $$
BEGIN
  RAISE NOTICE E'\n── Lo que tiene que callarse ───────────────────────────';
  PERFORM pg_temp.esperar('una tarea a 40 días', pg_temp.alerta('QA216 tranquila'), 'ausente');
  -- Un día más allá del umbral: es el borde exacto de la ventana.
  PERFORM pg_temp.esperar('a 3 días con umbral 2', pg_temp.alerta('QA216 justo afuera'), 'ausente');
  PERFORM pg_temp.esperar('una tarea terminada, aunque venciera hace 9 días',
                          pg_temp.alerta('QA216 terminada'), 'ausente');
  -- §17.3: si un proyecto archivado siguiera alertando, archivar no serviría
  -- de nada y el panel se llenaría de ruido histórico.
  PERFORM pg_temp.esperar('una trabada de un proyecto archivado',
                          pg_temp.alerta('QA216 en proy viejo'), 'ausente');
END $$;

-- ── 4. Dueños que ya no están (§13.7) ─────────────────────────────────
DO $$
BEGIN
  RAISE NOTICE E'\n── Tareas huérfanas ────────────────────────────────────';
  -- Las dos vencen en 40 días: sin la regla de dueño inactivo no aparecerían.
  PERFORM pg_temp.esperar('dueño dado de baja aparece',
                          pg_temp.campo('QA216 dueño de baja', 'owner_inactive'), 'true');
  PERFORM pg_temp.esperar('y sin kind, porque la tarea en sí está bien',
                          pg_temp.alerta('QA216 dueño de baja'), 'sin_kind');
  -- Un email que no está en user_profiles es igual de huérfano que uno de baja.
  PERFORM pg_temp.esperar('dueño que no existe en el padrón',
                          pg_temp.campo('QA216 dueño fantasma', 'owner_inactive'), 'true');
  PERFORM pg_temp.esperar('un dueño activo no se marca',
                          pg_temp.campo('QA216 vencida', 'owner_inactive'), 'false');
END $$;

-- ── 5. Un comentario de sistema no calla la alerta ────────────────────
DO $$
BEGIN
  RAISE NOTICE E'\n── El silencio se mide con lo que dice el HUB ──────────';
  -- Si el admin moviéndole la fecha (que deja comentario de sistema, mig 215)
  -- sacara la tarea de "sin novedades", el panel dejaría de avisar justo
  -- cuando el hub sigue mudo.
  INSERT INTO task_comments (task_id, author_email, body, kind)
  SELECT id, 'qa216.admin@local.test', 'admin movió el vencimiento', 'system'
  FROM project_tasks WHERE title = 'QA216 muda';

  PERFORM pg_temp.esperar('sigue muda después de un comentario de sistema',
                          pg_temp.alerta('QA216 muda'), 'silent');

  -- Y un comentario REAL del hub sí la calla.
  INSERT INTO task_comments (task_id, author_email, body, kind)
  SELECT id, 'qa216.hub@local.test', 'Avancé con esto', 'progress'
  FROM project_tasks WHERE title = 'QA216 muda';

  PERFORM pg_temp.esperar('un avance del hub sí la saca', pg_temp.alerta('QA216 muda'), 'ausente');
END $$;

-- ── 6. El umbral es de verdad configurable ────────────────────────────
DO $$
BEGIN
  RAISE NOTICE E'\n── projects_risk_days ──────────────────────────────────';
  UPDATE country_config SET projects_risk_days = 5 WHERE country_key = 'Peru';
  PERFORM pg_temp.esperar('con umbral 5, la de 3 días entra',
                          pg_temp.alerta('QA216 justo afuera'), 'at_risk');

  UPDATE country_config SET projects_risk_days = 1 WHERE country_key = 'Peru';
  PERFORM pg_temp.esperar('con umbral 1, la de 2 días sale',
                          pg_temp.alerta('QA216 en riesgo'), 'ausente');

  UPDATE country_config SET projects_risk_days = 2 WHERE country_key = 'Peru';
END $$;

DO $$
DECLARE v text;
BEGIN
  -- El rango se valida en la BASE, no solo en el formulario (CLAUDE.md §3).
  BEGIN
    UPDATE country_config SET projects_risk_days = 0 WHERE country_key = 'Peru';
    v := 'aceptado';
  EXCEPTION WHEN check_violation THEN v := 'rechazado';
  END;
  PERFORM pg_temp.esperar('un umbral de 0 lo rechaza la base', v, 'rechazado');

  BEGIN
    UPDATE country_config SET projects_risk_days = 400 WHERE country_key = 'Peru';
    v := 'aceptado';
  EXCEPTION WHEN check_violation THEN v := 'rechazado';
  END;
  PERFORM pg_temp.esperar('y uno de 400 también', v, 'rechazado');
END $$;

DO $$ BEGIN RAISE NOTICE E'\n  ✓ mig 216: el panel avisa de lo que debe y se calla del resto\n'; END $$;

ROLLBACK;
