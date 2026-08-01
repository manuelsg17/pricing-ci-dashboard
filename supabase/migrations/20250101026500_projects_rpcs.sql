-- ════════════════════════════════════════════════════════════════════════
-- 184_projects_rpcs.sql — la única vía de escritura del hub sobre tareas.
--
-- CONTEXTO (PROYECTOS_DESIGN.md §17.2)
-- Una política RLS NO puede restringir por columna. Si se le diera UPDATE al
-- dueño vía política, un hub podría cambiar título, fechas u owner con una
-- llamada directa a la API — la UI le muestra solo el botón de estado, pero
-- la API no es la UI.
--
-- Por eso la mig 183 dejó el UPDATE cerrado para no-admins, y el hub escribe
-- exclusivamente por estas funciones, que son SECURITY DEFINER (bypasean RLS)
-- y por lo tanto tienen que validar TODO ellas mismas:
--
--   1. can_access_country(país de la tarea)  → aislamiento entre países.
--   2. dueño de la tarea, o admin            → que sea suya.
--
-- La #1 no es redundante: si alguna vez una tarea quedara mal asignada a
-- alguien de otro país, sin ese chequeo esa persona podría escribirla. Es la
-- defensa en profundidad que pide CLAUDE.md §3 después de tres rondas de
-- fugas RLS reales.
--
-- Todas fijan search_path (CLAUDE.md §3) y se revocan de anon explícitamente
-- — `FROM public` no alcanza en este proyecto.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── Helper interno: valida acceso y devuelve la tarea ─────────────────
CREATE OR REPLACE FUNCTION public._task_guard(p_task_id uuid, p_require_owner boolean)
RETURNS public.project_tasks
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  t     public.project_tasks;
  v_me  text := (select auth.email());
BEGIN
  SELECT * INTO t FROM project_tasks WHERE id = p_task_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La tarea no existe' USING ERRCODE = 'no_data_found';
  END IF;

  IF NOT can_access_country(t.country) THEN
    RAISE EXCEPTION 'Sin acceso al país de esta tarea' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_require_owner AND NOT is_admin()
     AND (t.owner_email IS DISTINCT FROM v_me) THEN
    RAISE EXCEPTION 'Esta tarea no está asignada a vos' USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN t;
END;
$$;

