-- ════════════════════════════════════════════════════════════════════════
-- 215_tareas_cambios_visibles.sql — que un cambio del admin no sea invisible
-- para el hub.
--
-- QUÉ FALTABA (PROYECTOS_DESIGN.md §17.6 y §13.6)
-- El diseño de la Fase 1 pedía comentario de sistema al REASIGNAR una tarea y
-- al MOVER sus fechas. Solo lo primero se implementó, y encima en un lugar que
-- la app no usaba:
--
--   · La reasignación vivía dentro de `reassign_task`, pero la planilla del
--     admin (ProjectsAdmin.jsx) reasignaba con un UPDATE crudo sobre
--     `project_tasks` — la RPC estaba exportada y no la llamaba nadie. O sea
--     que en el camino REAL no se escribía ningún comentario, y de paso se
--     salteaba la validación de destino de la mig 207: se podía asignar a
--     alguien sin acceso al país y la tarea quedaba en un agujero negro.
--   · El cambio de fechas no dejaba rastro por ningún camino. Le adelantás el
--     vencimiento a un hub y se entera cuando ya está en rojo — exactamente la
--     clase de sorpresa que §13.5/§13.6 resolvieron para los otros casos.
--
-- POR QUÉ UN TRIGGER Y NO OTRA RPC
-- CLAUDE.md §4 lo dice con todas las letras: ninguna regla debe vivir en un
-- solo lugar si el dato entra por múltiples caminos. Ese error ya se pagó tres
-- veces en este repo (migs 209, 211 y el auto-tag de la 180), siempre igual —
-- la regla en el trigger y el predicado en otro lado, divergiendo en silencio.
--
-- Acá los caminos de escritura son al menos cuatro: la planilla del admin, la
-- RPC `reassign_task`, el arrastre del Gantt que viene en la Fase 2, y un
-- UPDATE directo por SQL. Una RPC nueva cubriría uno. El trigger los cubre a
-- todos, incluidos los que todavía no existen.
--
-- CONSECUENCIA: `reassign_task` PIERDE su INSERT de comentario. Si lo
-- conservara, reasignar por la RPC dejaría DOS comentarios idénticos — y peor,
-- serían dos textos que hay que mantener sincronizados a mano, que es el bug
-- que este archivo viene a evitar. La RPC se queda con lo que solo ella puede
-- hacer: validar que el destino exista, esté activo y tenga el país.
--
-- IDIOMA: el cuerpo se escribe en español, igual que los comentarios de
-- sistema que ya escribe la mig 184. Es un DATO en la bitácora, no un string
-- de UI — no pasa por i18n (misma excepción documentada en CLAUDE.md §6 para
-- los nombres que vienen de Config).
--
-- VERIFICACIÓN: al final del archivo. Simulación: scripts/simulate-cambios-tarea.sql
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION public.trg_task_log_admin_changes()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  -- Un UPDATE por SQL directo (mantenimiento, backfill) no tiene sesión de
  -- Auth: `auth.email()` devuelve NULL y el INSERT rebotaría contra el NOT
  -- NULL de author_email, tumbando el UPDATE entero. Que un cambio manual
  -- falle por no poder registrarse sería peor que registrarlo como 'sistema'.
  v_me   text   := coalesce((select auth.email()), 'sistema');
  v_msgs text[] := '{}';
