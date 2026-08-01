import { sb } from './supabase'
import { fingerprintOf, canSend } from './errorFingerprint'

// Reporte de errores del cliente → tabla `client_errors` (mig 185).
//
// POR QUÉ EXISTE: hasta ahora, si un hub veía una pantalla en blanco, el
// error moría en la consola de SU navegador y nadie se enteraba nunca. Los
// ErrorBoundary evitan que la app entera se caiga, pero no avisan a nadie.
//
// LAS TRES COSAS QUE ESTE ARCHIVO NO PUEDE HACER JAMÁS, en orden de
// importancia — un reporter de errores roto es peor que no tener ninguno:
//
//   1. LANZAR. Todo va envuelto en try/catch. Si el reporte falla, se pierde
//      el reporte, nunca la app.
//   2. RECURSAR. Si el propio envío falla y ese fallo se reporta, se entra en
//      un loop infinito que además inunda la BD. Lo corta `sending`.
//   3. INUNDAR. Un componente que crashea en loop de render dispara miles de
//      errores por segundo. Acá se corta con throttle por huella + tope duro
//      por carga de página; en el servidor, colapsando por fingerprint.

const lastSentAt = new Map()
let sentCount = 0
let sending = false // guard anti-recursión (regla 2)
let context = { country: null }

/** El país no está disponible en un class component; se inyecta desde React. */
export function setErrorContext(next) {
  context = { ...context, ...next }
}

function currentRoute() {
  try {
    return `${window.location.pathname}${window.location.hash}`.slice(0, 200)
  } catch {
    return null
  }
}

/**
 * Registra un error. Nunca lanza, nunca espera a que termine para no frenar
 * el render de la pantalla de error.
 *
 * @returns {Promise<boolean>} true si se envió (útil solo para tests).
 */
export async function reportError({ source, label, error, componentStack } = {}) {
  try {
    const message = String(error?.message || error || '').slice(0, 2000)
    if (!message.trim()) return false

    const stack = error?.stack ? String(error.stack) : null
    const fp = fingerprintOf({ source, label, message, stack })

    // Las tres reglas (recursión, tope, throttle) viven en errorFingerprint.js
    // y tienen test propio — acá solo se aplica la decisión.
    if (!canSend({ sentCount, lastSentAt, sending }, fp, Date.now()).ok) return false
    lastSentAt.set(fp, Date.now())

    sending = true
    sentCount += 1
    try {
      // El email NO se manda: lo impone la RPC desde auth.email() (mig 185),
      // así no es suplantable ni siquiera con una llamada directa a la API.
      await sb.rpc('log_client_error', {
        p_fingerprint: fp,
        p_source: source,
        p_message: message,
        p_route: currentRoute(),
        p_label: label || null,
        p_stack: stack,
        p_component_stack: componentStack || null,
        p_country: context.country || null,
        p_app_mode: import.meta.env.MODE,
        p_user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
      })
      return true
    } finally {
      sending = false
    }
  } catch {
    // Silencio deliberado (regla 1). Si el reporte falla —sin sesión, sin red,
    // RLS— el usuario ya está viendo su propio error; sumarle otro no ayuda.
    return false
  }
}

/**
 * Engancha los errores que NINGÚN ErrorBoundary ve: los de código asíncrono
 * y las promesas sin catch. Son la mayoría de los fallos silenciosos reales,
 * porque un `await` que revienta fuera del render no dispara el boundary.
 *
 * Idempotente: llamarlo dos veces no duplica los listeners.
 */
let installed = false
export function installGlobalErrorHandlers() {
  if (installed || typeof window === 'undefined') return
  installed = true

  window.addEventListener('error', (ev) => {
    // Los errores de carga de recursos (img/script) llegan acá sin `error` y
    // no son bugs de la app — se descartan.
    if (!ev?.error) return
    reportError({ source: 'window', error: ev.error })
  })

  window.addEventListener('unhandledrejection', (ev) => {
    const reason = ev?.reason
    if (!reason) return
    reportError({
      source: 'promise',
      error: reason instanceof Error ? reason : new Error(String(reason)),
    })
  })
}

/** Solo para tests: devuelve el estado interno de los limitadores. */
export function __getLimiterState() {
  return { sentCount, throttled: lastSentAt.size, sending }
}

/** Solo para tests: reinicia los limitadores. */
export function __resetLimiter() {
  lastSentAt.clear()
  sentCount = 0
  sending = false
}
