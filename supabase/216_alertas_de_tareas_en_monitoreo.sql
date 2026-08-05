-- ════════════════════════════════════════════════════════════════════════
-- 216_alertas_de_tareas_en_monitoreo.sql — el panel de tareas en riesgo
-- (PROYECTOS_DESIGN.md §7 y §13.7), y el umbral que deja de estar clavado.
--
-- QUÉ TRAE
--   1. country_config.projects_risk_days — el umbral de "en riesgo" pasa a ser
--      configurable, como pedía §7. Estaba clavado en 2 en el cliente.
--   2. get_project_task_alerts(p_country) — lo que alimenta el panel.
--
-- POR QUÉ UNA RPC Y NO CONSULTAS DEL CLIENTE
-- El panel necesita, por tarea, la FECHA DEL ÚLTIMO COMENTARIO — para detectar
-- las que llevan días sin novedades. Eso obliga a mirar `task_comments` entera,
-- sin ventana. Y PostgREST corta en 1000 filas SIN AVISAR: el panel diría "todo
-- tranquilo" simplemente porque la tarea vieja quedó afuera del corte. Es
-- exactamente el truncado silencioso que CLAUDE.md §5 prohíbe, y acá sería peor
-- que en un listado, porque un panel de alertas vacío se lee como "no hay
-- alertas".
--
-- Además cruza cuatro tablas (tareas, proyectos, comentarios, perfiles), que es
-- el criterio de CLAUDE.md §1 para que la lógica viva en una RPC.
--
-- EL "HOY" SALE DE LA ZONA DEL PAÍS, no del servidor. Con `current_date` (UTC),
-- a las 19:00 de Lima el panel ya marcaría vencidas las tareas de mañana. Es el
-- §13.4 otra vez — la columna `timezone` existe desde la mig 183 justamente
-- para esto.
--
-- SEGURIDAD (CLAUDE.md §3)
--   · SECURITY DEFINER con search_path fijo.
--   · Gate por SECCIÓN, no `is_admin()`: la pantalla de Monitoreo es admin-only
--     hoy, pero atarlo a is_admin() volvería a esconder el aislamiento por país
--     dentro del chequeo de rol, que es el bug que la mig 193 vino a arreglar.
--     Van los dos por separado: can_access_section('monitoring') Y
--     can_access_country(p_country).
--   · Revocada de anon explícitamente — `FROM public` no alcanza en este repo.
-- ════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── El umbral deja de estar clavado en el cliente ─────────────────────
ALTER TABLE public.country_config
  ADD COLUMN IF NOT EXISTS projects_risk_days smallint NOT NULL DEFAULT 2;

DO $$
BEGIN
  -- Un umbral de 0 apagaría la alerta sin que se note, y uno de 400 la haría
  -- gritar por todo. El rango se valida en la base y no solo en el formulario
  -- (CLAUDE.md §3: validar en el límite del servidor).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'country_config_risk_days_chk') THEN
    ALTER TABLE public.country_config
      ADD CONSTRAINT country_config_risk_days_chk
      CHECK (projects_risk_days BETWEEN 1 AND 30);
  END IF;
END $$;

COMMENT ON COLUMN public.country_config.projects_risk_days IS
  'Días de anticipación con los que una tarea se marca "en riesgo" en Proyectos '
  'y en el panel de Monitoreo (mig 216). Editable desde Config → Países.';

