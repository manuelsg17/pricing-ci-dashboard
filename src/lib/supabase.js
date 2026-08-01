import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseKey) {
  console.error(
    'Faltan variables de entorno VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY.\n' +
      'Crea un archivo .env.local con esas variables.'
  )
}

// Session id único por pestaña — permite distinguir sesiones cuando varios
// usuarios comparten la misma cuenta (escenario real en este proyecto). El
// trigger audit_log (mig 62) lee este header vía
// current_setting('request.headers.x-session-id', true).
// sessionStorage en vez de localStorage porque queremos un id por tab, no
// uno persistente para siempre.
function getSessionId() {
  try {
    let sid = sessionStorage.getItem('app.sessionId')
    if (!sid) {
      sid =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `sid-${Date.now()}-${Math.random().toString(36).slice(2)}`
      sessionStorage.setItem('app.sessionId', sid)
    }
    return sid
  } catch {
    // sessionStorage puede no estar disponible (Safari private mode)
    return `sid-${Date.now()}-${Math.random().toString(36).slice(2)}`
  }
}

export const SESSION_ID = getSessionId()

// Techo de espera para CUALQUIER request (SESIONES_HALLAZGOS.md P2-16).
//
// Sin esto, un request que nunca resuelve —red que se cae a mitad, no que
// rechaza— dejaba al hub con "Guardando…", los botones deshabilitados y
// ningún mensaje, para siempre. Un fetch sin timeout no falla: se queda
// esperando, y el usuario no tiene forma de distinguirlo de "está tardando".
//
// 45s es holgado a propósito: el guardado de una grilla completa manda
// cientos de filas en una sola llamada (save_ci_batch), y cortar un guardado
// real por impaciencia sería peor que el problema que se está resolviendo.
const REQUEST_TIMEOUT_MS = 45_000

// `AbortSignal.timeout` es Chrome 103 / Safari 16 / Firefox 100, y el target
// de build de Vite es más bajo (safari14). Sin este guard, un hub que abra la
// app en un Safari de iOS 15 o un Chrome viejo de Android recibía un
// TypeError SÍNCRONO en el primer request: la app no cargaba, ni siquiera el
// login. Un timeout es una mejora; romper el arranque no es un precio
// aceptable por ella.
const SOPORTA_TIMEOUT =
  typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
const SOPORTA_ANY = typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function'

function fetchConTimeout(input, init = {}) {
  // Sin soporte: se pasa el fetch tal cual, con el signal del llamador
  // intacto. Se degrada al comportamiento anterior, no a uno peor.
  if (!SOPORTA_TIMEOUT) return fetch(input, init)

  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  // Sin AbortSignal.any NO se puede combinar sin perder uno de los dos. Se
  // prioriza el signal del LLAMADOR: supabase-js lo usa para cancelar
  // suscripciones y peticiones abortadas a propósito, y romperle eso causa
  // fugas peores que la falta de timeout.
  if (init.signal) {
    return fetch(input, {
      ...init,
      signal: SOPORTA_ANY ? AbortSignal.any([timeout, init.signal]) : init.signal,
    })
  }
  return fetch(input, { ...init, signal: timeout })
}

export const sb = createClient(supabaseUrl || '', supabaseKey || '', {
  global: {
    fetch: fetchConTimeout,
    headers: {
      // Lo lee el trigger audit_log y la lógica de "ignorar mis propios cambios"
      // del useRealtimeSync.
      'x-session-id': SESSION_ID,
    },
  },
})