-- ── set_task_status ───────────────────────────────────────────────────
-- Cambia el estado y registra el cambio. Si quien cambia NO es el dueño
-- (típicamente el admin reabriendo algo), deja comentario de sistema para que
-- el hub se entere sin que nadie tenga que avisarle (§13.5).
CREATE OR REPLACE FUNCTION public.set_task_status(
  p_task_id uuid,
  p_status  text,
  p_comment text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  t    public.project_tasks;
  v_me text := (select auth.email());
BEGIN
  IF p_status NOT IN ('todo', 'doing', 'blocked', 'done') THEN
    RAISE EXCEPTION 'Estado inválido: %', p_status;
  END IF;

  t := _task_guard(p_task_id, true);

  -- "Trabada" sin motivo no le sirve a nadie: es el único caso donde se
  -- exige texto (§3.2).
  IF p_status = 'blocked' AND coalesce(btrim(p_comment), '') = '' THEN
    RAISE EXCEPTION 'Para marcar una tarea como trabada hay que indicar el motivo';
  END IF;

  IF t.status IS DISTINCT FROM p_status THEN
    UPDATE project_tasks
       SET status = p_status, updated_at = now()
     WHERE id = p_task_id;

    INSERT INTO task_status_log (task_id, from_status, to_status, changed_by)
    VALUES (p_task_id, t.status, p_status, v_me);
  END IF;

  IF coalesce(btrim(p_comment), '') <> '' THEN
    INSERT INTO task_comments (task_id, author_email, body, kind)
    VALUES (p_task_id, v_me, btrim(p_comment),
            CASE WHEN p_status = 'blocked' THEN 'blocker' ELSE 'progress' END);
  END IF;

  -- Alguien tocó una tarea ajena → que quede registrado y visible.
  IF t.owner_email IS NOT NULL AND t.owner_email IS DISTINCT FROM v_me THEN
    INSERT INTO task_comments (task_id, author_email, body, kind)
    VALUES (p_task_id, v_me,
            format('%s cambió el estado de «%s» a «%s»', v_me, t.status, p_status),
            'system');
  END IF;

  RETURN jsonb_build_object('ok', true, 'from', t.status, 'to', p_status);
END;
$$;

-- ── add_task_comment ──────────────────────────────────────────────────
-- El caso más común del día a día: reportar avance SIN cambiar el estado
-- (§17.1). La vista "Hoy" lee de acá además del log de estados.
CREATE OR REPLACE FUNCTION public.add_task_comment(p_task_id uuid, p_body text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE v_me text := (select auth.email());
BEGIN
  IF coalesce(btrim(p_body), '') = '' THEN
    RAISE EXCEPTION 'El comentario no puede estar vacío';
  END IF;

  PERFORM _task_guard(p_task_id, true);

  INSERT INTO task_comments (task_id, author_email, body, kind)
  VALUES (p_task_id, v_me, btrim(p_body), 'progress');

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ── reassign_task ─────────────────────────────────────────────────────
-- Solo admin. Valida que el NUEVO dueño tenga acceso al país de la tarea:
-- sin esto se crea un agujero negro — la tarea figura asignada y esa persona
-- nunca la ve porque RLS se la oculta (§15.2).
CREATE OR REPLACE FUNCTION public.reassign_task(p_task_id uuid, p_new_owner text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  t    public.project_tasks;
  v_me text := (select auth.email());
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

  UPDATE project_tasks
     SET owner_email = p_new_owner, updated_at = now()
   WHERE id = p_task_id;

  INSERT INTO task_comments (task_id, author_email, body, kind)
  VALUES (p_task_id, v_me,
          format('Reasignada de %s a %s',
                 coalesce(t.owner_email, 'sin asignar'),
                 coalesce(p_new_owner,   'sin asignar')),
          'system');

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ── assignable_users ──────────────────────────────────────────────────
-- Alimenta el selector de owner: SOLO usuarios activos con acceso al país
-- del proyecto (§15.2). El cliente filtra con esto y la RPC de reasignación
-- lo revalida — nunca confiar solo en que la UI filtró.
CREATE OR REPLACE FUNCTION public.assignable_users(p_country text)
RETURNS TABLE (email text, role_name text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT up.email, r.name
  FROM user_profiles up
  JOIN roles r ON r.id = up.role_id
  WHERE up.is_active = true
    AND can_access_country(p_country)          -- quien pregunta debe tener el país
    AND (r.permissions->'countries' ? p_country
         OR r.permissions->'countries' ? 'all')
  ORDER BY up.email;
$$;

COMMIT;

REVOKE ALL ON FUNCTION public._task_guard(uuid, boolean)              FROM public, anon;
REVOKE ALL ON FUNCTION public.set_task_status(uuid, text, text)       FROM public, anon;
REVOKE ALL ON FUNCTION public.add_task_comment(uuid, text)            FROM public, anon;
REVOKE ALL ON FUNCTION public.reassign_task(uuid, text)               FROM public, anon;
REVOKE ALL ON FUNCTION public.assignable_users(text)                  FROM public, anon;

GRANT EXECUTE ON FUNCTION public.set_task_status(uuid, text, text)    TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_task_comment(uuid, text)         TO authenticated;
GRANT EXECUTE ON FUNCTION public.reassign_task(uuid, text)            TO authenticated;
GRANT EXECUTE ON FUNCTION public.assignable_users(text)               TO authenticated;
-- _task_guard es interno: nadie lo llama de afuera.