-- ── Días de silencio a partir de los cuales una tarea "en curso" alerta ──
-- Va como constante de la función y no como columna: §7 pide configurable solo
-- el umbral de riesgo, y una perilla más que nadie toca es una perilla que se
-- queda mal puesta.
CREATE OR REPLACE FUNCTION public.get_project_task_alerts(p_country text)
RETURNS TABLE (
  kind           text,     -- blocked | overdue | at_risk | silent | NULL
  owner_inactive boolean,
  task_id        uuid,
  title          text,
  project_name   text,
  owner_email    text,
  city           text,
  status         text,
  due_date       date,
  dias           int,      -- significado según kind: vencida hace, trabada hace, sin novedades hace
  motivo         text      -- último comentario (el motivo, si está trabada)
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_hoy     date;
  v_riesgo  int;
  v_tz      text;
  c_silencio constant int := 3;   -- §7: "doing" sin comentarios hace >3 días
BEGIN
  IF NOT can_access_section('monitoring') THEN
    RAISE EXCEPTION 'Sin acceso a Monitoreo' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT can_access_country(p_country) THEN
    RAISE EXCEPTION 'Sin acceso a %', p_country USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT coalesce(cc.timezone, 'UTC'), coalesce(cc.projects_risk_days, 2)
    INTO v_tz, v_riesgo
  FROM country_config cc
  WHERE cc.country_key = p_country;

  -- País sin fila de configuración: se cae a UTC en vez de devolver cero
  -- alertas, que se leería como "no hay nada que mirar".
  v_tz     := coalesce(v_tz, 'UTC');
  v_riesgo := coalesce(v_riesgo, 2);
  v_hoy    := (now() AT TIME ZONE v_tz)::date;

  RETURN QUERY
  WITH ultimo AS (
    -- Última actividad de cada tarea. Los comentarios de sistema NO cuentan:
    -- si el propio admin moviéndole la fecha a una tarea la sacara de "sin
    -- novedades", el panel dejaría de avisar justo cuando el hub sigue mudo.
    SELECT c.task_id, max(c.created_at) AS ultima
    FROM task_comments c
    WHERE c.country = p_country AND c.kind <> 'system'
    GROUP BY c.task_id
  ), texto AS (
    SELECT DISTINCT ON (c.task_id) c.task_id, c.body
    FROM task_comments c
    WHERE c.country = p_country AND c.kind <> 'system'
    ORDER BY c.task_id, c.created_at DESC
  ), base AS (
    SELECT
      t.id, t.title, t.owner_email, t.city, t.status, t.due_date, t.updated_at,
      p.name AS project_name,
      -- Los timestamps del servidor están en UTC. Compararlos contra un "hoy"
      -- que se calculó en la zona del país da un día de más o de menos: a las
      -- 19:00 de Lima, `updated_at::date` ya es mañana. Es el §13.4 entrando
      -- por el flanco de los timestamps, el mismo bug que fechaLocalDe() tuvo
      -- que arreglar del lado del cliente. Se convierten los dos a la zona.
      (coalesce(u.ultima, t.updated_at) AT TIME ZONE v_tz)::date AS dia_actividad,
      (t.updated_at AT TIME ZONE v_tz)::date                     AS dia_cambio,
      x.body,
      coalesce(up.is_active, true) AS activo,
      -- Un owner_email que no existe en user_profiles se cuenta como inactivo:
      -- una tarea asignada a alguien que no está en el padrón es igual de
      -- huérfana que una asignada a alguien dado de baja (§13.7).
      (t.owner_email IS NOT NULL AND up.email IS NULL) AS fantasma
    FROM project_tasks t
    JOIN projects p ON p.id = t.project_id
    LEFT JOIN ultimo u ON u.task_id = t.id
    LEFT JOIN texto  x ON x.task_id = t.id
    LEFT JOIN user_profiles up ON lower(up.email) = lower(t.owner_email)
    WHERE t.country = p_country
      AND p.status = 'active'      -- §17.3: los archivados no alertan
      AND t.status <> 'done'
  )
  SELECT
    CASE
      WHEN b.status = 'blocked' THEN 'blocked'
      WHEN b.due_date IS NOT NULL AND b.due_date < v_hoy THEN 'overdue'
      WHEN b.due_date IS NOT NULL AND b.due_date - v_hoy BETWEEN 0 AND v_riesgo THEN 'at_risk'
      WHEN b.status = 'doing'
           AND v_hoy - b.dia_actividad > c_silencio THEN 'silent'
    END,
    (NOT b.activo OR b.fantasma),
    b.id, b.title, b.project_name, b.owner_email, b.city, b.status, b.due_date,
    CASE
      WHEN b.status = 'blocked' THEN greatest(0, v_hoy - b.dia_cambio)
      WHEN b.due_date IS NOT NULL AND b.due_date < v_hoy THEN (v_hoy - b.due_date)
      WHEN b.due_date IS NOT NULL THEN (b.due_date - v_hoy)
      ELSE greatest(0, v_hoy - b.dia_actividad)
    END,
    b.body
  FROM base b
  WHERE b.status = 'blocked'
     OR (b.due_date IS NOT NULL AND b.due_date - v_hoy <= v_riesgo)
     OR (b.status = 'doing' AND v_hoy - b.dia_actividad > c_silencio)
     OR NOT b.activo
     OR b.fantasma
  ORDER BY
    -- Trabadas primero, después vencidas: es el orden en que hay que actuar.
    CASE WHEN b.status = 'blocked' THEN 0
         WHEN b.due_date < v_hoy   THEN 1
         ELSE 2 END,
    b.due_date NULLS LAST,
    b.title;
END;
$$;

COMMENT ON FUNCTION public.get_project_task_alerts(text) IS
  'Alimenta el panel "Tareas en riesgo" de Monitoreo (mig 216). Existe como RPC '
  'y no como consultas del cliente porque necesita la última actividad de CADA '
  'tarea sin ventana de fechas, y PostgREST corta en 1000 filas sin avisar — un '
  'panel de alertas truncado se lee como "no hay alertas".';

COMMIT;

REVOKE ALL     ON FUNCTION public.get_project_task_alerts(text) FROM public, anon;
GRANT  EXECUTE ON FUNCTION public.get_project_task_alerts(text) TO authenticated;

-- ════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
--   · La columna y su CHECK:
--       SELECT projects_risk_days FROM country_config;                -- todas en 2
--       UPDATE country_config SET projects_risk_days = 0;             -- debe fallar
--   · search_path fijado y sin grant a anon:
--       SELECT proname, proconfig, has_function_privilege('anon', oid, 'EXECUTE')
--       FROM pg_proc WHERE proname = 'get_project_task_alerts';       -- {...}, false
--   · Simulación: scripts/simulate-alertas-tareas.sql
-- ════════════════════════════════════════════════════════════════════════
