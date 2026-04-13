import { createContext, useContext, useMemo } from 'react'
import { useFilters } from '../hooks/useFilters'

const FilterContext = createContext(null)

export function FilterProvider({ country = 'Peru', children }) {
  const filterState = useFilters(country)
  const value = useMemo(() => ({ ...filterState, country }), [filterState, country])
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
