// Estado de persistencia de "Ingresar CI" — ¿qué está de verdad en el
// servidor y qué vive solo en este navegador?
//
// POR QUÉ EXISTE ESTE ARCHIVO
// El hub tenía dos indicadores que juntos MENTÍAN (SESIONES_HALLAZGOS.md
// P2-13 y P2-14):
//
//   · "✓ Confirmado en servidor hace 4s" se refrescaba también con el LATIDO.
//     Un latido solo prueba que hay conexión: no guardó ni una celda. El hub
//     podía ver ese cartel toda la sesión sin haber guardado nada.
//   · "Guardar progreso (108)" contaba TODAS las celdas llenas, pero el
//     guardado solo manda las filas COMPLETAS. Con 12 filas a medias el botón
//     prometía 108 y el mensaje de éxito decía 96 — y esas 12 celdas se
//     quedaban solo en localStorage.
//
// La regla de este archivo: **conectividad y durabilidad son cosas distintas
// y nunca se mezclan.** "El backend responde" no es "tu trabajo está a salvo",
// y para un hub que carga 300 celdas a mano la diferencia es todo.
//
// Vive separado de DataEntry.jsx (god-component conocido, CLAUDE.md §1) para
// poder testearlo con node plano — ver scripts/test-session-persistence.mjs.

// Se reusa el umbral de Monitoreo en vez de duplicar el número: si el admin
// considera "sin señal" a los 3 minutos, el hub tiene que ver lo mismo. Dos
// constantes separadas se desincronizan en la primera vez que alguien ajuste
// una sola.
// La extensión .js es OBLIGATORIA: estos módulos se testean con node plano,
// y el resolvedor ESM de Node no la infiere (Vite sí). Mismo criterio que
// uploadParsers.js.
export { LIVE_STALE_MS as SERVIDOR_STALE_MS } from './monitoring.js'
import { LIVE_STALE_MS } from './monitoring.js'

/**
 * ¿Qué se guardaría AHORA y qué quedaría solo en el navegador?
 *
 * @param {object} p
 * @param {number} p.filledCount   celdas con dato (todas, completas o no)
 * @param {number} p.savableCount  celdas que están en filas COMPLETAS
 * @param {number} p.editSeq       contador monótono de ediciones
 * @param {number} p.savedSeq      valor de editSeq en el último guardado OK
 */
export function estadoDeGuardado({
  filledCount = 0,
  savableCount = 0,
  editSeq = 0,
  savedSeq = -1,
} = {}) {
  // Celdas en filas incompletas: "Guardar progreso" NUNCA las manda, así que
  // viven solo en localStorage. Es el número que el hub necesita ver, porque
  // es exactamente lo que perdería si se le rompe la laptop.
  const soloLocal = Math.max(0, filledCount - savableCount)

  // Se compara un contador monótono de ediciones, no los datos: es imposible
  // que quede "sucio" por una comparación de referencias mal hecha, que es un
  // bug que este proyecto ya tuvo (CLAUDE.md §2).
  const hayCambiosSinGuardar = editSeq > savedSeq

  return {
    soloLocal,
    savableCount,
    hayCambiosSinGuardar,
    // Todo el trabajo guardable está en el servidor Y no quedan celdas
    // sueltas en filas a medias. Es el único caso en que se puede decir
    // "está todo guardado" sin mentir.
    todoAsegurado: !hayCambiosSinGuardar && soloLocal === 0 && savedSeq >= 0,
  }
}

/**
 * Qué cartel mostrar sobre el estado del servidor.
 *
 * `lastSaveOkAt` y `lastHeartbeatOkAt` son deliberadamente DOS parámetros
 * distintos: mezclarlos era el bug P2-14.
 *
 * Devuelve null cuando no hay nada útil que decir (sin sesión).
 */
export function estadoDeServidor({
  sessionActive = false,
  lastSaveOkAt = null,
  lastHeartbeatOkAt = null,
  hayCambiosSinGuardar = false,
  soloLocal = 0,
  now = Date.now(),
  staleMs = LIVE_STALE_MS,
} = {}) {
  if (!sessionActive) return null

  // La conexión gana sobre todo lo demás: si no hay contacto con el servidor,
  // cualquier otro mensaje ("todo guardado") sería viejo y engañoso.
  const latidoVencido = lastHeartbeatOkAt == null || now - lastHeartbeatOkAt > staleMs
  if (latidoVencido) {
    const desde = lastHeartbeatOkAt ?? lastSaveOkAt
    return {
      kind: 'sin_conexion',
      minutos: desde == null ? null : Math.max(1, Math.floor((now - desde) / 60_000)),
    }
  }

  // Nunca se guardó nada en esta sesión.
  if (lastSaveOkAt == null) {
    return { kind: 'nada_guardado' }
  }

  if (hayCambiosSinGuardar) {
    return {
      kind: 'sin_guardar',
      segundos: Math.max(0, Math.floor((now - lastSaveOkAt) / 1000)),
      soloLocal,
    }
  }

  if (soloLocal > 0) {
    // Todo lo guardable está a salvo, pero quedan celdas en filas incompletas
    // que el guardado no toca. Decir "todo guardado" acá sería la misma
    // mentira de antes, más chica.
    return {
      kind: 'guardado_parcial',
      segundos: Math.max(0, Math.floor((now - lastSaveOkAt) / 1000)),
      soloLocal,
    }
  }

  return {
    kind: 'guardado',
    segundos: Math.max(0, Math.floor((now - lastSaveOkAt) / 1000)),
  }
}

/**
 * ¿El cronómetro debe reanudar el tramo histórico, o arrancar uno nuevo?
 *
 * ESTA FUNCIÓN EXISTE POR UN BUG QUE SE INTRODUJO ARREGLANDO OTRO.
 * Al cerrar la sesión cuando cambia la fecha (P1-7), se destapó un camino que
 * antes estaba tapado: el auto-load silencioso hace
 *
 *     if (mapped > 0 && !sessionActive) sessionStartRef = earliestTurnoStart(...)
 *
 * y con la sesión ya cerrada esa rama ahora SÍ entra. Sembraba el cronómetro
 * con el `startedAt` de OTRO día: mirar una fecha pasada mostraba 30:00:00 y
 * al Terminar escribía esa duración. El fix de P1-7 empeoraba justo el número
 * que decía arreglar.
 *
 * Dos reglas, las dos necesarias:
 *
 *   1. Solo se reanuda si la fecha cargada es HOY. Corregir un día pasado es
 *      un tramo nuevo, no la continuación de aquella jornada — es lo mismo que
 *      `openHistorySession` ya documenta como correcto.
 *   2. Solo se reanuda si esa jornada NO estaba cerrada. Si todos los turnos
 *      con inicio tienen también fin, la sesión ya terminó: volver a la
 *      pantalla horas después es una corrección, no una continuación. Sin
 *      esto, terminar a las 11:00 y volver a las 15:00 marcaba 06:00:00.
 *
 * @returns {boolean} true = sembrar desde los timings; false = arrancar en 0.
 */
export function debeReanudarTramo({ loadDate, today, timings } = {}) {
  if (!loadDate || !today || loadDate !== today) return false
  if (!timings || typeof timings !== 'object') return false

  const turnos = Object.values(timings).filter((t) => t && t.startedAt)
  if (turnos.length === 0) return false

  // Jornada cerrada = todos los turnos empezados tienen fin.
  const todosCerrados = turnos.every((t) => t.endedAt)
  return !todosCerrados
}
