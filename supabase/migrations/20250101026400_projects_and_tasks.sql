-- ════════════════════════════════════════════════════════════════════════
-- 183_projects_and_tasks.sql — Fase 1 del sistema de proyectos y tareas.
--
-- Diseño completo y las 4 rondas de simulación que lo produjeron:
-- PROYECTOS_DESIGN.md. Este archivo implementa lo acordado ahí.
--
-- MODELO
--   projects        — proyecto de UN país, con alcance de N ciudades
--   project_tasks   — tarea con dueño, fechas y estado
--   task_comments   — bitácora de avance (no se edita ni se borra)
--   task_status_log — historial de cambios de estado
--   section_last_seen — para "qué hay nuevo desde tu última visita"
--
-- DECISIONES QUE SE VEN EN EL DDL
--   · `cities text[]` en vez de `city text`: con una sola ciudad nullable,
--     filtrar por "Arequipa" hacía DESAPARECER los proyectos multi-ciudad
--     (§13.1). `{}` = todas las ciudades del país.
--   · `country` DESNORMALIZADO en tasks/comments/log: sin eso, cada política
--     RLS necesitaría un EXISTS contra projects por fila. Lo mantiene un
--     trigger, no la app — así no hay forma de insertarlo mal.
--   · "En riesgo" y "estancada" NO son columnas: son cálculos. Una columna
--     habría que mantenerla a mano y quedaría vieja (§5).
--   · Los comentarios no se editan ni se borran: son bitácora, mismo criterio
--     que audit_log (§15.10). Por eso no hay política de UPDATE/DELETE.
--
-- SEGURIDAD (§17.2) — el punto más delicado del archivo
--   Una política RLS NO puede restringir por columna. Si se permitiera UPDATE
--   al dueño vía política, un hub podría cambiar título, fechas u owner con
--   una llamada directa a la API: la UI muestra solo el botón de estado, pero
--   la API no es la UI.
--   Por eso:
--     · SELECT  → can_access_country(country). Los hubs de un país ven TODAS
--       las tareas de su país (decisión del user) y ninguna de otro.
--     · INSERT/UPDATE/DELETE → solo admin.
--     · El hub escribe ÚNICAMENTE por las RPCs de abajo, que son SECURITY
--       DEFINER y validan país Y dueño antes de tocar nada.
--
-- VERIFICACIÓN: al final del archivo.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── country_config.timezone (§13.4) ───────────────────────────────────
-- Sin esto, "vence hoy" se calcula con la hora del servidor (UTC): a las
-- 19:00 de Lima el sistema ya cree que es mañana y marca tareas vencidas un
-- día antes. Con umbral de 2 días, equivocarse por uno es media ventana.
ALTER TABLE public.country_config
  ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'UTC';

UPDATE public.country_config SET timezone = 'America/Lima'      WHERE country_key = 'Peru'     AND timezone = 'UTC';
UPDATE public.country_config SET timezone = 'America/Bogota'    WHERE country_key = 'Colombia' AND timezone = 'UTC';
UPDATE public.country_config SET timezone = 'America/La_Paz'    WHERE country_key = 'Bolivia'  AND timezone = 'UTC';
UPDATE public.country_config SET timezone = 'Asia/Kathmandu'    WHERE country_key = 'Nepal'    AND timezone = 'UTC';

COMMENT ON COLUMN public.country_config.timezone IS
  'Zona horaria IANA del país. Se usa para calcular "hoy" en Proyectos — sin '
  'esto el corte del día sale del servidor (UTC) y desfasa los vencimientos.';

-- ── projects ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  country     text NOT NULL,
  cities      text[] NOT NULL DEFAULT '{}',   -- {} = todas las del país
  name        text NOT NULL,
  description text,
  start_date  date,
  end_date    date,
  status      text NOT NULL DEFAULT 'active',
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT projects_status_chk CHECK (status IN ('active', 'done', 'archived')),
  CONSTRAINT projects_dates_chk  CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date),
  CONSTRAINT projects_name_chk   CHECK (btrim(name) <> '')
);

