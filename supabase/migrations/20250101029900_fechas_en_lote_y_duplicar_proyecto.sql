-- ════════════════════════════════════════════════════════════════════════
-- 218 — correr fechas en lote y duplicar un proyecto.
--
-- ⚠️  NO APLICADA A PRODUCCIÓN. Requiere autorización explícita del user para
--     ESTA migración puntual (CLAUDE.md §3), aunque haya un OK general previo.
--
-- Cierra las dos últimas piezas que PROYECTOS_DESIGN.md dejó escritas y sin
-- construir:
--   · §15.8 "correr fechas en lote" — se le asignó la Fase 2 y no se hizo.
--   · §15.6 / §10 Fase 4 "duplicar el proyecto anterior, que además deja
--     replanificar fechas de una".
--
-- ── POR QUÉ SON RPCs Y NO ESCRITURAS DIRECTAS ───────────────────────────
-- Correr fechas es aritmética sobre columnas (`due_date + N`), y eso PostgREST
-- no lo sabe expresar: desde el cliente serían N round-trips leyendo y
-- reescribiendo cada fila — justo el loop de inserts fila por fila que
-- CLAUDE.md §4 prohíbe. Duplicar cruza dos tablas y tiene que ser atómico:
-- un proyecto copiado a medias es peor que ninguno.
--
-- ── POR QUÉ `SECURITY INVOKER` Y NO `DEFINER` ───────────────────────────
-- Es la decisión de seguridad del archivo, y va al revés de lo que uno
-- escribiría por inercia. Las políticas de la mig 183 ya dicen exactamente lo
-- que tienen que decir:
--     INSERT/UPDATE/DELETE → is_admin() AND can_access_country(country)
-- Con INVOKER esas políticas se aplican solas: un hub que llame la RPC a mano
-- desde la API actualiza CERO filas, y un admin de Perú no puede tocar una
-- tarea de Colombia ni pasando su id. Hacerlas DEFINER significaría reescribir
-- ese gating a mano dentro de cada función y mantenerlo sincronizado — una
-- superficie nueva para auditar a cambio de nada. La regla de §3 sobre no
-- exigir `is_admin()` en una RPC de pantalla no aplica: acá no se exige nada,
-- se deja que RLS decida, que es más estricto y más barato de verificar.
--
-- ── EL BUG QUE APARECIÓ ESCRIBIENDO ESTO 🔴 ─────────────────────────────
-- "Quién puede ser responsable de una tarea" estaba definido en DOS lugares
-- con DOS respuestas distintas:
--   · `assignable_users` (mig 214) → país Y sección `projects`.
--   · `reassign_task`   (mig 215) → solo país.
-- O sea: el desplegable esconde a quien no puede abrir Proyectos, pero la RPC
-- se la asigna igual si la llamás directo. Es el agujero negro de §15.2
-- entrando por la puerta que la 214 dejó sin cerrar, y es EXACTAMENTE el
-- patrón que §21.1 anotó como "la cuarta vez que este repo paga lo mismo".
--
-- Duplicar un proyecto necesitaba la misma regla, así que iban a ser TRES
-- copias. Por eso la regla pasa a vivir en una sola función,
-- `task_owner_is_valid()`, y las tres la llaman. Esa función SÍ es DEFINER: es
-- un predicado sobre `user_profiles`/`roles` que devuelve un booleano y nada
-- más, igual que `is_admin()` o `can_access_country()`.
--
-- VERIFICACIÓN: al final del archivo.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ══════════════════════════════════════════════════════════════════════
-- 1. La regla de "quién puede ser responsable", en UN solo lugar
-- ══════════════════════════════════════════════════════════════════════
--
-- Se evalúa por EMAIL, no por `auth.email()`: lo que se valida es el
-- CANDIDATO, no quien pregunta. Por eso no sirven `can_access_country()` ni
-- `can_access_section()`, que miran al que llama (misma razón que documentó
-- la mig 214).
--
-- El predicado es el de la 214 tal cual, sin ampliarlo ni recortarlo: esta
-- migración unifica, no cambia el criterio. La comparación de email queda
-- EXACTA (no `lower()`) porque así estaba en las dos versiones — cambiarlo
-- acá permitiría destinos que hoy se rechazan, y eso sería otra decisión.
CREATE OR REPLACE FUNCTION public.task_owner_is_valid(p_email text, p_country text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM user_profiles up
    JOIN roles r ON r.id = up.role_id
    WHERE up.email = p_email
      AND up.is_active = true
      -- Eje 1 — el país, o la tarea no la ve (RLS la esconde).
      AND (r.permissions->'countries' ? p_country
           OR r.permissions->'countries' ? 'all')
      -- Eje 2 — la sección, o no tiene la pantalla en el menú y la tarea
      -- existe para todos menos para su responsable.
      AND (r.name = 'admin'
           OR r.permissions->'sections' ? 'projects'
           OR r.permissions->'sections' ? 'all')
  );
