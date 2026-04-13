import { createContext, useContext, useState, useMemo, useEffect } from 'react'
import { getCountryConfig, COUNTRIES } from '../lib/constants'

const CountryContext = createContext(null)

export function CountryProvider({ children }) {
  const [country, setCountryState] = useState(
    () => localStorage.getItem('country') || 'Peru'
  )

  const setCountry = (val) => {
    setCountryState(val)
    localStorage.setItem('country', val)
  }

  const countryConfig = useMemo(() => getCountryConfig(country), [country])

  return (
    <CountryContext.Provider value={{ 
      country, 
      setCountry, 
      countryConfig, 
      availableCountries: COUNTRIES 
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