CREATE INDEX IF NOT EXISTS idx_projects_country_status ON public.projects(country, status);

COMMENT ON TABLE public.projects IS
  'Proyectos de seguimiento de hubs (mig 183). Un proyecto pertenece a UN país; '
  '`cities` acota a qué ciudades aplica ({} = todas las del país).';

-- ── project_tasks ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.project_tasks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  country     text NOT NULL,                  -- desnormalizado, lo pone el trigger
  city        text,                           -- de qué ciudad es ESTA tarea
  title       text NOT NULL,
  description text,
  owner_email text,                           -- NULL = sin asignar
  start_date  date,
  due_date    date,
  status      text NOT NULL DEFAULT 'todo',
  sort_order  int  NOT NULL DEFAULT 0,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tasks_status_chk CHECK (status IN ('todo', 'doing', 'blocked', 'done')),
  CONSTRAINT tasks_dates_chk  CHECK (due_date IS NULL OR start_date IS NULL OR due_date >= start_date),
  CONSTRAINT tasks_title_chk  CHECK (btrim(title) <> '')
);

CREATE INDEX IF NOT EXISTS idx_tasks_project     ON public.project_tasks(project_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_tasks_owner_due   ON public.project_tasks(owner_email, due_date)
  WHERE status <> 'done';
CREATE INDEX IF NOT EXISTS idx_tasks_country_due ON public.project_tasks(country, due_date);

-- ── task_comments ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.task_comments (
  id           bigserial PRIMARY KEY,
  task_id      uuid NOT NULL REFERENCES public.project_tasks(id) ON DELETE CASCADE,
  country      text NOT NULL,                 -- desnormalizado, trigger
  author_email text NOT NULL,
  body         text NOT NULL,
  kind         text NOT NULL DEFAULT 'progress',
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT comments_kind_chk CHECK (kind IN ('progress', 'blocker', 'system')),
  CONSTRAINT comments_body_chk CHECK (btrim(body) <> '')
);

CREATE INDEX IF NOT EXISTS idx_comments_task    ON public.task_comments(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comments_recent  ON public.task_comments(country, created_at DESC);

COMMENT ON TABLE public.task_comments IS
  'Bitácora de avance. NO se edita ni se borra a propósito (mig 183): una '
  'bitácora editable no sirve como registro de qué se dijo cuándo. Para '
  'corregir, se agrega otro comentario.';

-- ── task_status_log ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.task_status_log (
  id          bigserial PRIMARY KEY,
  task_id     uuid NOT NULL REFERENCES public.project_tasks(id) ON DELETE CASCADE,
  country     text NOT NULL,
  from_status text,
  to_status   text NOT NULL,
  changed_by  text NOT NULL,
  changed_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_status_log_recent ON public.task_status_log(country, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_status_log_task   ON public.task_status_log(task_id, changed_at DESC);

-- ── section_last_seen (§15.4) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.section_last_seen (
  user_email text NOT NULL,
  section    text NOT NULL,
  seen_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_email, section)
);

-- ── Trigger: hereda country (y valida city) desde el proyecto ─────────
-- La app NUNCA manda `country` en tasks/comments/log — lo pone esto. Así no
-- existe el camino de insertarlo mal, que es como se cuelan las fugas.
CREATE OR REPLACE FUNCTION public.trg_task_inherit_country()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  SELECT p.country INTO NEW.country FROM projects p WHERE p.id = NEW.project_id;
  IF NEW.country IS NULL THEN
    RAISE EXCEPTION 'project_tasks: el proyecto % no existe', NEW.project_id;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS zz_task_inherit_country ON public.project_tasks;
CREATE TRIGGER zz_task_inherit_country
  BEFORE INSERT OR UPDATE OF project_id ON public.project_tasks
  FOR EACH ROW EXECUTE FUNCTION public.trg_task_inherit_country();

CREATE OR REPLACE FUNCTION public.trg_child_inherit_country()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  SELECT t.country INTO NEW.country FROM project_tasks t WHERE t.id = NEW.task_id;
  IF NEW.country IS NULL THEN
    RAISE EXCEPTION 'la tarea % no existe', NEW.task_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS zz_comment_inherit_country ON public.task_comments;
CREATE TRIGGER zz_comment_inherit_country
  BEFORE INSERT ON public.task_comments
  FOR EACH ROW EXECUTE FUNCTION public.trg_child_inherit_country();

DROP TRIGGER IF EXISTS zz_statuslog_inherit_country ON public.task_status_log;
CREATE TRIGGER zz_statuslog_inherit_country
  BEFORE INSERT ON public.task_status_log
  FOR EACH ROW EXECUTE FUNCTION public.trg_child_inherit_country();

-- ── RLS ───────────────────────────────────────────────────────────────
-- Las tablas se crean y se protegen en la MISMA migración: nunca existen sin
-- política, ni por un instante.
--
-- Patrón, igual para las 4 tablas de contenido:
--   SELECT               → can_access_country(country)
--   INSERT/UPDATE/DELETE → is_admin() AND can_access_country(country)
-- El hub NO tiene escritura directa por diseño (§17.2): escribe solo por las
-- RPCs de la mig 184, que validan país y dueño.

ALTER TABLE public.projects          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_tasks     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_comments     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_status_log   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.section_last_seen ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['projects', 'project_tasks', 'task_comments', 'task_status_log']
  LOOP
    -- DROP explícito antes de CREATE: dos políticas permisivas para el mismo
    -- comando se combinan con OR y la vieja y laxa gana en silencio. Así se
    -- colaron las fugas de las migs 60-66, 130 y 164-165 (CLAUDE.md §3).
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (can_access_country(country))',
      t || '_select', t);

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_insert', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (is_admin() AND can_access_country(country))',
      t || '_insert', t);

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_update', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (is_admin() AND can_access_country(country)) WITH CHECK (is_admin() AND can_access_country(country))',
      t || '_update', t);

    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_delete', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (is_admin() AND can_access_country(country))',
      t || '_delete', t);
  END LOOP;