$$;

COMMENT ON FUNCTION public.task_owner_is_valid(text, text) IS
  'Único lugar donde vive "quién puede ser responsable de una tarea": país Y '
  'sección projects (mig 218). Antes estaba duplicado en assignable_users '
  '(214, con los dos ejes) y reassign_task (215, solo país) — el desplegable '
  'filtraba y la RPC no.';

-- Sin GRANT a `authenticated` a propósito: es un predicado sobre
-- `user_profiles`/`roles` y responder "¿este email puede recibir tareas en
-- Perú?" a cualquiera confirma qué cuentas existen y con qué permisos. Se
-- llama SOLO desde adentro de funciones `SECURITY DEFINER`, que corren como el
-- dueño y no necesitan el grant. Por eso `duplicate_project` —que es INVOKER—
-- no la usa directo: usa `assignable_users`, que ya está expuesta.
REVOKE ALL ON FUNCTION public.task_owner_is_valid(text, text) FROM public, anon, authenticated;

-- ── assignable_users pasa a usar la función ───────────────────────────
-- Misma firma y mismo resultado; lo único que cambia es de dónde sale el
-- predicado. `can_access_country(p_country)` se queda: acota a quién puede
-- PREGUNTAR, y eso no es lo mismo que a quién se puede elegir.
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
  WHERE can_access_country(p_country)
    AND task_owner_is_valid(up.email, p_country)
  ORDER BY up.email;
$$;

