import { useState, useEffect, useCallback, useMemo } from 'react'
import { sb } from '../lib/supabase'
import { todayInTimezone, activityWindow } from '../lib/projectTasks'
import { paginarTodo } from '../lib/paginarTodo'

// Capa de datos del módulo de Proyectos (mig 183/184).
//
// Se trae TODO de una: el volumen real es de cientos de filas (5 hubs × 5
// proyectos × 30 tareas), así que paginar o cachear por vista solo agregaría
// complejidad. Si algún día esto crece a miles, el corte natural es filtrar
// por proyecto en el servidor.
//
// Las escrituras del hub van SIEMPRE por RPC, nunca por UPDATE directo: la
// mig 183 le cerró el UPDATE a propósito porque una política RLS no puede
// restringir por columna (PROYECTOS_DESIGN.md §17.2).

const SECTION = 'projects'

export function useProjectsData({ country, timezone, windowPreset = 'auto' }) {
  const [projects, setProjects] = useState([])
  const [tasks, setTasks] = useState([])
  const [comments, setComments] = useState([])
  const [statusLog, setStatusLog] = useState([])
  const [lastSeen, setLastSeen] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const today = useMemo(() => todayInTimezone(timezone), [timezone])
  const window_ = useMemo(() => activityWindow(today, windowPreset), [today, windowPreset])

  const load = useCallback(
    async ({ silent = false } = {}) => {
      if (!country) return
      if (!silent) setLoading(true)
      setError(null)
      try {
        // La ventana de actividad se pide con margen: `fromDate` es un día, y
        // los comentarios llevan hora — sin el margen se perdería lo de la
        // madrugada del primer día del rango.
        const desde = `${window_.fromDate}T00:00:00Z`

        // Las tres listas grandes se piden PAGINADAS. Sin eso PostgREST corta
        // en 1000 filas y no lo dice: medido en local, un país con 1212 tareas
        // devolvía 1000 y las otras 212 no existían para la app — ni en las
        // vistas, ni en el conteo de "Mostrando N de M". CLAUDE.md §5.
        //
        // Ordenadas por `id`, que es único: paginar por `sort_order` (que
        // arranca en 0 en cada proyecto) haría que las filas empatadas caigan
        // en cualquier orden entre página y página, perdiendo unas y repitiendo
        // otras. El orden de presentación lo pone sortTasks() después.
        const [pRes, tPag, cPag, sPag, seenRes] = await Promise.all([
          sb
            .from('projects')
            .select('*')
            .eq('country', country)
            .eq('status', 'active') // §17.3: nada de proyectos archivados
            .order('created_at', { ascending: false }),
          paginarTodo((d, h, pedirTotal) =>
            sb
              .from('project_tasks')
              .select('*', pedirTotal ? { count: 'exact' } : {})
              .eq('country', country)
              .order('id')
              .range(d, h)
          ),
          paginarTodo((d, h, pedirTotal) =>
            sb
              .from('task_comments')
              .select('*', pedirTotal ? { count: 'exact' } : {})
              .eq('country', country)
              .gte('created_at', desde)
              .order('id')
              .range(d, h)
          ),
          paginarTodo((d, h, pedirTotal) =>
            sb
              .from('task_status_log')
              .select('*', pedirTotal ? { count: 'exact' } : {})
              .eq('country', country)
              .gte('changed_at', desde)
              .order('id')
              .range(d, h)
          ),
          sb.from('section_last_seen').select('seen_at').eq('section', SECTION).maybeSingle(),
        ])

        if (pRes.error) throw pRes.error

        const activos = pRes.data || []
        // §17.3: TODAS las vistas trabajan solo con proyectos activos. La
        // consulta de proyectos ya filtra por status, pero la de tareas no
        // puede —`project_tasks` no tiene la columna— así que el recorte se
        // hacía en ninguna parte: las tareas de un proyecto archivado seguían
        // apareciendo en Hoy, Mis tareas, Kanban y Gantt, encima sin nombre de
        // proyecto porque su fila no venía. Reproducido en local, no deducido.
        //
        // Se recorta ACÁ y no en cada vista a propósito: cuatro filtros
        // separados son cuatro lugares donde olvidarse del quinto.
        const idsActivos = new Set(activos.map((p) => p.id))
        setProjects(activos)
        setTasks(tPag.filas.filter((x) => idsActivos.has(x.project_id)))
        setComments(cPag.filas)
        setStatusLog(sPag.filas)
        setLastSeen(seenRes.data?.seen_at || null)
      } catch (e) {
        setError(e.message)
      } finally {
        setLoading(false)
      }
    },
    [country, window_.fromDate]
  )

  useEffect(() => {
    load()
  }, [load])

  // Índices para no recorrer arrays dentro del render de cada fila.
  const projectById = useMemo(() => Object.fromEntries(projects.map((p) => [p.id, p])), [projects])
  const projectNameById = useMemo(
    () => Object.fromEntries(projects.map((p) => [p.id, p.name])),
    [projects]
  )

  /** Último comentario de cada tarea — es lo que se muestra en la fila. */
  const lastCommentByTask = useMemo(() => {
    const out = {}
    for (const c of comments) if (!out[c.task_id]) out[c.task_id] = c
    return out
  }, [comments])

  /**
   * Tareas con ACTIVIDAD en la ventana. Une las dos fuentes a propósito: el
   * caso más común es que el hub comente sin cambiar el estado, y calcularlo
   * solo sobre cambios de estado dejaba ese reporte invisible (§17.1).
   */
  const activeTaskIds = useMemo(() => {
    const ids = new Set()
    for (const c of comments) if (c.kind !== 'system') ids.add(c.task_id)
    for (const s of statusLog) ids.add(s.task_id)
    return ids
  }, [comments, statusLog])

  /** Marca la sección como vista — alimenta "tareas nuevas" (§15.4). */
  const markSeen = useCallback(async (email) => {
    if (!email) return
    await sb
      .from('section_last_seen')
      .upsert({ user_email: email, section: SECTION, seen_at: new Date().toISOString() })
  }, [])

  return {
    projects,
    tasks,
    comments,
    statusLog,
    projectById,
    projectNameById,
    lastCommentByTask,
    activeTaskIds,
    lastSeen,
    today,
    // La zona viaja CON `today`: comparar un timestamp del servidor (UTC)
    // contra un `today` local sin ella hacía desaparecer la tarea recién
    // completada al final de la jornada. Ver fechaLocalDe() en projectTasks.js.
    timezone,
    window: window_,
    loading,
    error,
    reload: load,
    markSeen,
  }
}

