// ════════════════════════════════════════════════════════════════════════
// Una pestaña vieja se cura sola cuando un deploy le borra el chunk.
//
// EL PROBLEMA, CON EVIDENCIA REAL
// El 2026-08-03 a las 14:29 UTC, un hub con la pestaña abierta desde antes de
// un deploy navegó a Ingresar CI y `client_errors` registró:
//
//   Failed to fetch dynamically imported module:
//   https://…/assets/DataEntry-XXXXXXXX.js
//
// Vite parte la app en chunks con hash en el nombre. Un deploy publica hashes
// nuevos y borra los viejos: cualquier pestaña que quedó con el `index` viejo
// pide un archivo que ya no existe, el `import()` rechaza, y React muestra la
// pantalla de error. El hub no ve un mensaje que le sirva — ve que "se rompió".
//
// POR QUÉ EL CHEQUEO DE VERSIÓN NO ALCANZA
// `useBuildVersionCheck` hace polling cada 5 minutos y recarga a los 60s de
// avisar. Entre el deploy y ese aviso hay una ventana de hasta 6 minutos en la
// que el chunk ya no existe y el chequeo todavía no dijo nada. Este helper NO
// adivina con un timer: reacciona EXACTAMENTE cuando el import falla.
//
// LAS CUATRO GUARDAS, cada una por un modo de falla concreto:
//
//  1. LA CLAVE ES LA RUTA, NUNCA EL ASSET HASHEADO. Si se marcara el intento
//     con el nombre del archivo, tras recargar el bundle nuevo pediría OTRO
//     hash, la marca no coincidiría, y se recargaría para siempre. La clave
//     ('dataentry') es estable entre builds, así que el segundo fallo se
//     reconoce como tal.
//  2. UN SOLO INTENTO POR RUTA, en sessionStorage. El segundo fallo relanza
//     para que el ErrorBoundary muestre la tarjeta: si el chunk falla por algo
//     que una recarga no arregla (red caída, CDN roto), recargar en loop deja
//     al hub sin app y sin explicación.
//  3. LA MARCA SE BORRA CUANDO EL IMPORT RESUELVE. Si no, un fallo de red hoy
//     dejaría la ruta marcada y el próximo deploy —el caso que este helper
//     viene a curar— no tendría su reintento.
//  4. NO SE DEVUELVE UNA PROMESA COLGADA. `location.reload()` no es
//     instantáneo y puede no concretarse (el usuario cancela, el navegador lo
//     difiere). Sin este `reject` diferido, React se queda en el Suspense para
//     siempre y el hub ve un spinner eterno, que es peor que el error.
//
// LA TELEMETRÍA SE REPORTA DESPUÉS DE LA RECARGA, no antes: `location.reload()`
// cancela cualquier fetch en vuelo, así que un `reportError()` acá se perdería
// justo en el caso que interesa medir. Se deja una miga y `reportarChunkFallido`
// la manda cuando la app vuelve a levantar.
// ════════════════════════════════════════════════════════════════════════

import { lazy } from 'react'

const PREFIJO = 'de:chunk-retry:'
const CLAVE_MIGA = 'de:chunk-retry:pendiente'

// Cuánto se espera a que la recarga se concrete antes de rendirse y dejar que
// el error llegue al boundary (guarda 4).
export const ESPERA_RECARGA_MS = 4000

function leer(k) {
  try {
    return sessionStorage.getItem(k)
  } catch {
    return null
  }
}
function escribir(k, v) {
  try {
    sessionStorage.setItem(k, v)
    return true
  } catch {
    return false
  }
}
function borrar(k) {
  try {
    sessionStorage.removeItem(k)
  } catch {
    /* sin sessionStorage no hay nada que borrar */
  }
}

/**
 * Decide qué hacer cuando el import de un chunk falla. Función PURA para
 * poder testear las cuatro guardas sin navegador — el efecto (recargar) lo
 * ejecuta quien la llama.
 *
 * @returns {'reintentar'|'rendirse'}
 */
export function decidirReintento({ yaReintento, puedeMarcar }) {
  // Sin sessionStorage no hay forma de saber si ya se reintentó: recargar
  // sería un loop infinito. Se prefiere el error visible.
  if (!puedeMarcar) return 'rendirse'
  return yaReintento ? 'rendirse' : 'reintentar'
}

/**
 * Igual que `lazy()`, pero si el import falla por un chunk que ya no existe,
 * recarga UNA vez para tomar el bundle nuevo.
 *
 * @param {() => Promise<any>} factory  el `() => import('./pages/X')` de siempre
 * @param {string} clave  identificador ESTABLE entre builds (la ruta, no el asset)
 */
export function lazyConReintento(factory, clave) {
  return lazy(() =>
    factory().then(
      (mod) => {
        borrar(PREFIJO + clave) // guarda 3
        return mod
      },
      (err) => {
        const k = PREFIJO + clave
        const yaReintento = leer(k) === '1'
        const puedeMarcar = yaReintento || escribir(k, '1')

        if (decidirReintento({ yaReintento, puedeMarcar }) === 'rendirse') {
          throw err
        }

        // Miga para reportar cuando la app vuelva a levantar.
        escribir(
          CLAVE_MIGA,
          JSON.stringify({ clave, mensaje: String(err?.message || err).slice(0, 500) })
        )

        try {
          window.location.reload()
        } catch {
          throw err
        }

        // Guarda 4: no dejar a React colgado en el Suspense si la recarga no
        // se concreta.
        return new Promise((_, reject) => {
          setTimeout(() => reject(err), ESPERA_RECARGA_MS)
        })
      }
    )
  )
}

/**
 * Manda a `client_errors` el fallo que provocó la recarga anterior, si lo
 * hubo. Se llama una vez al arrancar la app.
 *
 * @param {(args: object) => any} reportar  normalmente `reportError` de errorLog.js
 */
export function reportarChunkFallido(reportar) {
  const crudo = leer(CLAVE_MIGA)
  if (!crudo) return false
  borrar(CLAVE_MIGA)
  let miga
  try {
    miga = JSON.parse(crudo)
  } catch {
    return false
  }
  if (!miga?.mensaje) return false
  try {
    reportar({
      source: 'window',
      label: `chunk:${miga.clave}`,
      error: new Error(`Chunk viejo tras un deploy, recargado: ${miga.mensaje}`),
    })
  } catch {
    return false
  }
  return true
}
