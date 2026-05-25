import { createContext, useContext, useMemo } from 'react'
import { useCountry } from './CountryContext'
import { useFilters } from '../hooks/useFilters'
const FilterContext = createContext(null)

export function FilterProvider({ children }) {
  const { country } = useCountry()
  const filterState = useFilters(country)
  // Memo basado en el `filters` interno (ya estabilizado por useMemo en
  // useFilters) y en `zones`/`timeOfDay` que también pueden cambiar de
  // contenido. Los setters son estables (vienen de useState), por lo que no
  // los listamos como deps. Sin esto, el value se reconstruía cada render
  // (filterState es un objeto fresh) y todos los consumers de context se
  // re-renderizaban innecesariamente.
  const value = useMemo(
    () => ({ ...filterState, country, applyPreset: filterState.applyPreset }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filterState.filters, filterState.zones, filterState.timeOfDay, country]
  )
  return (
    <FilterContext.Provider value={value}>
      {children}
    </FilterContext.Provider>
  )
}

export function useFilterContext() {
  const ctx = useContext(FilterContext)
  if (!ctx) throw new Error('useFilterContext must be used inside FilterProvider')
  return ctx
}
