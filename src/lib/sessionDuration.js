// ════════════════════════════════════════════════════════════════════════
// Cuánto tardó de verdad un hub — fuente de verdad ÚNICA de
// `ci_sessions.duration_minutes`.
//
// POR QUÉ EXISTE ESTE ARCHIVO
// El user reportó sesiones de horas registradas como **0.1 minutos** (6
// segundos) y pidió lo contrario de lo que había: poder CONFIAR en el número
// para saber cuánto le toma a cada hub el corte de la mañana, el de la tarde
// y el de la noche.
//
// La causa raíz no era un bug puntual sino el DISEÑO: la duración se medía
// con un cronómetro de reloj de pared (`sessionStartRef`, un useRef que no
// sobrevive un F5) leído en el instante del "Terminar". Ese cronómetro se
// pisa con `Date.now()` en cinco lugares distintos, y cada uno de ellos
// produce una duración falsa:
//
//   · Aeropuerto "Ambos": al cerrar el Punto A se reinicia a `Date.now()`
//     para no sumarle al Punto B el tiempo de A. Pero el hub llena A y B en
//     la misma sentada y recién ahí cierra los dos: entre un Terminar y el
//     otro pasan SEGUNDOS. B —una hora de trabajo— quedaba en 0.1 min.
//     Ese es exactamente el síntoma reportado.
//   · "Abrir" una sesión del historial para corregir una celda arrancaba el
//     reloj en cero y escribía otra fila de 0.1 min.
//   · Un F5 con la grilla ya 100% llena no reanudaba (la jornada figura
//     cerrada) → 0.1 min.
//   · Y en la dirección opuesta: la laptop cerrada 4 horas, o un
//     `started_at` heredado de ayer, inflaban el mismo número a 6h / 24h.
//
// EL CAMBIO DE FONDO
// El reloj de pared mide "cuánto tiempo estuvo abierta la pestaña", que no
// es lo que se quiere saber. Lo que se quiere saber ya está medido con
// precisión en otro lado: `turno_timings` (mig 159) estampa startedAt en el
// primer fill de cada turno y endedAt al completarlo, una sola vez, sin
// sobreescribir nunca — y sobrevive al F5 porque viaja en el borrador, en el
// latido y en `ci_sessions`.
//
// Entonces la duración se DERIVA de los turnos, no del reloj:
//
//   duración = minutos de la UNIÓN de los tramos [startedAt, endedAt]
//
// Unión y no suma: un hub puede intercalar Mañana y Tarde, y sumar los dos
// tramos contaría dos veces el mismo minuto de pared.
//
// Propiedades que esto compra, todas verificadas en
// scripts/test-session-duration.mjs:
//   · Inmune a cuándo se apretó "Terminar" (mata el bug de Aeropuerto).
//   · Inmune al F5 y al reinicio del cronómetro (no lo usa).
//   · Acotada: un tramo mayor a TURNO_MAX_MS es laptop cerrada, no trabajo.
//   · Honesta: cuando NO se puede saber, devuelve `minutos: null` y
//     `fuente: 'desconocida'` en vez de inventar un 0. Un 0 es una mentira
//     que se promedia; un null se puede excluir.
//
// El mismo algoritmo vive en SQL (mig 187, `ci_duration_from_timings`) para
// que el cierre administrativo no sea una segunda fuente de verdad — ese era
// el otro camino por el que salía un 0 (escribía 0 literal cuando no
// encontraba fila de latido).
//
// La extensión .js es OBLIGATORIA en los imports: estos módulos se testean
// con node plano y el resolvedor ESM de Node no la infiere (Vite sí). Mismo
// criterio que uploadParsers.js y sessionPersistence.js.
// ════════════════════════════════════════════════════════════════════════

// Techo de un SOLO turno. Un turno son 36-108 celdas: llenarlo lleva minutos,
// no horas. Un tramo más largo que esto no es trabajo lento, es una pestaña
// abierta con la laptop cerrada (SESIONES_HALLAZGOS.md P1-6) o un turno que
// quedó abierto de ayer. Se recorta Y se marca `recortado: true` — recortar
// en silencio sería la misma clase de mentira que se está arreglando.
export const TURNO_MAX_MS = 4 * 60 * 60 * 1000

