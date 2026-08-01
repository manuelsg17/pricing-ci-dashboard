// ════════════════════════════════════════════════════════════════════════
// Cuánto de ese tiempo fue TRABAJO — detección de inactividad
// (SESIONES_HALLAZGOS.md P1-6).
//
// POR QUÉ EXISTE ESTE ARCHIVO
// `sessionDuration.js` arregló la pregunta "¿desde cuándo hasta cuándo?" —
// la duración se deriva de `turno_timings` y ya no depende del cronómetro de
// pared ni de cuándo se apretó Terminar. Pero sigue midiendo RELOJ DE PARED
// entre el primer y el último fill de cada turno, y ahí adentro no distingue
// nada: el hub que abre a las 10:00, cierra la laptop de 12 a 16 y termina a
// las 16:30 registra 6h30 por ~150 minutos reales de carga.
//
// Hoy eso lo tapa el techo de 4h por turno (mig 194), y taparlo NO es
// medirlo: 4h sigue siendo el triple de lo real, entra al promedio como si
// fuera un dato, y el `duration_confiable=false` (mig 195) solo dice "este
// número es sospechoso", nunca cuál era el bueno.
//
// EL CAMBIO DE FONDO
// Se registra una TRAZA DE ACTIVIDAD: los instantes en que el hub hizo algo
// real (escribir una celda, marcar S/D, guardar). De esa traza salen los
// HUECOS, y de los huecos sale el tiempo activo:
//
//     tiempo activo = pared − (huecos mayores al umbral)
//
// Un hueco corto NO se descuenta: entre dos filas el hub consulta el
// simulador del competidor, espera que cargue la cotización, saca la captura
// y recién ahí teclea. Esos 1-3 minutos de silencio son trabajo, y
// descontarlos sería el error simétrico —medir de menos— que arruinaría la
// métrica igual de bien.
//
// QUÉ CUENTA COMO ACTIVIDAD (y qué no) está en `esActividad()`, ejecutable y
// no en un comentario, para que la respuesta no se conteste distinto en cada
// punto de uso.
//
// LA TRAZA DEBE SOBREVIVIR AL F5 (CLAUDE.md §2). Por eso no es una lista de
// timestamps sueltos —serían miles por sesión— sino tramos [inicio, fin] que
// se fusionan solos: una sesión entera entra en unas pocas decenas de
// entradas y viaja en el borrador de localStorage como JSON plano. Un `useRef`
// con los eventos en memoria sería exactamente el bug que este proyecto ya
// tuvo dos veces.
//
// HONESTIDAD ANTES QUE PRECISIÓN (misma regla que sessionDuration.js): si no
// hay traza —bundle viejo, borrador de otra máquina, localStorage
// deshabilitado— NO se devuelve "0 minutos activos". Se devuelve el número de
// pared con `actividadMedida: false`, que es "no lo pude medir", no "no
// trabajó".
//
// La extensión .js es OBLIGATORIA en los imports: estos módulos se testean con
// node plano y el resolvedor ESM de Node no la infiere (Vite sí). Mismo
// criterio que sessionDuration.js y sessionPersistence.js.
// ════════════════════════════════════════════════════════════════════════

// ── El umbral ───────────────────────────────────────────────────────────
// CINCO MINUTOS. El número decide qué interrupciones se consideran trabajo,
// así que no se elige por costumbre:
//
//   · El ritmo real de la carga es POR FILA, no por celda. Para cada ruta el
//     hub abre la app del competidor, pone origen y destino, espera la
//     cotización, mira 2-4 precios y recién entonces teclea 2-4 celdas
//     seguidas. El silencio típico entre dos ráfagas de tecleo es de 1 a 3
//     minutos, y en una ruta larga o con la app lenta se estira.
//   · 324 celdas en ~150 minutos reales dan ~28 s por celda de promedio, con
//     los tecleos agrupados: el hueco medio ENTRE ráfagas es del orden del
//     minuto, no de la hora.
//   · Un umbral de 1-2 min descontaría consultas legítimas al simulador y
//     mediría de menos, que es tan malo como medir de más: haría creer que el
//     corte se hace en 40 minutos y la próxima planificación saldría mal.
//   · Un umbral de 15-30 min (el clásico de las herramientas de analítica)
//     deja pasar entera la pausa de café, la reunión corta y media laptop
//     cerrada: es justo lo que hoy no se detecta.
//
// 5 minutos es el punto donde "sigue en la ruta" deja de ser la explicación
// más probable y pasa a serlo "se fue". Es un PARÁMETRO, no un dogma: todas
// las funciones lo aceptan por opciones para poder recalibrarlo contra datos
// reales sin tocar la lógica.
export const UMBRAL_INACTIVIDAD_MS = 5 * 60 * 1000

