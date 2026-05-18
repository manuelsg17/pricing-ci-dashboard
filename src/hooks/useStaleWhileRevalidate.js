import { useState, useEffect, useCallback, useRef } from 'react'

// ════════════════════════════════════════════════════════════════════════
// useStaleWhileRevalidate (SWR-style cache para configs)
//
// PATRÓN:
//   1. Mount → leer cache de localStorage si existe → render instantáneo.
//   2. En paralelo → fetcher() en background → si data nueva difiere, update.
//   3. Si live-sync (audit_log → CustomEvent 'config:changed') anuncia un
//      cambio en `liveSyncTable`, refetch silencioso.
//   4. Manual `reload()` disponible para botones de refresh.
//
// USO TÍPICO:
//   const { data, loading } = useStaleWhileRevalidate({
//     key: `cfg.distance_thresholds.${country}`,
//     fetcher: async () => {
//       const { data, error } = await sb.from('distance_thresholds')
//         .select('*').eq('country', country).order('city')
//       if (error) throw error
//       return data || []
//     },
//     liveSyncTable: 'distance_thresholds',
//   })
//
// NO USAR PARA:
//   - Datos transaccionales pesados (pricing_observations) — el cache
//     localStorage no escalaría y la invalidación sería compleja.
//   - Datos sensibles (audit_log) — localStorage queda en plaintext.
// ════════════════════════════════════════════════════════════════════════

const DEFAULT_TTL_MS = 5 * 60 * 1000  // 5 min — más largo que la mayoría de navegaciones entre pages

function readCache(key, ttl) {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const { ts, data } = JSON.parse(raw)
    if (!ts || Date.now() - ts > ttl) return null
    return data
  } catch { return null }
}

function writeCache(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data }))
  } catch { /* quota / disabled, no-op */ }
}

// Comparación rápida por JSON. Para arrays/objects de configs (<100KB) es
// suficientemente rápido y evita setState innecesarios cuando el server
// devuelve los mismos datos.
function deepEqual(a, b) {
  if (a === b) return true
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch { return false }
}

export function useStaleWhileRevalidate({
  key,
  fetcher,
  ttlMs = DEFAULT_TTL_MS,
  liveSyncTable = null,
  enabled = true,
}) {
  // Init from cache para que el primer render sea instantáneo
  const [data, setData]       = useState(() => key ? readCache(key, ttlMs) : null)
  const [loading, setLoading] = useState(data == null)
  const [error, setError]     = useState(null)
  const fetcherRef = useRef(fetcher)
  useEffect(() => { fetcherRef.current = fetcher }, [fetcher])

  // dataRef permite leer el `data` actual desde `load()` sin meterlo en
  // las deps del useCallback. Si lo metiéramos en deps, cada fresh data
  // recrearía `load` y re-suscribiría el listener `config:changed` de
  // live-sync (efecto cascada en cada update silencioso). dataRef
  // rompe esa cadena y mantiene la identidad estable del callback.
  const dataRef = useRef(data)
  useEffect(() => { dataRef.current = data }, [data])

  const load = useCallback(async () => {
    if (!enabled || !key) return
    setError(null)
    if (dataRef.current == null) setLoading(true)
    try {
      const fresh = await fetcherRef.current()
      // Skip setState si nada cambió → evita re-renders downstream.
      // El deepEqual JSON.stringify mantiene la referencia previa
      // cuando el server devuelve los mismos datos.
      setData(prev => deepEqual(prev, fresh) ? prev : fresh)
      writeCache(key, fresh)
    } catch (e) {
      setError(e?.message || String(e))
    } finally {
      setLoading(false)
    }
  }, [key, enabled])

  // Initial load + reload cuando cambia la key (ej: cambio de país)
  useEffect(() => {
    if (!enabled || !key) return
    // Hot path: si tenemos cache, no mostramos spinner; igual refetch
    // en background. Si no tenemos cache, sí mostramos loading.
    const cached = readCache(key, ttlMs)
    if (cached != null) {
      setData(cached)
      setLoading(false)
    } else {
      setData(null)
      setLoading(true)
    }
    load()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled])

  // Live-sync: refetch silencioso cuando OTRA sesión cambia la tabla.
  // El event lo dispara useRealtimeSync via audit_log.
  useEffect(() => {
    if (!liveSyncTable || !enabled) return
    function onChange(e) {
      if (e?.detail?.table === liveSyncTable) load()
    }
    window.addEventListener('config:changed', onChange)
    return () => window.removeEventListener('config:changed', onChange)
  }, [liveSyncTable, enabled, load])

  return { data, loading, error, reload: load }
}
