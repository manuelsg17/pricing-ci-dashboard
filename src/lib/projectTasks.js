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

/**
 * Clave para "sin asignar" en filtros y agrupaciones.
 *
 * Es un centinela y no `null` porque un `<select>` no puede tener valor null:
 * su valor vacío significa "sin filtro". Sin distinguir los dos, filtrar por
 * "sin asignar" mostraba TODO — que es el peor resultado posible para un
 * filtro cuyo propósito es encontrar justamente las tareas huérfanas.
 */
export const UNASSIGNED = '__unassigned__'

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
 * La fecha LOCAL de un timestamp del servidor, como 'YYYY-MM-DD'.
 *
 * POR QUÉ EXISTE (bug real, medido)
 * `updated_at` llega de PostgREST en UTC. Compararlo con `slice(0,10)` contra
 * un "hoy" que se calculó en la zona del país hacía DESAPARECER la tarea:
 * a las 19:00 de Lima ya es el día siguiente en UTC, el string no matcheaba, y
 * como la rama de `done` hace `continue`, la tarea se iba de "Mis tareas"
 * entera — no solo de "Completadas hoy".
 *
 * Afectaba a Perú y Colombia de 19:00 a 23:59, a Bolivia desde las 20:00, y a
 * Nepal al revés (antes de las 5:45). O sea: justo al final de la jornada, que
 * es cuando el hub cierra el día y mira lo que hizo.
 *
 * Es el §13.4 del diseño ("vence hoy depende de la zona horaria") entrando por
 * el flanco de `updated_at`, que se había dado por cerrado.
 *
 * Se apoya en `todayInTimezone`, que ya acepta un instante: la regla de oro del
 * archivo sigue intacta —una sola función toca zonas horarias— y no se agrega
 * un segundo lugar donde la conversión pueda divergir.
 */
export function fechaLocalDe(timestamp, timeZone) {
  if (!timestamp) return null
  const d = new Date(timestamp)
  if (Number.isNaN(d.getTime())) return null
  // Sin zona no se puede convertir: se conserva el comportamiento viejo (la
  // fecha UTC del string) en vez de inventar una zona. Los llamadores REALES
  // siempre la pasan; esto cubre un test o un llamador viejo.
  if (!timeZone) return String(timestamp).slice(0, 10)
  return todayInTimezone(timeZone, d)
}

/**
 * Agrupa las tareas del hub por urgencia, en el orden en que se muestran.
 *
 * Devuelve SIEMPRE las mismas claves aunque estén vacías: la UI decide qué
 * mostrar, pero ninguna categoría puede desaparecer por omisión.
 *
 * `timeZone` es la del país (country_config). Sin ella, "completada hoy" se
 * evalúa en UTC y la tarea desaparece al final de la jornada — ver
 * `fechaLocalDe`.
 */
export function groupByUrgency(tasks, today, projectNameById = {}, timeZone = null) {
  const groups = { overdue: [], today: [], week: [], later: [], none: [], doneToday: [] }
  for (const t of tasks) {
    // Las completadas se quedan visibles el resto del día: el hub cierra la
    // jornada viendo lo que logró (lo que sostiene el hábito) y puede deshacer
    // un clic equivocado (§15.3).
    if (t.status === 'done') {
      if (fechaLocalDe(t.updated_at, timeZone) === today) groups.doneToday.push(t)
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

/**
 * El nombre con el que se conoce a una persona, sacado de su email.
 *
 * En producción los emails son `raisalopez@yandex-team.ru` o
 * `masantillanag@yango-team.com`: 25-30 caracteres de los cuales la mitad es
 * el dominio, repetido en cada fila. En la reunión diaria eso se recorre con
 * la vista, y el dominio no aporta nada — el nombre corto sí.
 *
 * El email completo sigue disponible en el `title` de cada bloque, que es
 * donde importa cuando hay que copiarlo o desambiguar.
 */
export function nombreCorto(email) {
  if (!email) return ''
  const arroba = email.indexOf('@')
  return arroba > 0 ? email.slice(0, arroba) : email
}

/**
 * Una fecha 'YYYY-MM-DD' como la lee una persona: "6 ago".
 *
 * El resto de la app ya muestra fechas localizadas (el Dashboard dice
 * "27 jul. → 3 ago."); solo Proyectos mostraba el ISO crudo. Con 20 filas en
 * pantalla, "2026-08-06" obliga a decodificar mentalmente cada una.
 *
 * El año se agrega SOLO cuando no es el mismo que el de referencia: repetir
 * "2026" en cada fila es ruido, pero omitirlo siempre haría que una tarea del
 * año que viene se lea como si fuera de este.
 */
export function fechaCorta(iso, locale = 'es', hoy = null) {
  if (!iso) return ''
  const [y, m, d] = String(iso).split('-').map(Number)
  if (!y || !m || !d) return String(iso)
  const mismoAno = hoy ? String(hoy).slice(0, 4) === String(y) : false
  try {
    return new Intl.DateTimeFormat(locale, {
      day: 'numeric',
      month: 'short',
      ...(mismoAno ? {} : { year: 'numeric' }),
      timeZone: 'UTC',
    }).format(new Date(Date.UTC(y, m - 1, d, 12)))
  } catch {
    // Locale inválido en country_config: mejor el ISO que una pantalla rota.
    return String(iso)
  }
}

/** Filtros vacíos. Identidad de módulo: se pasa como dependencia de efectos. */
export const EMPTY_TASK_FILTERS = Object.freeze({
  projectId: '',
  owner: '',
  city: '',
  status: '',
})

/**
 * Aplica los filtros de la barra común a una lista de tareas.
 *
 * Vive acá y no en el componente para poder testearlo, y para que las cuatro
 * vistas (Hoy, Mis tareas, Kanban, Gantt) filtren EXACTAMENTE igual: si cada
 * una lo resolviera por su cuenta, un filtro mostraría 8 tareas en una vista y
 * 9 en otra, y no habría forma de saber cuál miente.
 *
 * NO se aplica a la planilla del admin a propósito: ahí el `sort_order` de una
 * tarea nueva sale de la cantidad de tareas del proyecto, así que trabajar
 * sobre una lista filtrada asignaría órdenes repetidos.
 */
export function applyTaskFilters(tasks, filters = EMPTY_TASK_FILTERS, projectById = {}) {
  const { projectId = '', owner = '', city = '', status = '' } = filters
  if (!projectId && !owner && !city && !status) return tasks
  return tasks.filter((task) => {
    if (projectId && task.project_id !== projectId) return false
    if (status && task.status !== status) return false
    if (owner) {
      const suyo = task.owner_email || UNASSIGNED
      if (suyo !== owner) return false
    }
    if (city && !taskMatchesCity(task, projectById[task.project_id], city)) return false
    return true
  })
}
