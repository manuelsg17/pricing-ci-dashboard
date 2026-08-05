-- ════════════════════════════════════════════════════════════════════════
-- seed-proyectos-local.sql — escenario de prueba del módulo Proyectos.
-- Supabase LOCAL, nunca producción.
--
--   docker exec -i supabase_db_pricing-ci-dashboard psql -U postgres -X \
--     < scripts/seed-proyectos-local.sql
--
-- Existe para que las rondas de simulación arranquen SIEMPRE del mismo estado.
-- Sin eso, "en la corrida anterior funcionaba" es imposible de comprobar: cada
-- prueba manual deja residuos y la siguiente corre sobre otra base.
--
-- Los usuarios de auth NO se crean acá — hay que crearlos por el Admin API
-- (CLAUDE.md §2: fabricar filas de auth.users a mano rompe el login con
-- errores opacos). Este script solo arma perfiles, roles y datos.
--
-- Todas las fechas son RELATIVAS a hoy en la zona del país, no absolutas: un
-- escenario con fechas fijas deja de probar "vencida" en cuanto pasa el día.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── Limpieza de corridas anteriores ───────────────────────────────────
DELETE FROM projects WHERE name LIKE 'QA %';
DELETE FROM user_profiles WHERE email LIKE 'qa.%@local.test';
DELETE FROM roles WHERE name LIKE 'qa_%';
DELETE FROM section_last_seen WHERE user_email LIKE 'qa.%@local.test';

-- ── Roles y perfiles ──────────────────────────────────────────────────
INSERT INTO roles (name, label, permissions) VALUES
  ('qa_hub_pe', 'QA Hub Perú',     '{"sections": ["projects","dataentry"], "countries": ["Peru"]}'),
  ('qa_hub_co', 'QA Hub Colombia', '{"sections": ["projects","dataentry"], "countries": ["Colombia"]}'),
  ('qa_lider',  'QA Líder',        '{"sections": ["projects","monitoring"], "countries": ["Peru"]}');

INSERT INTO user_profiles (email, role_id, is_active) VALUES
  ('qa.rai@local.test',    (SELECT id FROM roles WHERE name='qa_hub_pe'), true),
  ('qa.edu@local.test',    (SELECT id FROM roles WHERE name='qa_hub_pe'), true),
  ('qa.lider@local.test',  (SELECT id FROM roles WHERE name='qa_lider'),  true),
  ('qa.andrea@local.test', (SELECT id FROM roles WHERE name='qa_hub_co'), true),
  ('qa.exhub@local.test',  (SELECT id FROM roles WHERE name='qa_hub_pe'), false);

-- El admin real de local también necesita la sección para abrir la pantalla.
UPDATE roles SET permissions = jsonb_set(
  permissions, '{sections}',
  (SELECT jsonb_agg(DISTINCT x)
     FROM jsonb_array_elements_text(permissions->'sections' || '["projects"]'::jsonb) x))
WHERE name = 'admin'
  AND NOT (permissions->'sections' ? 'projects')
  AND NOT (permissions->'sections' ? 'all');

-- ── Escenario ─────────────────────────────────────────────────────────
CREATE TEMP TABLE hoy AS
SELECT (now() AT TIME ZONE (SELECT timezone FROM country_config WHERE country_key='Peru'))::date AS d;

INSERT INTO projects (country, cities, name, description, start_date, end_date, created_by)
SELECT 'Peru', v.ciudades, v.nombre, v.descr, d.d + v.ini, d.d + v.fin, 'admin@local.test'
FROM hoy d, (VALUES
  ('{}'::text[],                'QA Auditoría de rutas Q3', 'Revisión de brackets por ciudad', -20, 25),
  (ARRAY['Lima','Arequipa'],    'QA Onboarding TukTuk SJM', NULL,                              -10, 10),
  (ARRAY['Lima'],               'QA Limpieza de históricos', NULL,                              -5, 40)
) AS v(ciudades, nombre, descr, ini, fin);

INSERT INTO project_tasks (project_id, title, owner_email, city, start_date, due_date, status, sort_order, created_by)
SELECT p.id, v.titulo, v.owner, v.ciudad,
       CASE WHEN v.ini IS NULL THEN NULL ELSE d.d + v.ini END,
       CASE WHEN v.fin IS NULL THEN NULL ELSE d.d + v.fin END,
       v.estado, v.orden, 'admin@local.test'
FROM hoy d, (VALUES
  ('QA Auditoría de rutas Q3',  'QA Revisar brackets de Lima',      'qa.rai@local.test',   'Lima',     -8,   -2, 'doing',   0),
  ('QA Auditoría de rutas Q3',  'QA Revisar brackets de Arequipa',  'qa.edu@local.test',   'Arequipa', -5,    0, 'todo',    1),
  ('QA Auditoría de rutas Q3',  'QA Revisar brackets de Trujillo',  'qa.rai@local.test',   'Trujillo', NULL,  1, 'blocked', 2),
  ('QA Auditoría de rutas Q3',  'QA Consolidar informe',             NULL,                 NULL,      NULL,  15, 'todo',    3),
  ('QA Auditoría de rutas Q3',  'QA Definir criterio de muestreo',  'admin@local.test',    NULL,      NULL,NULL, 'todo',    4),
  ('QA Onboarding TukTuk SJM',  'QA Cargar puntos nuevos',          'qa.edu@local.test',   'Lima',     -4,    2, 'doing',   0),
  ('QA Onboarding TukTuk SJM',  'QA Validar precios con el hub',    'qa.rai@local.test',   'Lima',    NULL,  -1, 'doing',   1),
  ('QA Onboarding TukTuk SJM',  'QA Capacitación del equipo',       'admin@local.test',    'Arequipa',NULL,   8, 'todo',    2),
  ('QA Limpieza de históricos', 'QA Detectar duplicados 2025',      'admin@local.test',    'Lima',    -60,  -50, 'done',    0),
  ('QA Limpieza de históricos', 'QA Borrar filas irreales',         'qa.exhub@local.test', 'Lima',     25,   30, 'todo',    1)
) AS v(proy, titulo, owner, ciudad, ini, fin, estado, orden)
JOIN projects p ON p.name = v.proy;

-- Una tarea estancada: 20 días en curso sin tocarse.
UPDATE project_tasks SET updated_at = now() - interval '20 days'
WHERE title = 'QA Revisar brackets de Lima';
-- La trabada, 5 días trabada.
UPDATE project_tasks SET updated_at = now() - interval '5 days'
WHERE title = 'QA Revisar brackets de Trujillo';

INSERT INTO task_comments (task_id, author_email, body, kind)
SELECT id, 'qa.rai@local.test', 'El hub de Trujillo no responde desde el lunes', 'blocker'
FROM project_tasks WHERE title = 'QA Revisar brackets de Trujillo';
INSERT INTO task_comments (task_id, author_email, body, kind)
SELECT id, 'qa.edu@local.test', 'Terminé las rutas de VES, me falta SJM', 'progress'
FROM project_tasks WHERE title = 'QA Cargar puntos nuevos';

COMMIT;

SELECT (SELECT count(*) FROM projects WHERE name LIKE 'QA %')      AS proyectos,
       (SELECT count(*) FROM project_tasks WHERE title LIKE 'QA %') AS tareas,
       (SELECT count(*) FROM user_profiles WHERE email LIKE 'qa.%') AS perfiles;
