-- ════════════════════════════════════════════════════════════════════════
-- 217_doble_clic_no_duplica.sql — que un clic impaciente no ensucie la
-- bitácora.
--
-- EL BUG, REPRODUCIDO EN LOCAL (ronda 2 de simulación de uso real, 2026-08-05)
-- Un hub escribe "Avancé la mitad", hace doble clic en "En curso" porque la
-- respuesta tarda, y la base queda con:
--   · 2 comentarios idénticos "Avancé la mitad"
--   · 2 comentarios de sistema "cambió el estado de «todo» a «doing»"
--   · 2 filas en task_status_log para la MISMA transición todo→doing
--
-- CAUSA RAÍZ: `set_task_status` hacía leer-decidir-escribir sin candado. Las
-- dos llamadas leen `status='todo'` antes de que ninguna haya hecho COMMIT,
-- las dos concluyen "cambió" y las dos escriben. El `IF t.status IS DISTINCT
-- FROM p_status` de la mig 184 parecía cubrirlo y no cubre nada en
-- concurrencia — es el patrón clásico de read-modify-write.
--
-- POR QUÉ IMPORTA MÁS DE LO QUE PARECE
-- `task_status_log` es la fuente de "Actividad desde la última reunión"
-- (§17.1). Transiciones fantasma inflan lo que se ve en la reunión diaria, y
-- el comentario duplicado hace que el hub parezca haber reportado dos veces.
-- La bitácora no se edita ni se borra a propósito (§15.10): lo que entra mal,
-- queda.
--
-- DOS ARREGLOS, PORQUE SON DOS PROBLEMAS DISTINTOS
--
--   1. CANDADO DE FILA (`FOR UPDATE`). Serializa las dos llamadas: la segunda
--      espera, ve el estado YA cambiado y no escribe nada. Resuelve el
--      duplicado de estado y el de comentario de sistema.
--
--      Va en `set_task_status` y no en `_task_guard` porque ese es STABLE, y
--      Postgres no permite `FOR UPDATE` en una función no volátil.
--
--   2. GUARDA ANTI-REPETICIÓN de comentarios. El candado NO alcanza para el
--      comentario del usuario: dos llamadas seriadas con el mismo texto son,
--      para la base, dos comentarios legítimos. Se descarta el que repite
--      exactamente autor+tarea+texto dentro de 10 segundos.
--
--      La ventana es corta a propósito: cubre el doble clic y el reintento por
--      lentitud, pero un "listo" escrito de nuevo cinco minutos después sigue
--      siendo un comentario válido y entra.
--
-- Cubre también `add_task_comment` — doble Enter en el campo de comentario es
-- el mismo accidente por otra puerta.
--
-- VERIFICACIÓN: al final. Simulación: scripts/simulate-doble-clic.sql
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── ¿Este comentario es una repetición accidental? ────────────────────
CREATE OR REPLACE FUNCTION public._comentario_repetido(
  p_task_id uuid, p_autor text, p_body text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM task_comments c
    WHERE c.task_id = p_task_id
      AND c.author_email = p_autor
      AND c.body = p_body
      AND c.created_at > now() - interval '10 seconds'
  );
$$;

COMMENT ON FUNCTION public._comentario_repetido(uuid, text, text) IS
  'True si el mismo autor ya escribió ese texto exacto en esa tarea hace menos '
  'de 10 segundos (mig 217). Ataja el doble clic y el reintento por lentitud '
  'sin bloquear un comentario repetido legítimo más tarde.';

-- ── set_task_status con candado ───────────────────────────────────────
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
  t        public.project_tasks;
  v_me     text := (select auth.email());
  v_texto  text := coalesce(btrim(p_comment), '');
  v_cambio boolean;
