import { useState, useEffect, useMemo } from 'react'
import { sb } from '../lib/supabase'
import { BRACKETS, BRACKET_LABELS, DEFAULT_WEIGHTS } from '../lib/constants'
import { computeWeightedAvg, buildWeightsMap } from '../algorithms/weightedAverage'
import { computeDelta, getSemaforoClass } from '../algorithms/semaforo'

/**
 * Extrae año e ISO week de una fecha JS
 */
function getYearWeek(date) {
  const d = new Date(date)
  const dayOfWeek = d.getDay() || 7
  d.setDate(d.getDate() + 4 - dayOfWeek)
  const year = d.getFullYear()
  const startOfYear = new Date(year, 0, 1)
  const week = Math.ceil(((d - startOfYear) / 86400000 + startOfYear.getDay() + 1) / 7)
  return { year, week }
}

export function usePricingData(filters, dbWeights) {
  const [rawRows,  setRawRows]  = useState([])
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState(null)

  const { city, category, zone, surge, viewMode, weekColumns, dailyStart, dailyEnd } = filters

  // ── Cargar datos desde Supabase ──────────────────────────
  useEffect(() => {
    if (!city || !category) return
    setLoading(true)
    setError(null)

    async function fetchData() {
      try {
        if (viewMode === 'weekly') {
          const firstWeek = weekColumns[0]
          const lastWeek  = weekColumns[weekColumns.length - 1]
          const { year: y1, week: w1 } = getYearWeek(firstWeek)
          const lastDate = new Date(lastWeek)
          lastDate.setDate(lastDate.getDate() + 6)
          const { year: y2, week: w2 } = getYearWeek(lastDate)

          const { data, error: err } = await sb.rpc('get_dashboard_data_weekly', {
            p_city:        city,
            p_category:    category,
            p_zone:        zone === 'All' ? null : zone,
            p_surge:       surge,
            p_week_start:  w1,
            p_year_start:  y1,
            p_week_end:    w2,
            p_year_end:    y2,
          })
          if (err) throw err
          setRawRows(data || [])
        } else {
          const { data, error: err } = await sb.rpc('get_dashboard_data_daily', {
            p_city:       city,
            p_category:   category,
            p_zone:       zone === 'All' ? null : zone,
            p_surge:      surge,
            p_date_start: dailyStart,
            p_date_end:   dailyEnd,
          })
          if (err) throw err
          setRawRows(data || [])
        }
      } catch (e) {
        setError(e.message || 'Error al cargar datos')
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [city, category, zone, surge, viewMode, weekColumns, dailyStart, dailyEnd])

  // ── Construir matriz de datos ───────────────────────────
  const { priceMatrix, deltaMatrix, semaforoMatrix, sampleMatrix, chartData, periods } =
    useMemo(() => {
      if (!rawRows.length) {
        return { priceMatrix: {}, deltaMatrix: {}, semaforoMatrix: {}, sampleMatrix: {}, chartData: {}, periods: [] }
      }

      const weights = buildWeightsMap(dbWeights || [], city) || DEFAULT_WEIGHTS

      // Determinar períodos (columnas)
      let periods = []
      if (filters.viewMode === 'weekly') {
        periods = filters.weekColumns.map(d => {
          const { year, week } = getYearWeek(d)
          return { key: `${year}-W${String(week).padStart(2,'0')}`, label: formatWeekLabel(d), year, week }
        })
      } else {
        const dates = [...new Set(rawRows.map(r => r.observed_date))].sort()
        periods = dates.map(d => ({
          key:   d,
          label: formatDayLabel(d),
          date:  d,
        }))
      }

      // Agrupar: competitor → period → bracket → { avgPrice, count }
      const nested = {}
      for (const row of rawRows) {
        const periodKey = filters.viewMode === 'weekly'
          ? `${row.year}-W${String(row.week).padStart(2,'0')}`
          : row.observed_date

        if (!nested[row.competition_name]) nested[row.competition_name] = {}
        if (!nested[row.competition_name][periodKey]) nested[row.competition_name][periodKey] = {}
        nested[row.competition_name][periodKey][row.distance_bracket] = {
          avgPrice: Number(row.avg_price),
          count:    Number(row.observation_count),
        }
      }

      const competitors = filters.competitors
      const priceMatrix    = {}
      const deltaMatrix    = {}
      const semaforoMatrix = {}
      const sampleMatrix   = {}
      const chartData      = {}

      // Inicializar chartData por bracket
      for (const b of BRACKETS) chartData[b] = []

      for (const period of periods) {
        const periodPrices = {}

        for (const comp of competitors) {
          const bracketData = nested[comp]?.[period.key] || {}
          const bracketPrices = {}
          const bracketCounts = {}

          for (const b of BRACKETS) {
            bracketPrices[b] = bracketData[b]?.avgPrice ?? null
            bracketCounts[b] = bracketData[b]?.count    ?? 0
          }

          const wa = computeWeightedAvg(bracketPrices, weights)

          if (!priceMatrix[comp])  priceMatrix[comp]  = {}
          if (!sampleMatrix[comp]) sampleMatrix[comp] = {}

          priceMatrix[comp][period.key]  = { ...bracketPrices, _wa: wa }
          sampleMatrix[comp][period.key] = { ...bracketCounts }
          periodPrices[comp] = wa
        }

        // Calcular delta vs compareVs
        const basePrice = periodPrices[filters.compareVs]
        for (const comp of competitors) {
          if (!deltaMatrix[comp])    deltaMatrix[comp]    = {}
          if (!semaforoMatrix[comp]) semaforoMatrix[comp] = {}

          const delta = comp === filters.compareVs
            ? 0
            : computeDelta(periodPrices[comp], basePrice)

          deltaMatrix[comp][period.key]    = delta
          semaforoMatrix[comp][period.key] = getSemaforoClass(delta)
        }

        // Datos para gráficos por bracket
        for (const b of BRACKETS) {
          const point = { period: period.label }
          for (const comp of competitors) {
            point[comp] = nested[comp]?.[period.key]?.[b]?.avgPrice ?? null
          }
          chartData[b].push(point)
        }
      }

      return { priceMatrix, deltaMatrix, semaforoMatrix, sampleMatrix, chartData, periods }
    }, [rawRows, dbWeights, filters])

  return { loading, error, priceMatrix, deltaMatrix, semaforoMatrix, sampleMatrix, chartData, periods }
}

// ── Helpers de formato ──────────────────────────────────
function formatWeekLabel(date) {
  const d = new Date(date)
  return d.toLocaleDateString('es-PE', { month: 'short', day: 'numeric' })
}

function formatDayLabel(dateStr) {
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString('es-PE', { weekday: 'short', day: 'numeric' })
}
