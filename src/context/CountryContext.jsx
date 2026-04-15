import { createContext, useContext, useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { getCountryConfig, dbConfigToInternal, COUNTRIES } from '../lib/constants'
import { sb } from '../lib/supabase'

const CountryContext = createContext(null)

export function CountryProvider({ children }) {
  const [country, setCountryState] = useState(
    () => localStorage.getItem('country') || 'Peru'
  )

  // dbConfigs: { countryKey → internalConfig }
  // Starts empty — constants.js is the immediate synchronous fallback.
  const [dbConfigs, setDbConfigs] = useState({})
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
    } catch (e) {
      console.warn('[CountryContext] Unexpected error:', e)
    } finally {
      fetchedRef.current = true
    }
  }, [])

  // Load on mount — no loading spinner: constants.js serves as instant fallback
  useEffect(() => { fetchAllConfigs() }, [fetchAllConfigs])

  const setCountry = useCallback((val) => {
    setCountryState(val)
    localStorage.setItem('country', val)
  }, [])

  // DB config takes precedence; constants.js as fallback
  const countryConfig = useMemo(
    () => dbConfigs[country] ?? getCountryConfig(country),
    [country, dbConfigs]
  )

  // Union: constants.js countries first, then DB-only keys appended
  const availableCountries = useMemo(() => {
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
      dbConfigs,
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
