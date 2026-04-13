import { createContext, useContext } from 'react'
import { useFilters } from '../hooks/useFilters'

const FilterContext = createContext(null)

export function FilterProvider({ country, children }) {
  const filterState = useFilters(country)
  return (
    <FilterContext.Provider value={filterState}>
      {children}
    </FilterContext.Provider>
  )
}

export function useFilterContext() {
  const ctx = useContext(FilterContext)
  if (!ctx) throw new Error('useFilterContext must be used inside FilterProvider')
  return ctx
}
