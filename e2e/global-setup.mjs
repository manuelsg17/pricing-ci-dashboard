// Autenticación para los E2E: genera un magic link con el Admin API contra
// Supabase LOCAL y lo canjea por una sesión real, exactamente el flujo que
// ya se usa a mano para probar en navegador (nunca se manipulan filas de
// auth.users directamente — CLAUDE.md §2 — ni se tipea una contraseña).
//
// Las claves de acá son las claves DEMO fijas y públicas que `supabase start`
// genera siempre para instancias locales (documentadas por Supabase) — no
// son secretos de este proyecto, y solo sirven contra 127.0.0.1:54321.
import { createClient } from '@supabase/supabase-js'
import { writeFileSync, mkdirSync } from 'node:fs'

const URL = 'http://127.0.0.1:54321'
const ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'
const SERVICE_ROLE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU'
const EMAIL = 'admin@local.test'

export default async function globalSetup() {
  const admin = createClient(URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: EMAIL,
  })
  if (linkErr) {
    throw new Error(
      `[e2e/global-setup] No se pudo generar el magic link para ${EMAIL}: ${linkErr.message}. ` +
        `¿Está Supabase local corriendo (npx supabase status) y existe ese usuario en auth.users?`
    )
  }
  const tokenHash = linkData.properties?.hashed_token
  if (!tokenHash) throw new Error('[e2e/global-setup] generateLink no devolvió hashed_token')

  const anon = createClient(URL, ANON_KEY, { auth: { persistSession: false } })
  const { data: verifyData, error: verifyErr } = await anon.auth.verifyOtp({
    type: 'magiclink',
    token_hash: tokenHash,
  })
  if (verifyErr || !verifyData.session) {
    throw new Error(`[e2e/global-setup] verifyOtp falló: ${verifyErr?.message}`)
  }

  const session = verifyData.session
  // Mismo shape que persiste supabase-js real bajo `sb-127-auth-token`
  // (verificado a mano contra el localStorage de un login real) — el cliente
  // de la app lo lee tal cual al montar.
  const storedValue = JSON.stringify({
    access_token: session.access_token,
    token_type: session.token_type,
    expires_in: session.expires_in,
    expires_at: session.expires_at,
    refresh_token: session.refresh_token,
    user: session.user,
  })

  mkdirSync('./e2e/.auth', { recursive: true })
  writeFileSync(
    './e2e/.auth/admin.json',
    JSON.stringify({
      cookies: [],
      origins: [
        {
          origin: 'http://localhost:5173',
          localStorage: [
            { name: 'sb-127-auth-token', value: storedValue },
            // Inglés fijo para que los selectores de texto del test no
            // dependan del idioma por defecto (es) — mismo criterio que se
            // usó en toda la verificación manual de este feature.
            { name: 'lang', value: 'en' },
          ],
        },
      ],
    })
  )
}
