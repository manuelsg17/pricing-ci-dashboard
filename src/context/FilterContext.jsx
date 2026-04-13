import { useCountry } from './CountryContext'

const FilterContext = createContext(null)

export function FilterProvider({ children }) {
  const { country } = useCountry()
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
