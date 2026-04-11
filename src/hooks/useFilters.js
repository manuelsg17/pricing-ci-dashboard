import { useState, useEffect, useMemo } from 'react'
import {
  getCountryConfig,
  resolveDbParams,
  getCompetitors,
} from '../lib/constants'
import { sb } from '../lib/supabase'

// Devuelve el lunes de la semana N semanas atrás
function getMondayWeeksAgo(n) {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  // Retroceder al lunes de la semana actual
  const day = d.getDay() || 7           // dom=0 → 7
  d.setDate(d.getDate() - (day - 1))    // lunes de esta semana
  d.setDate(d.getDate() - n * 7)        // N semanas atrás
  return d
}

function toISODate(d) {
  return d.toISOString().slice(0, 10)
}

export function useFilters(country = 'Peru') {
  const countryConfig = useMemo(() => getCountryConfig(country), [country])
  const CITIES              = countryConfig.cities
  const CATEGORIES_BY_CITY  = countryConfig.categoriesByCity
  const AEROPUERTO_SUBCATEGORIES = countryConfig.aeropuertoSubcategories || []

  const [city,        setCity]        = useState(CITIES[0])
  const [category,    setCategory]    = useState(CATEGORIES_BY_CITY[CITIES[0]]?.[0] || '')
  const [subCategory, setSubCategory] = useState(null)  // solo para Aeropuerto
  const [zone,        setZone]        = useState('All')
  const [surge,       setSurge]       = useState(null)   // null=ambos, true/false
  const [compareVs,   setCompareVs]   = useState('Yango')
  const [viewMode,      setViewMode]      = useState('weekly') // 'weekly' | 'daily' | 'historic'
  const [weekStart,     setWeekStart]     = useState(toISODate(getMondayWeeksAgo(7)))
  const [dailyStart,    setDailyStart]    = useState(toISODate(new Date(Date.now() - 6 * 86400000))) // show last 7 days initially
  
  const dailyEnd = useMemo(() => {
    const d = new Date(dailyStart + 'T00:00:00')
    d.setDate(d.getDate() + 6)
    return toISODate(d)
  }, [dailyStart])

  const [historicFrom,  setHistoricFrom]  = useState(toISODate(getMondayWeeksAgo(24)))
  const [historicTo,    setHistoricTo]    = useState(toISODate(getMondayWeeksAgo(0)))
  const [zones,         setZones]         = useState(['All'])

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
    if (category === 'Aeropuerto') {
      setSubCategory(prev => prev || AEROPUERTO_SUBCATEGORIES[0])
    } else {
      setSubCategory(null)
    }
    const comps = getCompetitors(city, category, category === 'Aeropuerto' ? AEROPUERTO_SUBCATEGORIES[0] : null, country)
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
    sb.rpc('get_available_zones', { p_city: dbCity, p_category: dbCategory })
      .then(({ data }) => {
        const list = ['All', ...(data || []).map(r => r.zone).filter(z => z && z !== 'All')]
        setZones(list)
      })
  }, [dbCity, dbCategory])

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
    city,
    category,
    subCategory,
    dbCity,
    dbCategory,
    zone,
    surge,
    compareVs,
    viewMode,
    weekStart,
    weekColumns,
    dailyStart,
    dailyEnd,
    historicFrom,
    historicTo,
    competitors,
  }), [city, category, subCategory, dbCity, dbCategory, zone, surge, compareVs, viewMode, weekStart, weekColumns, dailyStart, dailyEnd, historicFrom, historicTo, competitors])

  return {
    filters,
    zones,
    competitors,
    setCity,
    setCategory,
    setSubCategory,
    setZone,
    setSurge,
    setCompareVs,
    setViewMode,
    setWeekStart,
    setDailyStart,
    setHistoricFrom,
    setHistoricTo,
  }
}
