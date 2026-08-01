// Lógica pura del reporte de errores (mig 185): huella y limitadores.
//
// Vive separada de errorLog.js —que importa el cliente de Supabase— para
// poder testearla con node plano, igual que projectTasks.js y uploadParsers.js.
// Y merece test propio: si la huella es inestable, el servidor no puede
// agrupar y cada repetición crea una fila; si el limitador falla, un
// componente que crashea en loop llena la tabla en segundos.

/** Misma huella: como mucho un reporte cada 30s. */
export const THROTTLE_MS = 30_000

/** Tope duro de reportes por carga de página. */
export const MAX_PER_LOAD = 20

// djb2. No necesita ser criptográfico — solo estable entre cargas de página
// y entre usuarios, que es lo que permite agrupar del lado del servidor.
export function hash(str) {
  let h = 5381
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

/**
 * Primer frame significativo del stack. Se incluye en la huella para que dos
 * errores con el mismo mensaje pero distinto origen NO se agrupen juntos —
 * un "Cannot read properties of undefined" puede venir de veinte lugares
 * distintos y agruparlos todos haría el reporte inútil.
 */
export function firstFrameOf(stack) {
  return (
    String(stack || '')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('at ') || l.includes('@')) || ''
  )
}

/** Huella estable de un error. */
export function fingerprintOf({ source, label, message, stack } = {}) {
  return hash(
    `${source || ''}|${label || ''}|${String(message || '').slice(0, 200)}|${firstFrameOf(stack)}`
  )
}

/**
 * ¿Se puede enviar este reporte?
 *
 * Función pura sobre el estado del limitador: recibe el estado y devuelve la
 * decisión, sin tocar nada. El que muta es errorLog.js.
 *
 * @param {{sentCount:number, lastSentAt:Map<string,number>, sending:boolean}} state
 * @param {string} fingerprint
 * @param {number} now
 */
export function canSend(state, fingerprint, now) {
  if (state.sending) return { ok: false, reason: 'recursion' }
  if (state.sentCount >= MAX_PER_LOAD) return { ok: false, reason: 'cap' }
  const prev = state.lastSentAt.get(fingerprint)
  if (prev !== undefined && now - prev < THROTTLE_MS) return { ok: false, reason: 'throttled' }
  return { ok: true, reason: null }
}