// ── La cola ─────────────────────────────────────────────────────────────
// Un evento marca el instante en que el hub HIZO algo, no el instante en que
// dejó de trabajar. Si el último tecleo de una ráfaga fue a las 10:20 y el
// siguiente a las 11:05, el hub no dejó de trabajar exactamente a las 10:20:
// terminó de mirar la fila, la revisó y recién ahí se fue. Sin esta cola, una
// sesión de tecleos aislados mediría CERO (todos los tramos tendrían ancho 0)
// — el mismo "0 minutos" que este frente vino a matar.
//
// Un minuto = el orden de magnitud del hueco típico entre ráfagas. Se acota
// siempre por el fin real de la ventana: si el último evento es el click en
// "Terminar", la cola vale ~0 y no infla nada.
export const COLA_ACTIVIDAD_MS = 60 * 1000

// ── Qué cuenta como actividad ───────────────────────────────────────────
// Regla: cuenta lo que el hub HACE, no lo que le PASA a la pestaña. Todo lo
// que puede ocurrir con nadie delante de la máquina está excluido, porque
// bastaría uno solo de esos eventos cada 5 minutos para que una laptop
// abierta y sola "trabaje" toda la noche — el bug de vuelta, con más pasos.
export const TIPOS_ACTIVIDAD = Object.freeze([
  'celda', // escribir precio / ETA / descuento / bids en una celda
  'sd', // marcar o desmarcar "Sin data" (celda o fila entera)
  'pegar', // pegar un bloque desde Excel
  'navegacion', // cambiar de turno, categoría, distrito o ciudad a mano
  'guardar', // "Guardar progreso"
  'iniciar', // "Iniciar Sesión"
  'terminar', // "Terminar Sesión"
])

// Documentado explícitamente, no por omisión: cada uno de estos estuvo a un
// paso de contarse "porque llega al mismo handler".
export const TIPOS_IGNORADOS = Object.freeze([
  'latido', // heartbeat de ci_active_sessions: lo dispara un setInterval
  'autoload', // carga silenciosa de lo ya guardado: la hace la app, no el hub
  'refresco', // refetch en segundo plano / realtime de otra sesión
  'visibilidad', // volver a la pestaña. Volver no es trabajar; si de verdad
  // vuelve a trabajar, el primer evento real abre el tramo — y
  // como los huecos ≤ umbral no se descuentan, no se pierde nada.
  'tick', // el reloj de la UI que refresca el cronómetro cada segundo
  'scroll', // scroll / mousemove: un roce del trackpad no es una carga
])

/**
 * ¿Este tipo de evento cuenta como trabajo del hub?
 *
 * Un tipo DESCONOCIDO devuelve false a propósito. El error de contar de más
 * (una laptop abierta y sola que "trabaja") es el bug original; el de contar
 * de menos está acotado por el umbral, que perdona 5 minutos de silencio.
 * Ante la duda, se cae del lado que no revive el bug.
 */
export function esActividad(tipo) {
  return TIPOS_ACTIVIDAD.includes(tipo)
}

