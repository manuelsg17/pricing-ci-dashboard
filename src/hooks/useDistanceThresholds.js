import { useState, useEffect } from 'react'
import { sb } from '../lib/supabase'

// Umbrales de bracket (distance_thresholds) del (country, city, category)
// actual. Solo consulta cuando `enabled` es true — DashboardLegend lo abre al
// mostrar el modal, para no pegarle a Supabase hasta que se necesite. Misma
// consulta que tenía el componente (patrón único de datos, 2026-09).
export function useDistanceThresholds({ enabled, country, dbCity, dbCategory }) {
  const [thresholds, setThresholds] = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!enabled || !dbCity || !dbCategory) return
    let cancelled = false
    setLoading(true)
    sb.from('distance_thresholds')
      .select('bracket, max_km')
      .eq('country', country)
      .eq('city', dbCity)
      .eq('category', dbCategory)
      .then(({ data }) => {
        if (cancelled) return
        setThresholds(data || [])
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [enabled, country, dbCity, dbCategory])

  return { thresholds, loading }
}