// Techo del fallback de reloj de pared (3 turnos × TURNO_MAX_MS). Solo aplica
// cuando no hay NINGÚN timing de turno utilizable.
export const SESION_MAX_MS = 12 * 60 * 60 * 1000

// Un décimo de minuto: la precisión con la que ya se venía guardando
// `duration_minutes` (numeric). No se cambia para no romper comparaciones
// con las filas históricas.
function redondear(ms) {
  return Math.round((ms / 60000) * 10) / 10
}

// `null` si no es una fecha parseable. Acepta ISO string, Date o epoch ms —
// los tres formatos aparecen en el código real (jsonb del servidor, Date del
// cliente, ms de un ref).
function aMs(v) {
  if (v == null || v === '') return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const ms = v instanceof Date ? v.getTime() : new Date(v).getTime()
  return Number.isFinite(ms) ? ms : null
}

/**
 * Normaliza `turno_timings` a tramos medibles.
 *
 * @param {object|null} turnoTimings  { [label]: { startedAt, endedAt } }
 * @param {object} [opts]
 * @param {number|string|Date|null} [opts.finDeSesion]
 *        Con qué cerrar un turno que tiene startedAt pero NO endedAt (el
 *        turno en curso cuando el hub aprieta Terminar, o el que el admin
 *        encuentra abierto). Si no se pasa, ese turno queda sin medir
 *        (`minutos: null`) en vez de inventarle un fin.
 * @returns {Array<{label,inicio,fin,minutos,estimado,recortado}>}
 *          ordenados por inicio. `inicio`/`fin` en epoch ms.
 */
export function tramosDeTurnos(turnoTimings, { finDeSesion = null } = {}) {
  if (!turnoTimings || typeof turnoTimings !== 'object') return []
  const finFallback = aMs(finDeSesion)
  const out = []

  for (const [label, t] of Object.entries(turnoTimings)) {
    const inicio = aMs(t?.startedAt)
    // Sin startedAt no hay nada que medir: un turno que el hub nunca tocó no
    // debe aparecer (y no debe contarse como 0 minutos de trabajo).
    if (inicio == null) continue

    let fin = aMs(t?.endedAt)
    let estimado = false

    // endedAt ausente, o corrupto (anterior a su propio inicio: pasó con
    // relojes de máquina desincronizados). En los dos casos el dato del
    // endedAt no sirve y se cae al fin de sesión, marcándolo como estimado.
    if (fin == null || fin < inicio) {
      fin = finFallback != null && finFallback >= inicio ? finFallback : null
      estimado = true
    }

    if (fin == null) {
      // Turno abierto y sin con qué cerrarlo: se reporta, pero NO aporta
      // minutos. Es el caso "el hub dejó Noche a medias y nadie cerró nada".
      out.push({ label, inicio, fin: null, minutos: null, estimado: true, recortado: false })
      continue
    }

    const bruto = fin - inicio
    const recortado = bruto > TURNO_MAX_MS
    if (recortado) fin = inicio + TURNO_MAX_MS

    out.push({ label, inicio, fin, minutos: redondear(fin - inicio), estimado, recortado })
  }

  out.sort((a, b) => a.inicio - b.inicio)
  return out
}

/**
 * Une tramos superpuestos y devuelve los minutos totales.
 *
 * Un hub puede tener Mañana [09:00,10:00] y Tarde [09:30,10:30] si intercaló
 * las dos grillas. Sumar da 120 min para 90 min reales de pared — por eso se
 * unen antes de sumar. Los tramos sin `fin` se ignoran (no aportan).
 */