END $$;

-- task_comments y task_status_log son bitácora: ni admin las edita.
DROP POLICY IF EXISTS task_comments_update   ON public.task_comments;
DROP POLICY IF EXISTS task_status_log_update ON public.task_status_log;
DROP POLICY IF EXISTS task_status_log_delete ON public.task_status_log;

-- section_last_seen: cada uno la suya, sin gate de país (no tiene contenido).
DROP POLICY IF EXISTS section_last_seen_own ON public.section_last_seen;
CREATE POLICY section_last_seen_own ON public.section_last_seen
  FOR ALL TO authenticated
  USING      (user_email = (select auth.email()))
  WITH CHECK (user_email = (select auth.email()));

-- Los objetos nuevos heredan permisos amplios en este proyecto (CLAUDE.md §3):
-- se revoca a anon explícitamente, `FROM public` no alcanza.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['projects', 'project_tasks', 'task_comments',
                           'task_status_log', 'section_last_seen']
  LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
  END LOOP;
  REVOKE ALL ON SEQUENCE public.task_comments_id_seq   FROM anon;
  REVOKE ALL ON SEQUENCE public.task_status_log_id_seq FROM anon;
  GRANT USAGE ON SEQUENCE public.task_comments_id_seq   TO authenticated;
  GRANT USAGE ON SEQUENCE public.task_status_log_id_seq TO authenticated;
END $$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
--   · Que anon no llegue:
--       SELECT relname, has_table_privilege('anon', oid, 'SELECT')
--       FROM pg_class WHERE relname IN
--         ('projects','project_tasks','task_comments','task_status_log');
--       -- todas false
--   · Una política por comando por tabla (sin drift):
--       SELECT tablename, cmd, count(*) FROM pg_policies
--       WHERE tablename IN ('projects','project_tasks','task_comments',
--                           'task_status_log','section_last_seen')
--       GROUP BY 1,2 HAVING count(*) > 1;   -- 0 filas
--   · country se hereda solo: INSERT de una tarea sin country → queda con el
--     del proyecto.
-- ════════════════════════════════════════════════════════════════════════