function esNum(v) {
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * Agrega un evento a la traza. **Es la única función del hot path**: corre en
 * cada tecleo, así que no hace más que mirar el último tramo.
 *
 * Fusiona con el tramo en curso si el silencio previo fue tolerable; si no,
 * abre uno nuevo (y el silencio queda como hueco descontable).
 *
 * @param {Array<{inicio:number,fin:number}>} tramos  traza previa
 * @param {number} ts  epoch ms del evento
 * @returns {Array} traza nueva. Devuelve la MISMA referencia si el evento no
 *          aporta nada — así un `setState` con esta traza no re-renderiza la
 *          grilla por un evento redundante (CLAUDE.md §5).
 */
export function registrarActividad(tramos, ts, { umbralMs = UMBRAL_INACTIVIDAD_MS } = {}) {
  const base = Array.isArray(tramos) ? tramos : []
  if (!esNum(ts)) return base
  if (base.length === 0) return [{ inicio: ts, fin: ts }]

  const ultimo = base[base.length - 1]
  if (!esNum(ultimo?.inicio) || !esNum(ultimo?.fin))
    return [...base.slice(0, -1), { inicio: ts, fin: ts }]

  // Evento con timestamp viejo: reloj de la máquina corregido hacia atrás, o
  // una traza rehidratada de otro tab. No se retrocede el tramo —eso podría
  // fabricar tiempo activo que nunca existió— pero tampoco se descarta el
  // evento: si cae DENTRO del tramo en curso ya está contado.
  if (ts <= ultimo.fin) return base

  if (ts - ultimo.fin <= umbralMs) {
    return [...base.slice(0, -1), { inicio: ultimo.inicio, fin: ts }]
  }
  return [...base, { inicio: ts, fin: ts }]
}

/**
 * Ordena, descarta basura y fusiona tramos separados por menos que el umbral.
 *
 * Hace falta además de `registrarActividad` porque la traza puede llegar de
 * DOS lados y mezclada: el borrador de localStorage (que sobrevive al F5) y
 * lo que se acumuló en memoria desde entonces. Fusionar acá es lo que hace
 * que rehidratar no invente un hueco donde no lo hubo.
 */
export function normalizarActividad(tramos, { umbralMs = UMBRAL_INACTIVIDAD_MS } = {}) {
  const limpios = (Array.isArray(tramos) ? tramos : [])
    .filter((t) => t && esNum(t.inicio) && esNum(t.fin) && t.fin >= t.inicio)
    .map((t) => ({ inicio: t.inicio, fin: t.fin }))
    .sort((a, b) => a.inicio - b.inicio)
  if (limpios.length === 0) return []

  const out = [limpios[0]]
  for (let i = 1; i < limpios.length; i++) {
    const cur = out[out.length - 1]
    const sig = limpios[i]
    if (sig.inicio - cur.fin <= umbralMs) {
      if (sig.fin > cur.fin) cur.fin = sig.fin
    } else {
      out.push({ ...sig })
    }
  }
  return out
}

function redondear(ms) {
  return Math.round((ms / 60000) * 10) / 10
}

/**
 * Convierte la traza en intervalos CERRADOS de trabajo, con la cola aplicada.
 *
 * Los tramos ya vienen fusionados por umbral, así que el hueco que sigue a
 * cada uno es siempre mayor al umbral y la cola (1 min) nunca puede pisar el
 * tramo siguiente. La del último tramo se acota con `ventanaFin` si se pasa.
 */
export function tramosActivos(
  tramos,
  { umbralMs = UMBRAL_INACTIVIDAD_MS, colaMs = COLA_ACTIVIDAD_MS, ventanaFin = null } = {}
) {
  const norm = normalizarActividad(tramos, { umbralMs })
  return norm.map((t, i) => {
    const siguiente = norm[i + 1]
    let tope = siguiente ? siguiente.inicio : ventanaFin
    if (!esNum(tope)) tope = t.fin + colaMs
    const fin = Math.min(t.fin + colaMs, Math.max(tope, t.fin))
    return { inicio: t.inicio, fin }
  })
}

/**
 * Los silencios que SÍ se descuentan, para poder mostrarlos y auditarlos.
 * Un hueco que no se puede explicar es un número que nadie va a creer.
 */
export function huecosInactivos(
  tramos,
  { umbralMs = UMBRAL_INACTIVIDAD_MS, colaMs = COLA_ACTIVIDAD_MS, ventana = null } = {}
) {
  const activos = tramosActivos(tramos, { umbralMs, colaMs, ventanaFin: ventana?.fin ?? null })
  const out = []
  for (let i = 1; i < activos.length; i++) {
    const ini = activos[i - 1].fin
    const fin = activos[i].inicio
    if (fin > ini) out.push({ inicio: ini, fin, ms: fin - ini, minutos: redondear(fin - ini) })
  }
  // El silencio final —el hub dejó de tocar la grilla y recién a los 40
  // minutos apretó Terminar— también es un hueco, y es de los más caros.
  if (esNum(ventana?.fin) && activos.length > 0) {
    const ultimo = activos[activos.length - 1].fin
    const dif = ventana.fin - ultimo
    if (dif > umbralMs) {
      out.push({ inicio: ultimo, fin: ventana.fin, ms: dif, minutos: redondear(dif), final: true })
    }
  }
  return out
}

/**
 * Minutos de trabajo real que declara la traza, por sí sola.
 *
 * @returns {{ms:number, minutos:number, tramos:Array, huecos:Array, eventos:number}}
 */
export function tiempoActivo(
  tramos,
  { umbralMs = UMBRAL_INACTIVIDAD_MS, colaMs = COLA_ACTIVIDAD_MS, ventana = null } = {}
) {
  const activos = tramosActivos(tramos, { umbralMs, colaMs, ventanaFin: ventana?.fin ?? null })
  const acotados = ventana ? interseccion(activos, [ventana]) : activos
  const ms = acotados.reduce((acc, t) => acc + (t.fin - t.inicio), 0)
  return {
    ms,
    minutos: redondear(ms),
    tramos: acotados,
    huecos: huecosInactivos(tramos, { umbralMs, colaMs, ventana }),
    eventos: normalizarActividad(tramos, { umbralMs }).length,
  }
}

/**
 * Intersección de dos listas de intervalos. Las dos deben venir ordenadas y
 * sin solaparse consigo mismas (que es lo que garantiza `normalizarActividad`
 * de un lado y la unión de tramos de turno del otro).
 */
export function interseccion(a, b) {
  const A = (a || []).filter((t) => t && esNum(t.inicio) && esNum(t.fin) && t.fin > t.inicio)
  const B = (b || []).filter((t) => t && esNum(t.inicio) && esNum(t.fin) && t.fin > t.inicio)
  const out = []
  let i = 0
  let j = 0
  while (i < A.length && j < B.length) {
    const ini = Math.max(A[i].inicio, B[j].inicio)
    const fin = Math.min(A[i].fin, B[j].fin)
    if (fin > ini) out.push({ inicio: ini, fin })
    if (A[i].fin < B[j].fin) i++
    else j++
  }
  return out
}

// `null` si no es una fecha parseable. Mismo contrato que `aMs()` de
// sessionDuration.js: ISO string, Date o epoch ms — los tres formatos
// aparecen en el código real (jsonb del servidor, Date del cliente, ms de un
// ref). La paridad con `tramosDeTurnos` está verificada en
// scripts/test-idle-detection.mjs, caso [15].
function aMs(v) {
  if (v == null || v === '') return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime()
  return Number.isFinite(t) ? t : null
}

/**
 * Ventanas de trabajo por turno, **SIN el techo de 4h**.
 *
 * Es la única diferencia con `tramosDeTurnos()` de sessionDuration.js, y es
 * deliberada: ese techo existe justamente como sustituto de la detección de
 * inactividad ("capa, no mide", P1-6). Aplicarlo acá sería peor que inútil —
 * recortaría la ventana a las primeras 4 horas y el trabajo REAL posterior
 * quedaría invisible. El caso exacto del hallazgo: 10:00 a 16:30 con la
 * laptop cerrada de 12 a 16; con el techo, los 30 minutos de las 16:00 se
 * pierden y el descuento se calcula sobre una ventana falsa.
 *
 * Acá el techo no hace falta: la traza de actividad acota sola, y con datos
 * en vez de con un número redondo.
 */
export function ventanasDeTurnos(turnoTimings, { finDeSesion = null } = {}) {
  if (!turnoTimings || typeof turnoTimings !== 'object') return []
  const finFallback = aMs(finDeSesion)
  const out = []
  for (const [label, t] of Object.entries(turnoTimings)) {
    const inicio = aMs(t?.startedAt)
    if (inicio == null) continue
    let fin = aMs(t?.endedAt)
    // endedAt ausente o corrupto (anterior a su propio inicio): se cierra con
    // el fin de sesión, igual que en sessionDuration.js.
    if (fin == null || fin < inicio)
      fin = finFallback != null && finFallback >= inicio ? finFallback : null
    if (fin == null || fin <= inicio) continue
    out.push({ label, inicio, fin })
  }
  return out.sort((a, b) => a.inicio - b.inicio)
}

// Unión de las ventanas de turno — la "pared" contra la que se compara lo
// activo, expuesta como intervalos para poder intersecarla.
function ventanasDeTrabajo(turnoTimings, finDeSesion) {
  const tramos = ventanasDeTurnos(turnoTimings, { finDeSesion })
  const union = []
  for (const t of tramos) {
    const cur = union[union.length - 1]
    if (cur && t.inicio <= cur.fin) {
      if (t.fin > cur.fin) cur.fin = t.fin
    } else {
      union.push({ inicio: t.inicio, fin: t.fin })
    }
  }
  return { porTurno: tramos, union }
}

/**
 * Minutos ACTIVOS de una sesión: la duración de pared de `sessionDuration.js`
 * menos los huecos de inactividad.
 *
 * NO reemplaza a `duracionDeSesion()` ni reinterpreta su `confiable`/`motivo`:
 * los devuelve tal cual y agrega los campos nuevos. Un consumidor viejo sigue
 * leyendo lo mismo que antes (CLAUDE.md §4, expandir antes que romper).
 *
 * @param {object} p
 * @param {object|null} p.turnoTimings
 * @param {Array} p.actividad  traza de tramos [{inicio,fin}] en epoch ms
 * @param {number|string|Date} [p.fin]  instante del cierre
 * @returns {{
 *   minutos: number|null,        activos, o los de pared si no hay traza
 *   minutosPared: number|null,   reloj de pared CRUDO (sin el techo de 4h,
 *                                ver ventanasDeTurnos)
 *   descontados: number|null,    minutosPared − minutos (null si no se midió)
 *   actividadMedida: boolean,    false = no había traza utilizable
 *   cobertura: number|null,      activos / pared, 0..1
 *   huecos: Array,               los silencios descontados, auditables
 *   porTurno: Array<{label, minutos, minutosPared}>,
 *   motivoActividad: string|null
 * }}
 */
export function duracionActiva({
  turnoTimings,
  actividad,
  fin = Date.now(),
  umbralMs = UMBRAL_INACTIVIDAD_MS,
  colaMs = COLA_ACTIVIDAD_MS,
} = {}) {
  const finMs = esNum(fin) ? fin : new Date(fin).getTime()
  const finValido = Number.isFinite(finMs) ? finMs : Date.now()
  const { porTurno, union } = ventanasDeTrabajo(turnoTimings, finValido)

  const paredMs = union.reduce((acc, t) => acc + (t.fin - t.inicio), 0)
  const minutosPared = union.length > 0 ? redondear(paredMs) : null

  const desglosePared = porTurno.map((t) => ({
    label: t.label,
    minutosPared: redondear(t.fin - t.inicio),
  }))

  // Sin traza no se puede medir. Se devuelve el número de pared —el mismo de
  // siempre— marcado como no medido. Devolver 0 sería exactamente la mentira
  // que sessionDuration.js documenta: un 0 se promedia, un "no sé" se excluye.
  const norm = normalizarActividad(actividad, { umbralMs })
  if (norm.length === 0 || union.length === 0) {
    return {
      minutos: minutosPared,
      minutosPared,
      descontados: null,
      actividadMedida: false,
      cobertura: null,
      huecos: [],
      porTurno: desglosePared.map((d) => ({ ...d, minutos: d.minutosPared })),
      motivoActividad: norm.length === 0 ? 'sin_actividad' : 'sin_turnos',
    }
  }

  const activos = tramosActivos(norm, { umbralMs, colaMs, ventanaFin: finValido })
  const dentro = interseccion(activos, union)
  const activoMs = dentro.reduce((acc, t) => acc + (t.fin - t.inicio), 0)

  // Traza que no toca los turnos: pasa si el borrador viene de otra máquina o
  // de otro día. Medir 0 sobre una pared de 2 horas sería peor que no medir,
  // así que se trata como "no se pudo" y se conserva el número de pared.
  if (activoMs <= 0) {
    return {
      minutos: minutosPared,
      minutosPared,
      descontados: null,
      actividadMedida: false,
      cobertura: null,
      huecos: [],
      porTurno: desglosePared.map((d) => ({ ...d, minutos: d.minutosPared })),
      motivoActividad: 'actividad_incoherente',
    }
  }

  const minutos = redondear(activoMs)
  return {
    minutos,
    minutosPared,
    descontados: Math.max(0, Math.round((minutosPared - minutos) * 10) / 10),
    actividadMedida: true,
    cobertura: paredMs > 0 ? Math.round((activoMs / paredMs) * 100) / 100 : null,
    huecos: huecosInactivos(norm, {
      umbralMs,
      colaMs,
      ventana: { inicio: union[0].inicio, fin: union[union.length - 1].fin },
    }),
    porTurno: porTurno.map((t) => {
      const propio = interseccion(activos, [{ inicio: t.inicio, fin: t.fin }])
      const ms = propio.reduce((acc, x) => acc + (x.fin - x.inicio), 0)
      return {
        label: t.label,
        minutos: redondear(ms),
        minutosPared: redondear(t.fin - t.inicio),
      }
    }),
    motivoActividad: null,
  }
}
