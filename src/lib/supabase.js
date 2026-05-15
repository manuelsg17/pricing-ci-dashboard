import { createClient } from '@supabase/supabase-js'

const supabaseUrl  = import.meta.env.VITE_SUPABASE_URL
const supabaseKey  = import.meta.env.VITE_SUPABASE_ANON_KEY

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
      sid = (typeof crypto !== 'undefined' && crypto.randomUUID)
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

export const sb = createClient(supabaseUrl || '', supabaseKey || '', {
  global: {
    headers: {
      // Lo lee el trigger audit_log y la lógica de "ignorar mis propios cambios"
      // del useRealtimeSync.
      'x-session-id': SESSION_ID,
    },
  },
})