-- ── reassign_task deja de aceptar destinos que no ven la pantalla ─────
-- Firma idéntica (uuid, text): es un REPLACE de verdad, no un overload
-- (CLAUDE.md §3). El comentario de sistema lo sigue escribiendo el trigger de
-- la 215; acá solo cambia la validación del destino.
CREATE OR REPLACE FUNCTION public.reassign_task(p_task_id uuid, p_new_owner text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  t public.project_tasks;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Solo un admin puede reasignar tareas' USING ERRCODE = 'insufficient_privilege';
  END IF;

  t := _task_guard(p_task_id, false);

  IF p_new_owner IS NOT NULL AND NOT task_owner_is_valid(p_new_owner, t.country) THEN
    -- Mensaje deliberadamente ambiguo entre "no existe", "no tiene el país" y
    -- "no tiene la sección": distinguirlos le confirma a quien pregunta qué
    -- emails están dados de alta y con qué permisos (CLAUDE.md §3).
    RAISE EXCEPTION 'Ese usuario no puede recibir tareas de % — revisá país y sección Proyectos en Accesos', t.country;
  END IF;

  UPDATE project_tasks
     SET owner_email = p_new_owner, updated_at = now()
   WHERE id = p_task_id;

  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ══════════════════════════════════════════════════════════════════════
-- 2. Correr fechas en lote (§15.8)
-- ══════════════════════════════════════════════════════════════════════
--
-- Mueve inicio Y vencimiento la MISMA cantidad de días. Que sea la misma no es
-- un detalle de implementación: es lo que mantiene `tasks_dates_chk`
-- (due >= start) verdadero sin tener que validarlo, porque una traslación no
-- cambia la duración. Estirar un plazo es otra operación y no es esta.
--
-- `NULL + N = NULL`, así que una tarea sin inicio conserva su "sin inicio" y
-- una sin fechas no se toca — nunca se inventa una fecha que el usuario no
-- puso. Esas quedan fuera del WHERE para no gastar un UPDATE que no cambia
-- nada (y que dispararía el trigger de bitácora al pedo).
--
-- Devuelve cuántas filas movió DE VERDAD. El cliente compara contra cuántas
-- mandó y avisa la diferencia: si RLS filtró alguna o si varias no tenían
-- fecha, tiene que verse (CLAUDE.md §5, nada de truncado silencioso).
--
-- El trigger `zz_task_log_admin_changes` deja un comentario de sistema POR
-- TAREA. Es a propósito: la bitácora de cada tarea tiene que poder explicar
-- sola por qué su fecha cambió, sin obligar a reconstruir un lote.
CREATE OR REPLACE FUNCTION public.shift_task_dates(p_task_ids uuid[], p_days int)
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_n     integer;
  v_total integer := coalesce(array_length(p_task_ids, 1), 0);
BEGIN
  IF v_total = 0 OR coalesce(p_days, 0) = 0 THEN
    RETURN 0;
  END IF;

  -- Topes de cordura. No son seguridad (eso lo hace RLS): son el guardarraíl
  -- contra un cliente con un bug que mande 100.000 días o 50.000 ids.
  IF abs(p_days) > 365 THEN
    RAISE EXCEPTION 'shift_task_dates: % días queda fuera del rango permitido (±365)', p_days
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_total > 500 THEN
    RAISE EXCEPTION 'shift_task_dates: % tareas supera el máximo de 500 por llamada', v_total
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE project_tasks
     SET start_date = start_date + p_days,
         due_date   = due_date   + p_days
   WHERE id = ANY (p_task_ids)
     AND (start_date IS NOT NULL OR due_date IS NOT NULL);

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

COMMENT ON FUNCTION public.shift_task_dates(uuid[], integer) IS
  'Corre inicio y vencimiento de varias tareas la misma cantidad de días '
  '(mig 218, PROYECTOS_DESIGN §15.8). SECURITY INVOKER: el gating lo hacen las '
  'políticas de la 183. Devuelve cuántas filas movió.';

REVOKE ALL ON FUNCTION public.shift_task_dates(uuid[], integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.shift_task_dates(uuid[], integer) TO authenticated;

-- ══════════════════════════════════════════════════════════════════════
-- 3. Duplicar un proyecto (§15.6, Fase 4)
-- ══════════════════════════════════════════════════════════════════════
--
-- QUÉ SE COPIA Y QUÉ NO, y por qué:
--   · Se copia   — país, ciudades, descripción, fechas del proyecto, y de cada
--                  tarea el título, la descripción, la ciudad, el orden y el
--                  responsable.
--   · NO se copia — comentarios ni historial de estados. Son la bitácora de lo
--                  que pasó en el proyecto viejo; arrastrarla al nuevo haría
--                  que el primer día ya tenga "avances" que nadie hizo.
--   · Se resetea  — el estado de toda tarea vuelve a `todo`, y el proyecto
--                  nace `active`. Duplicar un proyecto terminado y que la
--                  copia arranque con la mitad "Lista" es exactamente lo que
--                  nadie quiere.
--
-- EL RESPONSABLE SE VALIDA, NO SE COPIA A CIEGAS. Entre el proyecto viejo y la
-- copia pudieron pasar meses: alguien se dio de baja, cambió de país o perdió
-- la sección. Copiar ese email dejaría una tarea que figura asignada y que su
-- responsable no puede ver — §15.2 de nuevo. Los que ya no califican quedan
-- SIN ASIGNAR, y la función devuelve cuántos fueron para poder decirlo en
-- pantalla en vez de que se descubra tres semanas después.
--
-- `RETURNS TABLE` en vez de un uuid pelado justamente por eso: hay tres cosas
-- que el usuario necesita saber, no una.
CREATE OR REPLACE FUNCTION public.duplicate_project(
  p_project_id uuid,
  p_name       text,
  p_shift_days integer DEFAULT 0
)
RETURNS TABLE (new_project_id uuid, tasks_copied integer, owners_cleared integer)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_src    public.projects;
  v_new_id uuid;
  v_me     text    := coalesce((select auth.email()), 'sistema');
  v_name   text    := btrim(coalesce(p_name, ''));
  v_days   integer := coalesce(p_shift_days, 0);
  v_tasks  integer;
  v_nulos  integer;   -- sin dueño EN LA COPIA
  v_previo integer;   -- ya venían sin dueño en el original
BEGIN
  IF abs(v_days) > 3650 THEN
    RAISE EXCEPTION 'duplicate_project: % días queda fuera del rango permitido (±3650)', v_days
      USING ERRCODE = 'check_violation';
  END IF;

  -- El SELECT pasa por RLS (INVOKER): si el proyecto es de otro país, acá no
  -- aparece y la función corta antes de escribir nada.
  SELECT * INTO v_src FROM projects WHERE id = p_project_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'duplicate_project: el proyecto no existe o no es visible'
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_name = '' THEN
    RAISE EXCEPTION 'duplicate_project: falta el nombre del proyecto nuevo'
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO projects (country, cities, name, description, start_date, end_date, status, created_by)
  VALUES (v_src.country, v_src.cities, v_name, v_src.description,
          v_src.start_date + v_days, v_src.end_date + v_days,
          'active', v_me)
  RETURNING id INTO v_new_id;

  -- Cuántas del ORIGINAL ya venían sin dueño. Se mide ANTES de copiar para
  -- poder descontarlas: si no, una tarea que nunca tuvo responsable se
  -- reportaría como "se quedó sin responsable", y un aviso que exagera se
  -- deja de leer igual de rápido que uno que falta.
  SELECT count(*)::int INTO v_previo
  FROM project_tasks t
  WHERE t.project_id = p_project_id AND t.owner_email IS NULL;

  -- El `country` de las tareas lo pone el trigger zz_task_inherit_country a
  -- partir del proyecto; no se copia a mano ni se menciona acá (mig 183).
  --
  -- La lista de responsables válidos sale de `assignable_users`, que ya es LA
  -- definición (ver punto 1). Se la llama en vez de `task_owner_is_valid`
  -- porque esta función es INVOKER: correría como `authenticated`, que no
  -- tiene EXECUTE sobre el predicado interno. `assignable_users` sí está
  -- expuesta —la usa el desplegable de la planilla— y encierra la misma regla.
  WITH validos AS (
    SELECT email FROM assignable_users(v_src.country)
  ), copiadas AS (
    INSERT INTO project_tasks
      (project_id, city, title, description, owner_email, start_date, due_date, status, sort_order, created_by)
    SELECT v_new_id,
           t.city,
           t.title,
           t.description,
           -- `IN` con owner_email NULL da NULL, así que el CASE cae en el ELSE
           -- implícito y la tarea nace sin asignar, que es lo correcto.
           CASE WHEN t.owner_email IN (SELECT email FROM validos) THEN t.owner_email END,
           t.start_date + v_days,
           t.due_date   + v_days,
           'todo',
           t.sort_order,
           v_me
    FROM project_tasks t
    WHERE t.project_id = p_project_id
    RETURNING owner_email
  )
  SELECT count(*)::int, count(*) FILTER (WHERE owner_email IS NULL)::int
    INTO v_tasks, v_nulos
  FROM copiadas;

  RETURN QUERY
    SELECT v_new_id,
           coalesce(v_tasks, 0),
           greatest(coalesce(v_nulos, 0) - coalesce(v_previo, 0), 0);
END;
$$;

COMMENT ON FUNCTION public.duplicate_project(uuid, text, integer) IS
  'Copia un proyecto con sus tareas, corriendo fechas N días y reseteando '
  'estados a todo (mig 218, PROYECTOS_DESIGN §15.6). No copia comentarios ni '
  'historial. Los responsables que ya no califican quedan sin asignar y se '
  'informa cuántos fueron. SECURITY INVOKER: el gating lo hacen las políticas '
  'de la 183.';

REVOKE ALL ON FUNCTION public.duplicate_project(uuid, text, integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.duplicate_project(uuid, text, integer) TO authenticated;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN — correr después de aplicar
-- ════════════════════════════════════════════════════════════════════════
--
-- 1) Las tres funciones nuevas/tocadas, con search_path fijo y el modelo de
--    seguridad que corresponde a cada una:
--
-- SELECT p.proname,
--        p.prosecdef AS security_definer,
--        p.proconfig
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'public'
--    AND p.proname IN ('task_owner_is_valid','shift_task_dates','duplicate_project',
--                      'assignable_users','reassign_task')
--  ORDER BY p.proname;
--
--    Esperado: task_owner_is_valid / assignable_users / reassign_task → t
--              shift_task_dates / duplicate_project                   → f
--              proconfig = {search_path=public,pg_temp} en las cinco.
--
-- 2) `anon` no puede ejecutar NINGUNA de las tres nuevas:
--
-- SELECT p.proname,
--        has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon,
--        has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--  WHERE n.nspname = 'public'
--    AND p.proname IN ('task_owner_is_valid','shift_task_dates','duplicate_project');
--
--    Esperado: anon = false en las tres. auth = true en shift/duplicate,
--              false en task_owner_is_valid (se llama desde dentro, no desde
--              el cliente).
--
-- 3) NO se crearon overloads (el bug PGRST203 de §3):
--
-- SELECT proname, count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--  WHERE n.nspname='public'
--    AND proname IN ('assignable_users','reassign_task','shift_task_dates',
--                    'duplicate_project','task_owner_is_valid')
--  GROUP BY proname HAVING count(*) > 1;
--
--    Esperado: 0 filas.
--
-- 4) Correr fechas mantiene la duración y el CHECK (sobre datos de prueba):
--
-- SELECT count(*) AS violaciones FROM project_tasks
--  WHERE start_date IS NOT NULL AND due_date IS NOT NULL AND due_date < start_date;
--
--    Esperado: 0.
-- ════════════════════════════════════════════════════════════════════════