// ── Mutaciones ────────────────────────────────────────────────────────
// Devuelven { error } en vez de lanzar, para que el componente decida cómo
// mostrarlo. Los errores de las RPCs vienen con mensaje en español pensado
// para el hub (ver mig 184), así que se pueden mostrar tal cual.

export async function setTaskStatus(taskId, status, comment) {
  const { data, error } = await sb.rpc('set_task_status', {
    p_task_id: taskId,
    p_status: status,
    p_comment: comment || null,
  })
  return { data, error }
}

export async function addTaskComment(taskId, body) {
  const { data, error } = await sb.rpc('add_task_comment', {
    p_task_id: taskId,
    p_body: body,
  })
  return { data, error }
}

export async function reassignTask(taskId, newOwner) {
  const { data, error } = await sb.rpc('reassign_task', {
    p_task_id: taskId,
    p_new_owner: newOwner || null,
  })
  return { data, error }
}

/** Usuarios que PUEDEN ver ese país — si no, la tarea sería un agujero negro. */
export async function fetchAssignableUsers(country) {
  const { data, error } = await sb.rpc('assignable_users', { p_country: country })
  return { data: data || [], error }
}

export async function createProject(payload) {
  const { data, error } = await sb.from('projects').insert(payload).select().single()
  return { data, error }
}

export async function updateProject(id, patch) {
  const { error } = await sb.from('projects').update(patch).eq('id', id)
  return { error }
}

/** Archivar, no borrar: el cascade se llevaría el historial de los hubs (§13.10). */
export async function archiveProject(id) {
  const { error } = await sb.from('projects').update({ status: 'archived' }).eq('id', id)
  return { error }
}

/**
 * Los archivados, para poder verlos y devolverlos.
 *
 * Va aparte de `useProjectsData` a propósito: esa carga alimenta Hoy, Kanban,
 * Gantt y Mis tareas, y §17.3 pide que ahí NUNCA aparezcan los archivados. Esto
 * se pide solo cuando el admin abre el desplegable de archivados.
 */
export async function fetchArchivedProjects(country) {
  const { data, error } = await sb
    .from('projects')
    .select('*')
    .eq('country', country)
    .eq('status', 'archived')
    .order('updated_at', { ascending: false })
  return { data: data || [], error }
}

/** Devuelve un proyecto archivado a la lista activa. Archivar deja de ser un
 *  camino de una sola dirección. */