export function minutosUnidos(tramos) {
  const validos = (tramos || [])
    .filter((t) => t && Number.isFinite(t.inicio) && Number.isFinite(t.fin) && t.fin >= t.inicio)
    .sort((a, b) => a.inicio - b.inicio)
  if (validos.length === 0) return 0

  let total = 0
  let curIni = validos[0].inicio
  let curFin = validos[0].fin
  for (let i = 1; i < validos.length; i++) {
    const { inicio, fin } = validos[i]
    if (inicio <= curFin) {
      // Se solapa o es contiguo: extender el tramo en curso.
      if (fin > curFin) curFin = fin
    } else {
      total += curFin - curIni
      curIni = inicio
      curFin = fin
    }
  }
  total += curFin - curIni
  return redondear(total)
}

/**
 * Duración de una sesión de Ingresar CI. **Punto único de verdad.**
 *
 * @param {object} p
 * @param {object|null} p.turnoTimings  `turno_timings` del bucket que cierra.
 * @param {number|string|Date|null} [p.inicioReloj]
 *        `sessionStartRef` — SOLO se usa si no hay ningún turno medible.
 * @param {number|string|Date} [p.fin]  instante del cierre (default: ahora).
 *
 * @returns {{
 *   minutos: number|null,   null = no se pudo saber (nunca un 0 inventado)
 *   inicio: number|null,    epoch ms del primer trabajo real
 *   fin: number|null,       epoch ms del último trabajo real
 *   porTurno: Array,        desglose Mañana/Tarde/Noche
 *   fuente: 'turnos'|'reloj'|'desconocida',
 *   confiable: boolean,     false = hubo recorte o es reloj de pared crudo
 *   motivo: string|null     por qué no es confiable
 * }}
 */
export function duracionDeSesion({ turnoTimings, inicioReloj = null, fin = Date.now() } = {}) {
  const finMs = aMs(fin) ?? Date.now()
  const porTurno = tramosDeTurnos(turnoTimings, { finDeSesion: finMs })
  const medibles = porTurno.filter((t) => t.fin != null)

  if (medibles.length > 0) {
    const recortado = medibles.some((t) => t.recortado)
    return {
      minutos: minutosUnidos(medibles),
      inicio: Math.min(...medibles.map((t) => t.inicio)),
      fin: Math.max(...medibles.map((t) => t.fin)),
      porTurno,
      fuente: 'turnos',
      confiable: !recortado,
      motivo: recortado ? 'turno_recortado' : null,
    }
  }

  // Sin ningún turno medible. Caso real y legítimo: el hub arrancó sesión,
  // no llegó a llenar una sola celda de ningún turno (nunca se estampa
  // startedAt) y cierra igual. El reloj de pared es todo lo que hay, y no
  // distingue trabajo de laptop cerrada — se devuelve marcado como NO
  // confiable para que un promedio pueda excluirlo.
  const iniMs = aMs(inicioReloj)
  if (iniMs != null && finMs >= iniMs) {
    const bruto = finMs - iniMs
    const recortado = bruto > SESION_MAX_MS
    return {
      minutos: redondear(recortado ? SESION_MAX_MS : bruto),
      inicio: iniMs,
      fin: recortado ? iniMs + SESION_MAX_MS : finMs,
      porTurno,
      fuente: 'reloj',
      confiable: false,
      motivo: recortado ? 'reloj_recortado' : 'sin_timings',
    }
  }

  // Ni turnos ni reloj: `null`, NO `0`. Un 0 entra en cualquier promedio y lo
  // arrastra hacia abajo haciendo creer que el corte fue instantáneo; un null
  // se puede excluir explícitamente. Es la diferencia entre "no sé" y
  // "tardó nada", y es justo la que rompía la métrica.
  return {
    minutos: null,
    inicio: null,
    fin: null,
    porTurno,
    fuente: 'desconocida',
    confiable: false,
    motivo: 'sin_datos',
  }
}

/**
 * Minutos por turno para mostrar (Mañana/Tarde/Noche), en el orden en que el
 * hub los empezó. Es el número que el user pidió: cuánto le toma el corte de
 * la mañana, el de la tarde y el de la noche.
 */
export function minutosPorTurno(turnoTimings, { finDeSesion = null } = {}) {
  return tramosDeTurnos(turnoTimings, { finDeSesion }).map((t) => ({
    label: t.label,
    minutos: t.minutos,
    estimado: t.estimado,
    recortado: t.recortado,
  }))
}
