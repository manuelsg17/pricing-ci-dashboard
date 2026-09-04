import { useState, useEffect } from 'react'
import { sb } from '../lib/supabase'

// RPCs agregadas de la pantalla Mercado (patrón único de datos, 2026-09):
// get_discount_stats, get_rush_valley_stats y get_heatmap_dow_tod. Cada hook
// conserva EXACTAMENTE la consulta, el rango de fechas, las dependencias del
// efecto y el manejo de errores que tenía su componente; el componente sigue
// haciendo el post-proceso (normalización de competidor, orden) como antes.

// Mismo helper local que tenían los tres componentes: fecha LOCAL sin
// desfase UTC (no usar toISOString).
function toISO(d) {
  const dt = new Date(d)
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
}
function addDays(d, n) {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}

// Rango de las 8 semanas del filtro (o últimos 56 días si no hay columnas).
function rangeFromWeekColumns(weekColumns) {
  const startDate = weekColumns?.[0]
    ? toISO(weekColumns[0])
    : toISO(new Date(Date.now() - 56 * 86400_000))
  const endDate = weekColumns?.length
    ? toISO(addDays(weekColumns[weekColumns.length - 1], 6))
    : toISO(new Date())
  return { startDate, endDate }
}

function useAggregatedRpc(rpcName, filters, { startDate, endDate }, deps, errorLabel) {
  const [rawRows, setRawRows] = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!filters.dbCity || !filters.dbCategory) return
    let cancelled = false
    setLoading(true)

    sb.rpc(rpcName, {
      p_country: filters.country,
      p_city: filters.dbCity,
      p_category: filters.dbCategory,
      p_start_date: startDate,
      p_end_date: endDate,
    }).then(({ data, error }) => {
      if (cancelled) return
      if (error) console.error(errorLabel, error)
      setRawRows(data || [])
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
    // Las dependencias las fija cada consumidor (ver abajo): son las mismas
    // que tenía el efecto original de cada componente.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return { rawRows, loading }
}

// DiscountIntensity: { competition_name, list_avg, final_avg, with_discount, n_total }
export function useDiscountStats(filters) {
  const range = rangeFromWeekColumns(filters.weekColumns)
  return useAggregatedRpc(
    'get_discount_stats',
    filters,
    range,
    [filters.country, filters.dbCity, filters.dbCategory, filters.weekColumns],
    'DiscountIntensity RPC error:'
  )
}

// RushVsValley: { competition_name, rush_avg, rush_n, valley_avg, valley_n }
export function useRushValleyStats(filters) {
  const range = rangeFromWeekColumns(filters.weekColumns)
  return useAggregatedRpc(
    'get_rush_valley_stats',
    filters,
    range,
    [filters.country, filters.dbCity, filters.dbCategory, filters.weekColumns],
    'RushVsValley RPC error:'
  )
}

// HeatmapDayHour: { competition_name, dow, time_of_day, avg_price, n }.
// El rango (solo la última semana del filtro) lo calcula el componente y las
// dependencias son las cadenas de fecha, igual que antes.
export function useHeatmapDowTod(filters, startDate, endDate) {
  return useAggregatedRpc(
    'get_heatmap_dow_tod',
    filters,
    { startDate, endDate },
    [filters.country, filters.dbCity, filters.dbCategory, startDate, endDate],
    'Heatmap RPC error:'
  )
}