export async function unarchiveProject(id) {
  const { error } = await sb.from('projects').update({ status: 'active' }).eq('id', id)
  return { error }
}

/**
 * Cuántas personas del país NO pueden ser responsables por no tener la sección.
 *
 * `assignable_users` filtra por país Y por sección (mig 214), que es lo
 * correcto: asignarle una tarea a alguien que no puede abrir Proyectos crea un
 * agujero negro (§15.2). Pero el efecto visible es un desplegable con una sola
 * persona y ninguna explicación — el admin concluye que la herramienta está
 * rota, no que falta un permiso.
 *
 * Esto cuenta a los que quedaron afuera para poder decirlo. Solo lectura, y la
 * pantalla ya es admin-only.
 */
export async function fetchOwnerGap(country) {
  const [{ data: perfiles, error: e1 }, { data: roles, error: e2 }] = await Promise.all([
    sb.from('user_profiles').select('email, role_id').eq('is_active', true),
    sb.from('roles').select('id, permissions'),
  ])
  if (e1 || e2) return { sinSeccion: 0, error: e1 || e2 }

  const porId = Object.fromEntries((roles || []).map((r) => [r.id, r.permissions || {}]))
  const tiene = (lista, valor) =>
    Array.isArray(lista) && (lista.includes(valor) || lista.includes('all'))

  const sinSeccion = (perfiles || []).filter((u) => {
    const perm = porId[u.role_id]
    if (!perm) return false
    // Solo cuentan los que SÍ tienen el país: a alguien de otro país no le
    // falta un permiso, simplemente no es de acá.
    if (!tiene(perm.countries, country)) return false
    return !tiene(perm.sections, 'projects')
  }).length

  return { sinSeccion, error: null }
}

export async function createTask(payload) {
  const { data, error } = await sb.from('project_tasks').insert(payload).select().single()
  return { data, error }
}

export async function updateTask(id, patch) {
  const { error } = await sb.from('project_tasks').update(patch).eq('id', id)
  return { error }
}

export async function deleteTask(id) {
  const { error } = await sb.from('project_tasks').delete().eq('id', id)
  return { error }
}

/**
 * Correr N días el inicio y el vencimiento de varias tareas (mig 218, §15.8).
 *
 * Va por RPC y no por N updates porque `due_date + 7` es aritmética sobre la
 * columna, y eso PostgREST no lo sabe decir: desde acá habría que leer cada
 * fila, calcular y reescribirla — el loop fila por fila que CLAUDE.md §4
 * prohíbe, y encima sin atomicidad.
 *
 * Devuelve cuántas MOVIÓ, que puede ser menos que las que se mandaron (las que
 * no tienen ninguna fecha no se tocan). El componente compara y lo dice.
 */
export async function shiftTaskDates(taskIds, days) {
  const { data, error } = await sb.rpc('shift_task_dates', {
    p_task_ids: taskIds,
    p_days: days,
  })
  return { movidas: data ?? 0, error }
}

/**
 * Duplicar un proyecto con sus tareas, corriendo fechas (mig 218, §15.6).
 *
 * La RPC devuelve UNA fila con tres datos, no solo el id: cuántas tareas se
 * copiaron y cuántas quedaron sin responsable porque su dueño ya no puede ver
 * el país o perdió la sección. Ese segundo número tiene que llegar a la
 * pantalla — una tarea que figura asignada a alguien que no la ve es el
 * agujero negro de §15.2, y descubrirlo tres semanas después es el problema.
 */
export async function duplicateProject(projectId, name, shiftDays = 0) {
  const { data, error } = await sb.rpc('duplicate_project', {
    p_project_id: projectId,
    p_name: name,
    p_shift_days: shiftDays,
  })
  // PostgREST devuelve un array para una función RETURNS TABLE, aunque tenga
  // una sola fila.
  const fila = Array.isArray(data) ? data[0] : data
  return {
    nuevoId: fila?.new_project_id ?? null,
    tareas: fila?.tasks_copied ?? 0,
    sinResponsable: fila?.owners_cleared ?? 0,
    error,
  }
}

/** ¿Tiene actividad? Decide si el borrado pide confirmación o no (§17.9). */
export async function taskActivityCount(id) {
  const [c, s] = await Promise.all([
    sb.from('task_comments').select('id', { count: 'exact', head: true }).eq('task_id', id),
    sb.from('task_status_log').select('id', { count: 'exact', head: true }).eq('task_id', id),
  ])
  return (c.count || 0) + (s.count || 0)
}
