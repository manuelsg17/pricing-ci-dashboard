import { useState, useEffect, useMemo } from 'react'
import {
  CITIES,
  CATEGORIES_BY_CITY,
  COMPETITORS_BY_CITY_CATEGORY,
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

export function useFilters() {
  const [city,       setCity]       = useState(CITIES[0])
  const [category,   setCategory]   = useState(CATEGORIES_BY_CITY[CITIES[0]][0])
  const [zone,       setZone]       = useState('All')
  const [surge,      setSurge]      = useState(null)   // null=ambos, true/false
  const [compareVs,  setCompareVs]  = useState('Yango')
  const [viewMode,   setViewMode]   = useState('weekly') // 'weekly' | 'daily'
  const [weekStart,  setWeekStart]  = useState(toISODate(getMondayWeeksAgo(70)))
  const [dailyStart, setDailyStart] = useState(toISODate(getMondayWeeksAgo(1)))
  const [dailyEnd,   setDailyEnd]   = useState(toISODate(new Date()))
  const [zones,      setZones]      = useState(['All'])

  // Cascada: cuando cambia ciudad, resetear categoría
  useEffect(() => {
    const cats = CATEGORIES_BY_CITY[city] || []
    setCategory(cats[0] || '')
    setZone('All')
  }, [city])

  // Cascada: cuando cambia categoría, resetear zona y compareVs
  useEffect(() => {
    setZone('All')
    const comps = COMPETITORS_BY_CITY_CATEGORY[city]?.[category] || []
    setCompareVs(comps[0] || 'Yango')
  }, [city, category])

  // Cargar zonas disponibles para city+category
  useEffect(() => {
    if (!city || !category) return
    sb.rpc('get_available_zones', { p_city: city, p_category: category })
      .then(({ data }) => {
        const list = ['All', ...(data || []).map(r => r.zone).filter(z => z && z !== 'All')]
        setZones(list)
      })
  }, [city, category])

  // Calcular rango de semanas (8 semanas desde weekStart)
  const weekColumns = useMemo(() => {
    const base = new Date(weekStart + 'T00:00:00')
    return Array.from({ length: 8 }, (_, i) => {
      const d = new Date(base)
      d.setDate(d.getDate() + i * 7)
      return d
    })
  }, [weekStart])

  const competitors = useMemo(
    () => COMPETITORS_BY_CITY_CATEGORY[city]?.[category] || [],
    [city, category]
  )

  const filters = useMemo(() => ({
    city,
    category,
    zone,
    surge,
    compareVs,
    viewMode,
    weekStart,
    weekColumns,
    dailyStart,
    dailyEnd,
    competitors,
  }), [city, category, zone, surge, compareVs, viewMode, weekStart, weekColumns, dailyStart, dailyEnd, competitors])

  return {
    filters,
    zones,
    competitors,
    setCity,
    setCategory,
    setZone,
    setSurge,
    setCompareVs,
    setViewMode,
    setWeekStart,
    setDailyStart,
    setDailyEnd,
  }
}
