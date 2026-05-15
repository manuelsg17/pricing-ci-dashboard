import { createContext, useContext, useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { getCountryConfig, dbConfigToInternal, COUNTRIES } from '../lib/constants'
import { sb } from '../lib/supabase'

const CountryContext = createContext(null)

// Cache de dbConfigs en localStorage para mitigar el caso "primer render
// con dbConfigs vacío" — sin esto, antes de que cargue el fetch async,
// getCountryConfig cae al fallback de Peru aunque el usuario tenga
// localStorage.country='Bolivia'. TTL de 24h porque la config cambia
// poco y el costo de cache stale es bajo (siguiente fetch lo refresca).
const CACHE_KEY = 'cc.dbConfigs.v1'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const { ts, data } = JSON.parse(raw)
    if (!ts || (Date.now() - ts) > CACHE_TTL_MS) return null
    return data
  } catch {
    return null
  }
}

function writeCache(data) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data }))
  } catch {
    /* localStorage full / disabled, no-op */
  }
}

export function CountryProvider({ children }) {
  const [country, setCountryState] = useState(
    () => localStorage.getItem('country') || 'Peru'
  )

  // dbConfigs: { countryKey → internalConfig }
  // Init from localStorage cache para evitar race del primer render.
  const [dbConfigs, setDbConfigs] = useState(() => readCache() || {})
  // loading=true mientras el primer fetch no terminó. Algunos componentes
  // pueden querer mostrar spinner antes de leer countryConfig.
  const [loading, setLoading] = useState(true)
  const fetchedRef = useRef(false)

  const fetchAllConfigs = useCallback(async () => {
    try {
      const { data, error } = await sb
        .from('country_config')
        .select('*')
        .order('sort_order')
      if (error) {
        console.warn('[CountryContext] Could not load country_config:', error.message)
        return
      }
      if (!data?.length) return
      const mapped = {}
      data.forEach(row => {
        mapped[row.country_key] = dbConfigToInternal(row)
      })
      setDbConfigs(mapped)
      writeCache(mapped)
    } catch (e) {
      console.warn('[CountryContext] Unexpected error:', e)
    } finally {
      fetchedRef.current = true
      setLoading(false)
    }
  }, [])

  // Load on mount — cache de localStorage cubre el primer render
  useEffect(() => { fetchAllConfigs() }, [fetchAllConfigs])

  // Live-sync: cuando OTRA sesión cambia country_config (o tablas que
  // afectan los extras JSONB), refetcheamos en silencio. El toast lo
  // dispara RealtimeSyncProvider — acá solo nos enteramos del trigger.
  useEffect(() => {
    function onChange(e) {
      const t = e?.detail?.table
      if (t === 'country_config' || t === 'bot_rules' || t === 'catalog_extras') {
        fetchAllConfigs()
      }
    }
    window.addEventListener('config:changed', onChange)
    return () => window.removeEventListener('config:changed', onChange)
  }, [fetchAllConfigs])

  const setCountry = useCallback((val) => {
    setCountryState(val)
    localStorage.setItem('country', val)
    // Limpiar filtros país-específicos del hash de la URL al cambiar país.
    // Sin esto, si el hash tenía city=Lima&cat=Economy/Comfort de Peru, al
    // cambiar a Colombia esos valores stale pueden afectar la inicialización
    // de useFilters (Lima no existe en Colombia → category queda undefined).
    // Filtros universales (surge, src, view, tod, ws, ds) se preservan.
    try {
      const hash = window.location.hash
      if (hash && hash.length > 1) {
        const params = new URLSearchParams(hash.slice(1))
        ;['city', 'cat', 'sub', 'zone', 'cmp'].forEach(k => params.delete(k))
        const newHash = params.toString()
        window.history.replaceState(null, '', newHash ? '#' + newHash : window.location.pathname)
      }
    } catch { /* no-op */ }
  }, [])

  // DB config takes precedence; constants.js as fallback
  const countryConfig = useMemo(
    () => dbConfigs[country] ?? getCountryConfig(country, dbConfigs),
    [country, dbConfigs]
  )

  // Union: constants.js countries first, then DB-only keys appended.
  // Excluye países con status='draft' (solo visibles en /config para
  // el operador que los está creando). Países hardcoded de constants.js
  // se consideran 'active' por default.
  const availableCountries = useMemo(() => {
    const dbActive = Object.keys(dbConfigs).filter(k => {
      const cfg = dbConfigs[k]
      return (cfg?.status ?? 'active') === 'active'
    })
    const dbOnly = dbActive.filter(k => !COUNTRIES.includes(k))
    return [...COUNTRIES, ...dbOnly]
  }, [dbConfigs])

  // Todos los países (incluyendo drafts) — útil para el editor de
  // /config → Países que necesita ver los drafts para seguir editándolos.
  const allCountries = useMemo(() => {
    const dbOnly = Object.keys(dbConfigs).filter(k => !COUNTRIES.includes(k))
    return [...COUNTRIES, ...dbOnly]
  }, [dbConfigs])

  const refreshConfigs = useCallback(() => fetchAllConfigs(), [fetchAllConfigs])

  return (
    <CountryContext.Provider value={{
      country,
      setCountry,
      countryConfig,
      availableCountries,
      allCountries,
      dbConfigs,
      loading,
      refreshConfigs,
    }}>
      {children}
    </CountryContext.Provider>
  )
}

export function useCountry() {
  const ctx = useContext(CountryContext)
  if (!ctx) throw new Error('useCountry must be used within CountryProvider')
  return ctx
}
