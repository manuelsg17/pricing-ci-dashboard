// Lógica pura del módulo de Proyectos — cálculos de fechas, urgencia y
// agrupación. Vive acá y no en los componentes por la misma razón que los
// parsers de Upload: para poder testearla (scripts/test-project-tasks.mjs).
//
// REGLA DE ORO DE ESTE ARCHIVO: se trabaja con fechas como STRINGS
// 'YYYY-MM-DD', nunca con objetos Date sueltos. Un `new Date('2026-08-01')` se
// interpreta en UTC y `new Date(2026, 7, 1)` en local — mezclarlos corre las
// fechas un día según la hora del navegador, que es exactamente el bug que la
// simulación encontró con "vence hoy" (PROYECTOS_DESIGN.md §13.4). La única
// función que toca zonas horarias es todayInTimezone(); el resto opera sobre
// strings y es inmune.

/** Estados canónicos. El orden importa: define el orden del Kanban. */
export const TASK_STATUSES = ['todo', 'doing', 'blocked', 'done']

/** Días hábiles en curso a partir de los cuales una tarea se marca estancada. */
export const STALLED_BUSINESS_DAYS = 10

/** Días trabada a partir de los cuales se escala visualmente. */
export const BLOCKED_ESCALATE_DAYS = 3

/**
 * "Hoy" en la zona horaria de un país, como 'YYYY-MM-DD'.
 *
 * Es el único punto del módulo que depende del reloj y de la zona. Todo lo
 * demás recibe ese string. Sin esto, el corte del día sale del navegador o del
 * servidor y a las 19:00 de Lima el sistema ya cree que es mañana.
 */
export function todayInTimezone(timeZone, now = new Date()) {
  try {
    // en-CA da directamente YYYY-MM-DD
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now)
  } catch {
    // Zona inválida en country_config → no romper la pantalla, caer a UTC.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now)
  }
}

// Mediodía UTC: lejos de cualquier borde de día, así ningún ajuste de horario
// de verano corre la fecha.
function parseISO(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0))
}

function toISO(dateObj) {
  return dateObj.toISOString().slice(0, 10)
}

/** Suma (o resta) días a una fecha 'YYYY-MM-DD'. */
export function addDays(dateStr, n) {
  const d = parseISO(dateStr)
  d.setUTCDate(d.getUTCDate() + n)
  return toISO(d)
}

/** Días calendario entre dos fechas (b - a). Negativo si b es anterior. */
export function daysBetween(a, b) {
  return Math.round((parseISO(b) - parseISO(a)) / 86400000)
}

/** true para lunes a viernes. */
export function isBusinessDay(dateStr) {
  const dow = parseISO(dateStr).getUTCDay()
  return dow >= 1 && dow <= 5
}

/**
 * Día hábil anterior. Un lunes devuelve el viernes.
 *
 * Es el corazón del "problema del lunes" (§15.1): con "ayer" literal, un lunes
 * mira el domingo y TODO lo que los hubs avanzaron el viernes queda invisible
 * en la reunión más importante de la semana — y encima en silencio, porque la
 * pantalla diría "sin novedades" en vez de "faltan datos".
 */
export function previousBusinessDay(dateStr) {
  let d = addDays(dateStr, -1)
  while (!isBusinessDay(d)) d = addDays(d, -1)
  return d
}

/** Días hábiles entre dos fechas, sin contar la inicial. */
export function businessDaysBetween(a, b) {
  const total = daysBetween(a, b)
  if (total <= 0) return 0
  let count = 0
  for (let i = 1; i <= total; i++) {
    if (isBusinessDay(addDays(a, i))) count++
  }
  return count
}

/**
 * Ventana de "Actividad desde la última reunión".
 *
 * `preset` puede ser 'auto' (día hábil anterior), '24h', '3d' o '7d'.
 * Devuelve { fromDate, label } — `label` se muestra SIEMPRE en el encabezado
 * para que nunca haya que adivinar qué rango se está viendo.
 */
export function activityWindow(today, preset = 'auto') {
  if (preset === '24h') return { fromDate: addDays(today, -1), days: 1 }
  if (preset === '3d') return { fromDate: addDays(today, -3), days: 3 }
  if (preset === '7d') return { fromDate: addDays(today, -7), days: 7 }
  const from = previousBusinessDay(today)
  return { fromDate: from, days: daysBetween(from, today) }
}

/**
 * Urgencia de una tarea. Es un CÁLCULO, no una columna: una columna habría
 * que mantenerla a mano y quedaría vieja (§5).
 *
 * 'none' = sin fecha. Nunca se esconde: tiene su propia sección visible, si no
 * las tareas sin fecha desaparecen del radar (§13.3).
 */
