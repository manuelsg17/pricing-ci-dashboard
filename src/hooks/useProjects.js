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

/** ¿Tiene actividad? Decide si el borrado pide confirmación o no (§17.9). */
export async function taskActivityCount(id) {
  const [c, s] = await Promise.all([
    sb.from('task_comments').select('id', { count: 'exact', head: true }).eq('task_id', id),
    sb.from('task_status_log').select('id', { count: 'exact', head: true }).eq('task_id', id),
  ])
  return (c.count || 0) + (s.count || 0)
}