BEGIN
  IF p_status NOT IN ('todo', 'doing', 'blocked', 'done') THEN
    RAISE EXCEPTION 'Estado inválido: %', p_status;
  END IF;

  -- El candado va PRIMERO. Si se leyera el estado antes de tomarlo, dos
  -- llamadas concurrentes verían las dos el valor viejo y las dos escribirían
  -- — que es exactamente el bug que este archivo arregla.
  SELECT * INTO t FROM project_tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La tarea no existe' USING ERRCODE = 'no_data_found';
  END IF;

  -- Permisos: país y dueño. Se delega en el guard de la mig 184 para no tener
  -- dos copias de la regla (la fila ya está bloqueada, así que no puede
  -- cambiar entre el candado y el chequeo).
  PERFORM _task_guard(p_task_id, true);

  -- "Trabada" sin motivo no le sirve a nadie: es el único caso donde se
  -- exige texto (§3.2).
  IF p_status = 'blocked' AND v_texto = '' THEN
    RAISE EXCEPTION 'Para marcar una tarea como trabada hay que indicar el motivo';
  END IF;

  v_cambio := t.status IS DISTINCT FROM p_status;

  IF v_cambio THEN
    UPDATE project_tasks
       SET status = p_status, updated_at = now()
     WHERE id = p_task_id;

    INSERT INTO task_status_log (task_id, from_status, to_status, changed_by)
    VALUES (p_task_id, t.status, p_status, v_me);
  END IF;

  IF v_texto <> '' AND NOT _comentario_repetido(p_task_id, v_me, v_texto) THEN
    INSERT INTO task_comments (task_id, author_email, body, kind)
    VALUES (p_task_id, v_me, v_texto,
            CASE WHEN p_status = 'blocked' THEN 'blocker' ELSE 'progress' END);
  END IF;

  -- Alguien tocó una tarea ajena → que quede registrado y visible (§13.5).
  -- Ahora colgado de v_cambio: si no cambió nada no hay nada que anunciar, y
  -- sin esa condición la segunda llamada del doble clic dejaba un aviso de un
  -- cambio que no ocurrió.
  IF v_cambio AND t.owner_email IS NOT NULL AND t.owner_email IS DISTINCT FROM v_me THEN
    INSERT INTO task_comments (task_id, author_email, body, kind)
    VALUES (p_task_id, v_me,
            format('%s cambió el estado de «%s» a «%s»', v_me, t.status, p_status),
            'system');
  END IF;

  RETURN jsonb_build_object('ok', true, 'from', t.status, 'to', p_status, 'cambio', v_cambio);
END;
$$;

-- ── add_task_comment con la misma guarda ──────────────────────────────
CREATE OR REPLACE FUNCTION public.add_task_comment(p_task_id uuid, p_body text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_me    text := (select auth.email());
  v_texto text := coalesce(btrim(p_body), '');
BEGIN
  IF v_texto = '' THEN
    RAISE EXCEPTION 'El comentario no puede estar vacío';
  END IF;

  PERFORM _task_guard(p_task_id, true);

  -- Doble Enter en el campo de comentario: el mismo accidente por otra puerta.
  IF _comentario_repetido(p_task_id, v_me, v_texto) THEN
    RETURN jsonb_build_object('ok', true, 'duplicado', true);
  END IF;

  INSERT INTO task_comments (task_id, author_email, body, kind)
  VALUES (p_task_id, v_me, v_texto, 'progress');

  RETURN jsonb_build_object('ok', true);
END;
$$;

COMMIT;

REVOKE ALL ON FUNCTION public._comentario_repetido(uuid, text, text) FROM public, anon, authenticated;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
--   · Dos llamadas seguidas con el mismo comentario dejan UNA sola fila:
--       SELECT body, count(*) FROM task_comments WHERE task_id='<id>' GROUP BY 1;
--   · Concurrencia real (dos sesiones psql en paralelo sobre la misma tarea):
--       SELECT count(*) FROM task_status_log WHERE task_id='<id>';  -- 1, no 2
--   · search_path fijado en las tres funciones:
--       SELECT proname, proconfig FROM pg_proc
--       WHERE proname IN ('set_task_status','add_task_comment','_comentario_repetido');
-- ════════════════════════════════════════════════════════════════════════
