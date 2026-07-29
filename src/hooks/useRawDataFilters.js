import { useState, useEffect, useMemo, useCallback } from 'react'

// Extraído de RawData.jsx (Fase 1.2) — agrupa los filtros de la página, su
// persistencia a sessionStorage (uno por campo, sobrevive a un refresh) y
// los memos de categorías/competidores derivados de la ciudad activa. La
// page sigue siendo dueña de construir el objeto `filters` que consume
// useRawData/useRawDataExport (necesita `country`, que vive en CountryContext).
function getInitialState(key, defaultVal) {
  const saved = sessionStorage.getItem(`rawData_${key}`)
  return saved !== null ? saved : defaultVal
}

// Rango de fechas por defecto: 30 días atrás. `pricing_observations` está
// particionada por mes (mig 168-169) — sin un filtro de fecha, Postgres no
// puede podar particiones y termina abriendo las ~19 particiones existentes
// para armar la página (Merge Append), lo que ya se vio en producción como
// "exceeds time of execution" al entrar a RawData sin fecha. Visible y
// editable en el campo "Desde" (no es un recorte silencioso) — el hub ve
// exactamente qué rango se está pidiendo y lo puede ampliar.
function getDefaultDateFrom() {
  const d = new Date()
  d.setDate(d.getDate() - 30)
  return d.toISOString().slice(0, 10)
}

export function useRawDataFilters({ country, config }) {
  // Si dbCity inicial no está en config.dbCities, forzar a la primera ciudad de este país
  const defaultCity = getInitialState('dbCity', config.dbCities[0])
  const safeCity = config.dbCities.includes(defaultCity) ? defaultCity : config.dbCities[0]

  const [dbCity, setDbCity] = useState(safeCity)
  const [dbCategory, setDbCategory] = useState(getInitialState('dbCategory', ''))
  const [competition, setCompetition] = useState(getInitialState('competition', ''))
  const [surge, setSurge] = useState(getInitialState('surge', ''))
  const [bracket, setBracket] = useState(getInitialState('bracket', ''))
  const [dateFrom, setDateFrom] = useState(getInitialState('dateFrom', getDefaultDateFrom()))
  const [dateTo, setDateTo] = useState(getInitialState('dateTo', ''))
  const [searchA, setSearchA] = useState(getInitialState('searchA', ''))
  const [searchB, setSearchB] = useState(getInitialState('searchB', ''))
  // Debounced versions (300ms) — feed to useRawData so we don't refetch on
  // every keystroke. UI inputs bind to searchA/searchB for immediate feedback.
  const [debouncedSearchA, setDebouncedSearchA] = useState(searchA)
  const [debouncedSearchB, setDebouncedSearchB] = useState(searchB)
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearchA(searchA), 300)
    return () => clearTimeout(t)
  }, [searchA])
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearchB(searchB), 300)
    return () => clearTimeout(t)
  }, [searchB])
  const [dataSource, setDataSource] = useState(getInitialState('dataSource', ''))
  const [outlierOnly, setOutlierOnly] = useState(
    () => sessionStorage.getItem('rawData_outlierOnly') === 'true'
  )

  useEffect(() => {
    sessionStorage.setItem('rawData_dbCity', dbCity)
  }, [dbCity])
  useEffect(() => {
    sessionStorage.setItem('rawData_dbCategory', dbCategory)
  }, [dbCategory])
  useEffect(() => {
    sessionStorage.setItem('rawData_competition', competition)
  }, [competition])
  useEffect(() => {
    sessionStorage.setItem('rawData_surge', surge)
  }, [surge])
  useEffect(() => {
    sessionStorage.setItem('rawData_bracket', bracket)
  }, [bracket])
  useEffect(() => {
    sessionStorage.setItem('rawData_dateFrom', dateFrom)
  }, [dateFrom])
  useEffect(() => {
    sessionStorage.setItem('rawData_dateTo', dateTo)
  }, [dateTo])
  useEffect(() => {
    sessionStorage.setItem('rawData_searchA', searchA)
  }, [searchA])
  useEffect(() => {
    sessionStorage.setItem('rawData_searchB', searchB)
  }, [searchB])
  useEffect(() => {
    sessionStorage.setItem('rawData_dataSource', dataSource)
  }, [dataSource])
  useEffect(() => {
    sessionStorage.setItem('rawData_outlierOnly', outlierOnly)
  }, [outlierOnly])

  // Asegurar que state.dbCity cambia si cambia el país y no es válido
  useEffect(() => {
    if (!config.dbCities.includes(dbCity)) {
      setDbCity(config.dbCities[0])
    }
  }, [country, config.dbCities, dbCity])

  const categories = useMemo(() => {
    // Si la config del país tiene categoriesByCity, usar esa, sino fallback
    return config.categoriesByCity?.[dbCity] || []
  }, [config, dbCity])

  const competitors = useMemo(() => {
    const cityMap = config.competitorsByDbCityCategory?.[dbCity]
    if (!cityMap) return []
    if (dbCategory) return cityMap[dbCategory] || []
    // Sin categoría seleccionada: unión de todos los competidores de la ciudad
    const all = new Set()
    for (const list of Object.values(cityMap)) {
      for (const c of list) all.add(c)
    }
    return Array.from(all)
  }, [config, dbCity, dbCategory])

  const handleCityChange = useCallback((city) => {
    setDbCity(city)
    setDbCategory('')
    setCompetition('')
    setSurge('')
    setBracket('')
    setSearchA('')
    setSearchB('')
  }, [])

  const resetFilters = () => {
    setDbCategory('')
    setCompetition('')
    setSurge('')
    setBracket('')
    setDateFrom(getDefaultDateFrom())
    setDateTo('')
    setSearchA('')
    setSearchB('')
    setDataSource('')
    setOutlierOnly(false)
  }

  const filters = {
    dbCity,
    dbCategory,
    competition,
    surge,
    bracket,
    dateFrom,
    dateTo,
    searchA: debouncedSearchA,
    searchB: debouncedSearchB,
    dataSource,
    outlierOnly,
    country,
  }

  return {
    filters,
    dbCity,
    dbCategory,
    competition,
    surge,
    bracket,
    dateFrom,
    dateTo,
    searchA,
    searchB,
    dataSource,
    outlierOnly,
    setDbCategory,
    setCompetition,
    setSurge,
    setBracket,
    setDateFrom,
    setDateTo,
    setSearchA,
    setSearchB,
    setDataSource,
    setOutlierOnly,
    categories,
    competitors,
    handleCityChange,
    resetFilters,
  }
}
