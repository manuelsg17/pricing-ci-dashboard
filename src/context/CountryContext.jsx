import { createContext, useContext, useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { getCountryConfig, dbConfigToInternal, COUNTRIES } from '../lib/constants'
import { sb } from '../lib/supabase'

const CountryContext = createContext(null)

// Cache de dbConfigs en localStorage para mitigar el caso "primer render
// con dbConfigs vacío" — sin esto, antes de que cargue el fetch async,
// getCountryConfig cae al fallback de Peru aunque el usuario tenga
// localStorage.country='Bolivia'. TTL de 24h porque la config cambia
// poco y el costo de cache stale es bajo (siguiente fetch lo refresca).
//
// INVALIDACIÓN AUTOMÁTICA POR SHAPE:
// Antes había que bumpear manualmente CACHE_KEY ('v1' → ... → 'v6')
// cada vez que dbConfigToInternal cambiaba su shape interno (ya fueron
// 6 bumps en pocas semanas: mig 72, 79, 84, 85, 95, 96, 97). Frágil y
// propenso a olvidar — si alguien refactoreaba sin bumpear, los users
// con cache viejo veían UI rota hasta 24h.
//
// Ahora el cache se INVALIDA AUTOMÁTICAMENTE si le faltan keys estructurales
// que el código actual necesita (canary check). Esto cubre el 90% de los
// casos: si dbConfigToInternal agrega/quita un field top-level o estructural,
// el cache viejo no pasa la validación y se descarta silenciosamente.
// REGLA: cuando agregues una key estructural nueva a dbConfigToInternal,
// agregala también a REQUIRED_KEYS abajo. Eso es suficiente — NO necesitás
// bumpear CACHE_VERSION para casos típicos.
// El bump manual solo es necesario si el cambio es semántico SIN agregar/
// quitar keys (ej: cambia el formato interno de competitorsByDbCityCategory
// sin renombrar keys). En esos casos, bumpear como antes.
const CACHE_VERSION = 'v6'
const CACHE_KEY = `cc.dbConfigs.${CACHE_VERSION}`
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

// Keys top-level que dbConfigToInternal SIEMPRE debe producir. Si el cache
// no las tiene, fue escrito por una versión antigua y se descarta.
const REQUIRED_KEYS = ['uiCities', 'categoriesByCity', 'competitorsByDbCityCategory', 'currency']

function isCacheShapeValid(data) {
  if (!data || typeof data !== 'object') return false
  const countries = Object.keys(data)
  if (countries.length === 0) return false
  for (const cKey of countries) {
    const cfg = data[cKey]
    if (!cfg || typeof cfg !== 'object') return false
    for (const k of REQUIRED_KEYS) {
      if (!(k in cfg)) return false
    }
  }
  return true
}

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const { ts, data } = JSON.parse(raw)
    if (!ts || Date.now() - ts > CACHE_TTL_MS) return null
    if (!isCacheShapeValid(data)) {
      // Shape incompatible (código actualizado entre escritura y lectura).
      // Descartar silenciosamente — el fetch fresh poblará con shape actual.
      localStorage.removeItem(CACHE_KEY)
      return null
    }
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
  const [country, setCountryState] = useState(() => localStorage.getItem('country') || 'Peru')

  // dbConfigs: { countryKey → internalConfig }
  // Init from localStorage cache para evitar race del primer render.
  const [dbConfigs, setDbConfigs] = useState(() => readCache() || {})
  // loading=true mientras el primer fetch no terminó. Algunos componentes
  // pueden querer mostrar spinner antes de leer countryConfig.
  const [loading, setLoading] = useState(true)
  const fetchedRef = useRef(false)

  const fetchAllConfigs = useCallback(async () => {
    try {
      const { data, error } = await sb.from('country_config').select('*').order('sort_order')
      if (error) {
        console.warn('[CountryContext] Could not load country_config:', error.message)
        return
      }
      if (!data?.length) return
      const mapped = {}
      data.forEach((row) => {
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
  useEffect(() => {
    fetchAllConfigs()
  }, [fetchAllConfigs])

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
        ;['city', 'cat', 'sub', 'zone', 'cmp'].forEach((k) => params.delete(k))
        const newHash = params.toString()
        window.history.replaceState(null, '', newHash ? '#' + newHash : window.location.pathname)
      }
    } catch {
      /* no-op */
    }
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
    const dbActive = Object.keys(dbConfigs).filter((k) => {
      const cfg = dbConfigs[k]
      return (cfg?.status ?? 'active') === 'active'
    })
    const dbOnly = dbActive.filter((k) => !COUNTRIES.includes(k))
    return [...COUNTRIES, ...dbOnly]
  }, [dbConfigs])

  // Todos los países (incluyendo drafts) — útil para el editor de
  // /config → Países que necesita ver los drafts para seguir editándolos.
  const allCountries = useMemo(() => {
    const dbOnly = Object.keys(dbConfigs).filter((k) => !COUNTRIES.includes(k))
    return [...COUNTRIES, ...dbOnly]
  }, [dbConfigs])

  const refreshConfigs = useCallback(() => fetchAllConfigs(), [fetchAllConfigs])

  const contextValue = useMemo(
    () => ({
      country,
      setCountry,
      countryConfig,
      availableCountries,
      allCountries,
      dbConfigs,
      loading,
      refreshConfigs,
    }),
    [
      country,
      setCountry,
      countryConfig,
      availableCountries,
      allCountries,
      dbConfigs,
      loading,
      refreshConfigs,
    ]
  )

  return <CountryContext.Provider value={contextValue}>{children}</CountryContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useCountry() {
  const ctx = useContext(CountryContext)
  if (!ctx) throw new Error('useCountry must be used within CountryProvider')
  return ctx
}