BEGIN
  IF NEW.owner_email IS DISTINCT FROM OLD.owner_email THEN
    v_msgs := v_msgs || format('reasignó la tarea de %s a %s',
                               coalesce(OLD.owner_email, 'sin asignar'),
                               coalesce(NEW.owner_email, 'sin asignar'));
  END IF;

  IF NEW.due_date IS DISTINCT FROM OLD.due_date THEN
    v_msgs := v_msgs || format('movió el vencimiento del %s al %s',
                               coalesce(OLD.due_date::text, 'sin fecha'),
                               coalesce(NEW.due_date::text, 'sin fecha'));
  END IF;

  IF NEW.start_date IS DISTINCT FROM OLD.start_date THEN
    v_msgs := v_msgs || format('movió el inicio del %s al %s',
                               coalesce(OLD.start_date::text, 'sin fecha'),
                               coalesce(NEW.start_date::text, 'sin fecha'));
  END IF;

  -- El trigger está acotado por `UPDATE OF` a esas tres columnas, pero eso
  -- solo mira qué columnas MENCIONA el UPDATE, no si el valor cambió: un
  -- `SET due_date = due_date` lo dispararía igual. Sin esta salida, guardar la
  -- planilla sin tocar nada llenaría la bitácora de ruido.
  IF array_length(v_msgs, 1) IS NULL THEN
    RETURN NULL;
  END IF;

  -- Varios cambios en un mismo UPDATE = UN comentario. Tres renglones
  -- separados para "moví la fecha y la reasigné" es ruido en una vista que se
  -- lee de un vistazo en la reunión.
  INSERT INTO task_comments (task_id, author_email, body, kind)
  VALUES (NEW.id, v_me,
          format('%s %s', v_me, array_to_string(v_msgs, ' · ')),
          'system');

  RETURN NULL;   -- AFTER trigger: el valor de retorno se ignora.
END;
$$;

COMMENT ON FUNCTION public.trg_task_log_admin_changes() IS
  'Deja comentario de sistema al reasignar o mover fechas de una tarea '
  '(mig 215). Vive en un trigger y no en una RPC a propósito: los caminos de '
  'escritura son varios (planilla del admin, reassign_task, arrastre del Gantt, '
  'SQL directo) y la regla no puede vivir en uno solo — CLAUDE.md §4.';

DROP TRIGGER IF EXISTS zz_task_log_admin_changes ON public.project_tasks;
CREATE TRIGGER zz_task_log_admin_changes
  AFTER UPDATE OF owner_email, start_date, due_date ON public.project_tasks
  FOR EACH ROW EXECUTE FUNCTION public.trg_task_log_admin_changes();

-- ── reassign_task pierde el INSERT, conserva la validación ────────────
-- Se reescribe entera (no un ALTER) para que el archivo muestre la versión
-- vigente completa. Misma firma que la mig 184, así que NO crea un overload:
-- si cambiara la firma habría que DROPear la vieja o PostgREST no podría
-- elegir entre las dos (PGRST203) — CLAUDE.md §3.
CREATE OR REPLACE FUNCTION public.reassign_task(p_task_id uuid, p_new_owner text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  t    public.project_tasks;
  v_ok boolean;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Solo un admin puede reasignar tareas' USING ERRCODE = 'insufficient_privilege';
  END IF;

  t := _task_guard(p_task_id, false);

  IF p_new_owner IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM user_profiles up JOIN roles r ON r.id = up.role_id
      WHERE up.email = p_new_owner AND up.is_active = true
        AND (r.permissions->'countries' ? t.country
             OR r.permissions->'countries' ? 'all')
    ) INTO v_ok;
    IF NOT v_ok THEN
      RAISE EXCEPTION 'Ese usuario no tiene acceso a % — no podría ver la tarea', t.country;
    END IF;
  END IF;

  -- El comentario de sistema lo escribe zz_task_log_admin_changes. Repetirlo
  -- acá daría dos comentarios por reasignación y dos textos que mantener
  -- sincronizados a mano.
  UPDATE project_tasks
     SET owner_email = p_new_owner, updated_at = now()
   WHERE id = p_task_id;

  RETURN jsonb_build_object('ok', true);
END;
$$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
--   · El trigger existe y está acotado a las 3 columnas:
--       SELECT tgname, pg_get_triggerdef(oid) FROM pg_trigger
--       WHERE tgrelid = 'public.project_tasks'::regclass AND NOT tgisinternal;
--   · search_path fijado (CLAUDE.md §3):
--       SELECT proname, proconfig FROM pg_proc
--       WHERE proname IN ('trg_task_log_admin_changes','reassign_task');
--       -- ambas con {search_path=public,pg_temp}
--   · Una reasignación deja UN comentario, no dos:
--       SELECT count(*) FROM task_comments
--       WHERE task_id = '<id>' AND kind = 'system';
--   · Un UPDATE que no cambia nada no deja comentario:
--       UPDATE project_tasks SET due_date = due_date WHERE id = '<id>';
-- ════════════════════════════════════════════════════════════════════════
