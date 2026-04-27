import { useState, useEffect, useMemo } from 'react'
import {
  getCountryConfig,
  resolveDbParams,
  getCompetitors,
} from '../lib/constants'
import { sb } from '../lib/supabase'
import { getMondayWeeksAgo, toISODate } from '../lib/dateUtils'

export function useFilters(country) {
  const countryConfig = useMemo(() => getCountryConfig(country), [country])
  const CITIES              = countryConfig.cities
  const CATEGORIES_BY_CITY  = countryConfig.categoriesByCity
  const AEROPUERTO_BY_CITY  = countryConfig.aeropuertoSubcategoriesByCity || {}
  const aeropuertoSubs = (c) => AEROPUERTO_BY_CITY[c] || countryConfig.aeropuertoSubcategories || []

  const [city,        setCity]        = useState(CITIES[0])
  const [category,    setCategory]    = useState(CATEGORIES_BY_CITY[CITIES[0]]?.[0] || '')
  const [subCategory, setSubCategory] = useState(null)  // solo para Aeropuerto
  const [zone,        setZone]        = useState('All')
  const [surge,       setSurge]       = useState(null)   // null=ambos, true/false
  const [dataSource,  setDataSource]  = useState(null)   // null=ambas, 'bot' | 'manual'
  const [compareVs,   setCompareVs]   = useState('Yango')
  const [viewMode,      setViewMode]      = useState('weekly') // 'weekly' | 'daily' | 'historic'
  const [weekStart,     setWeekStart]     = useState(toISODate(getMondayWeeksAgo(8)))
  const [dailyStart,    setDailyStart]    = useState(toISODate(new Date(Date.now() - 6 * 86400000))) // show last 7 days initially
  
  const dailyEnd = useMemo(() => {
    const d = new Date(dailyStart + 'T00:00:00')
    d.setDate(d.getDate() + 6)
    return toISODate(d)
  }, [dailyStart])

  const [historicFrom,  setHistoricFrom]  = useState(toISODate(getMondayWeeksAgo(24)))
  const [historicTo,    setHistoricTo]    = useState(toISODate(getMondayWeeksAgo(0)))
  const [zones,         setZones]         = useState(['All'])

  // Ajustar weekStart dinámicamente al lunes de la semana MÁS RECIENTE con datos.
  // (Incluye la semana en curso si hay observaciones, aunque esté incompleta.)
  useEffect(() => {
    sb.from('pricing_observations')
      .select('observed_date')
      .eq('country', country)
      .order('observed_date', { ascending: false })
      .limit(1)
      .then(({ data }) => {
        if (!data?.length) return
        const latest = new Date(data[0].observed_date + 'T00:00:00')
        // Retroceder al lunes de esa semana
        const dayOfWeek = latest.getDay()
        const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek
        const latestMonday = new Date(latest)
        latestMonday.setDate(latest.getDate() + diffToMonday)
        // Mostrar 8 semanas con latestMonday como la última columna
        const startMonday = new Date(latestMonday)
        startMonday.setDate(latestMonday.getDate() - 7 * 7)
        setWeekStart(toISODate(startMonday))
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [country])

  // Cascada: cuando cambia país, resetear ciudad y categoría
  useEffect(() => {
    const firstCity = CITIES[0]
    setCity(firstCity)
    const cats = CATEGORIES_BY_CITY[firstCity] || []
    setCategory(cats[0] || '')
    setSubCategory(null)
    setZone('All')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [country])

  // Cascada: cuando cambia ciudad, resetear categoría (NO fechas)
  useEffect(() => {
    const cats = CATEGORIES_BY_CITY[city] || []
    setCategory(cats[0] || '')
    setSubCategory(null)
    setZone('All')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [city])

  // Cascada: cuando cambia categoría, resetear zona, compareVs y subCategory
  useEffect(() => {
    setZone('All')
    const subs = aeropuertoSubs(city)
    if (category === 'Aeropuerto') {
      setSubCategory(prev => (prev && subs.includes(prev)) ? prev : subs[0])
    } else {
      setSubCategory(null)
    }
    const comps = getCompetitors(city, category, category === 'Aeropuerto' ? subs[0] : null, country)
    setCompareVs(comps[0] || 'Yango')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [city, category, country])

  // Cuando cambia subCategory (Aeropuerto), actualizar compareVs
  useEffect(() => {
    if (category === 'Aeropuerto' && subCategory) {
      const comps = getCompetitors(city, category, subCategory, country)
      setCompareVs(comps[0] || 'Yango')
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [city, category, subCategory, country])

  // Resolver parámetros de DB
  const { dbCity, dbCategory } = useMemo(
    () => resolveDbParams(city, category, subCategory, country),
    [city, category, subCategory, country]
  )

  // Cargar zonas disponibles para city+category (usando DB params)
  useEffect(() => {
    if (!dbCity || !dbCategory) return
    let cancelled = false
    sb.rpc('get_available_zones', { p_city: dbCity, p_category: dbCategory, p_country: country })
      .then(({ data }) => {
        if (cancelled) return
        const list = ['All', ...(data || []).map(r => r.zone).filter(z => z && z !== 'All')]
        setZones(list)
      })
    return () => { cancelled = true }
  }, [country, dbCity, dbCategory])

  // Calcular rango de semanas según el modo
  const weekColumns = useMemo(() => {
    if (viewMode === 'historic') {
      // All mondays from historicFrom to historicTo
      const from  = new Date(historicFrom + 'T00:00:00')
      const to    = new Date(historicTo   + 'T00:00:00')
      const cols  = []
      const d     = new Date(from)
      while (d <= to && cols.length < 52) {
        cols.push(new Date(d))
        d.setDate(d.getDate() + 7)
      }
      return cols.length ? cols : [from]
    }
    const base = new Date(weekStart + 'T00:00:00')
    return Array.from({ length: 8 }, (_, i) => {
      const d = new Date(base)
      d.setDate(d.getDate() + i * 7)
      return d
    })
  }, [viewMode, weekStart, historicFrom, historicTo])

  const competitors = useMemo(
    () => getCompetitors(city, category, subCategory, country),
    [city, category, subCategory, country]
  )

  const filters = useMemo(() => ({
    country,
    city,
    category,
    subCategory,
    dbCity,
    dbCategory,
    zone,
    surge,
    dataSource,
    compareVs,
    viewMode,
    weekStart,
    weekColumns,
    dailyStart,
    dailyEnd,
    historicFrom,
    historicTo,
    competitors,
  }), [country, city, category, subCategory, dbCity, dbCategory, zone, surge, dataSource, compareVs, viewMode, weekStart, weekColumns, dailyStart, dailyEnd, historicFrom, historicTo, competitors])

  return {
    filters,
    zones,
    competitors,
    setCity,
    setCategory,
    setSubCategory,
    setZone,
    setSurge,
    setDataSource,
    setCompareVs,
    setViewMode,
    setWeekStart,
    setDailyStart,
    setHistoricFrom,
    setHistoricTo,
  }
}