export function taskUrgency(task, today) {
  if (task.status === 'done') return 'done'
  if (!task.due_date) return 'none'
  const diff = daysBetween(today, task.due_date)
  if (diff < 0) return 'overdue'
  if (diff === 0) return 'today'
  if (diff <= 7) return 'week'
  return 'later'
}

/** Vence dentro del umbral y no está lista. Umbral configurable, default 2. */
export function isAtRisk(task, today, thresholdDays = 2) {
  if (task.status === 'done' || !task.due_date) return false
  const diff = daysBetween(today, task.due_date)
  return diff >= 0 && diff <= thresholdDays
}

/**
 * Tarea estancada: demasiados días hábiles "en curso".
 *
 * Casi nunca significa que el hub sea lento — significa que la tarea está mal
 * dimensionada. Es la señal más útil que puede dar un tablero y ninguna vista
 * la mostraba (§15.9).
 */
export function isStalled(task, today, { since } = {}) {
  if (task.status !== 'doing') return false
  const from = since || task.updated_at?.slice(0, 10) || task.start_date
  if (!from) return false
  return businessDaysBetween(from, today) >= STALLED_BUSINESS_DAYS
}

/** Días que lleva trabada. null si no lo está. */
export function blockedDays(task, today, { since } = {}) {
  if (task.status !== 'blocked') return null
  const from = since || task.updated_at?.slice(0, 10)
  if (!from) return null
  return Math.max(0, daysBetween(from, today))
}

/**
 * Orden estable dentro de un grupo: vencimiento → proyecto → sort_order.
 *
 * `sort_order` es por proyecto, así que un hub con tareas de 3 proyectos tiene
 * 3 secuencias que arrancan en 0 — ordenar solo por ese campo mezcla
 * arbitrariamente (§17.5). El nombre de proyecto desempata y el resultado es
 * el mismo entre recargas.
 */
export function sortTasks(tasks, projectNameById = {}) {
  return [...tasks].sort((a, b) => {
    const da = a.due_date || '9999-12-31'
    const db = b.due_date || '9999-12-31'
    if (da !== db) return da < db ? -1 : 1
    const pa = projectNameById[a.project_id] || ''
    const pb = projectNameById[b.project_id] || ''
    if (pa !== pb) return pa < pb ? -1 : 1
    return (a.sort_order ?? 0) - (b.sort_order ?? 0)
  })
}

/**
 * Agrupa las tareas del hub por urgencia, en el orden en que se muestran.
 *
 * Devuelve SIEMPRE las mismas claves aunque estén vacías: la UI decide qué
 * mostrar, pero ninguna categoría puede desaparecer por omisión.
 */
export function groupByUrgency(tasks, today, projectNameById = {}) {
  const groups = { overdue: [], today: [], week: [], later: [], none: [], doneToday: [] }
  for (const t of tasks) {
    // Las completadas se quedan visibles el resto del día: el hub cierra la
    // jornada viendo lo que logró (lo que sostiene el hábito) y puede deshacer
    // un clic equivocado (§15.3).
    if (t.status === 'done') {
      if (t.updated_at?.slice(0, 10) === today) groups.doneToday.push(t)
      continue
    }
    groups[taskUrgency(t, today)].push(t)
  }
  for (const k of Object.keys(groups)) {
    groups[k] = sortTasks(groups[k], projectNameById)
  }
  return groups
}

/**
 * Valida fechas al crear/editar una tarea.
 * Devuelve { valid, error, warning } — el aviso NO bloquea: a veces se carga
 * algo ya atrasado a propósito, y avisar es mejor que prohibir (§15.7).
 */
export function validateTaskDates(startDate, dueDate, today) {
  if (startDate && dueDate && dueDate < startDate) {
    return { valid: false, error: 'dates_out_of_order' }
  }
  if (dueDate && today && dueDate < today) {
    return { valid: true, warning: 'born_overdue' }
  }
  return { valid: true }
}

/**
 * ¿Este proyecto aplica a la ciudad filtrada?
 *
 * `cities` vacío = alcance total del país. Sin esta regla, filtrar por una
 * ciudad hacía DESAPARECER los proyectos multi-ciudad — justo los más
 * importantes se volvían invisibles al filtrar (§13.1).
 */
export function projectMatchesCity(project, city) {
  if (!city) return true
  const cities = project.cities || []
  if (cities.length === 0) return true
  return cities.includes(city)
}

/** La tarea matchea si es de esa ciudad, o si hereda el alcance del proyecto. */
export function taskMatchesCity(task, project, city) {
  if (!city) return true
  if (task.city) return task.city === city
  return projectMatchesCity(project || {}, city)
}
