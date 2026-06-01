import { useEffect, useRef } from 'react'

// ════════════════════════════════════════════════════════════════════════
// useBuildVersionCheck — detección de deploys nuevos
//
// QUÉ HACE:
//   - Lee la versión actual del bundle desde __BUILD_VERSION__ (inyectada
//     por vite.config.js en cada build).
//   - Cada N min y cuando la pestaña vuelve a foco, fetchea
//     /pricing-ci-dashboard/version.json y compara.
//   - Si hay un build más nuevo → llama a onNewVersion() (el caller
//     muestra un toast localizado).
//
// POR QUÉ SEPARADO DE useRealtimeSync:
//   - Realtime cubre cambios de DATOS (config en DB).
//   - Este hook cubre cambios de CÓDIGO (deploys de Vite).
//   - Son completamente independientes y conviene mantenerlos separados.
//
// FALLBACK:
//   En desarrollo no hay /version.json — el fetch falla silenciosamente.
//   __BUILD_VERSION__ existe pero no hay version.json contra el cual
//   comparar. El hook simplemente no hace nada en dev.
// ════════════════════════════════════════════════════════════════════════

const POLL_INTERVAL_MS = 5 * 60 * 1000 // 5 min

// Vite expone __BUILD_VERSION__ via vite.config.js → define.
// eslint-disable-next-line no-undef
const LOCAL_VERSION = typeof __BUILD_VERSION__ !== 'undefined' ? __BUILD_VERSION__ : null

export function useBuildVersionCheck({ enabled = true, onNewVersion }) {
  const callbackRef = useRef(onNewVersion)
  const dismissedRef = useRef(false)
  // Evita toasts duplicados: check() corre en el timer inicial (30s), cada
  // 5 min y en cada visibilitychange. Sin este guard, cada detección de la
  // MISMA versión nueva apilaba otro toast. Notificamos una sola vez por versión.
  const notifiedRef = useRef(null)

  useEffect(() => {
    callbackRef.current = onNewVersion
  }, [onNewVersion])

  useEffect(() => {
    if (!enabled || !LOCAL_VERSION) return

    async function check() {
      if (dismissedRef.current) return // user dijo "Más tarde"
      try {
        // cache: no-store → siempre pega al server, no usa cache del browser
        const baseUrl = (import.meta.env.BASE_URL || '/').replace(/\/$/, '')
        const res = await fetch(`${baseUrl}/version.json?_t=${Date.now()}`, {
          cache: 'no-store',
          credentials: 'omit',
        })
        if (!res.ok) return
        const { version } = await res.json()
        if (!version) return
        // El timestamp remoto > local → hay deploy nuevo
        if (version !== LOCAL_VERSION && Number(version) > Number(LOCAL_VERSION)) {
          if (notifiedRef.current === version) return // ya avisamos por esta versión
          notifiedRef.current = version
          callbackRef.current?.({
            localVersion: LOCAL_VERSION,
            remoteVersion: version,
            dismiss: () => {
              dismissedRef.current = true
            },
          })
        }
      } catch {
        // network error / 404 en dev → silencioso
      }
    }

    // Primer check después de 30s (dar tiempo a que el app cargue)
    const firstTimer = setTimeout(check, 30_000)
    const interval = setInterval(check, POLL_INTERVAL_MS)

    // Check inmediato cuando la pestaña vuelve a foco
    function onVisibility() {
      if (document.visibilityState === 'visible') check()
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      clearTimeout(firstTimer)
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [enabled])
}
