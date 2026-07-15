import { useState, useEffect, useCallback } from 'react'
import { sb } from '../lib/supabase'

// Llama get_price_volatility_by_category (mig 126) — percentiles de precio
// REAL (no Δ%) por competidor, incluyendo Yango, para una categoría. Mismo
// esqueleto que useCompetitiveBandAnalysis.js (cancel-flag pattern).
export function usePriceVolatility({
  country,
  category,
  yearStart,
  weekStart,
  yearEnd,
  weekEnd,
  city,
}) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [reloadTick, setReloadTick] = useState(0)

  const ready = !!country && !!category

  useEffect(() => {
    if (!ready) {
      setRows([])
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)

    async function fetchData() {
      try {
        const { data, error: e } = await sb.rpc('get_price_volatility_by_category', {
          p_country: country,
          p_category: category,
          p_year_start: yearStart ?? null,
          p_week_start: weekStart ?? null,
          p_year_end: yearEnd ?? null,
          p_week_end: weekEnd ?? null,
          p_city: city ?? null,
        })
        if (cancelled) return
        if (e) throw e
        setRows(data || [])
      } catch (e) {
        if (!cancelled) setError(e.message || 'Error al calcular')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchData()
    return () => {
      cancelled = true
    }
  }, [ready, country, category, yearStart, weekStart, yearEnd, weekEnd, city, reloadTick])

  const reload = useCallback(() => setReloadTick((t) => t + 1), [])

  return { rows, loading, error, reload }
}
