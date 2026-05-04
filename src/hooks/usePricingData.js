import { useState, useEffect, useMemo, useCallback } from 'react'
import { sb } from '../lib/supabase'
import { BRACKETS, BRACKET_LABELS, DEFAULT_WEIGHTS } from '../lib/constants'
import { computeWeightedAvg, buildWeightsMap } from '../algorithms/weightedAverage'
import { computeDelta, getSemaforoClass } from '../algorithms/semaforo'

const ALL_TIME_SLOTS = ['early_morning', 'morning', 'midday', 'afternoon', 'evening']

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

export function usePricingData(filters, dbWeights, locale = 'es-PE') {
  const [rawRows,    setRawRows]    = useState([])
  const [frozenRows, setFrozenRows] = useState([])
  const [loading,    setLoading]    = useState(false)
  const [error,      setError]      = useState(null)

  const { country, dbCity, dbCategory, zone, surge, dataSource, viewMode, weekColumns, dailyStart, dailyEnd, timeOfDay } = filters

  // Null → no filter (todas las franjas, incluyendo registros sin time_of_day)
  const timeOfDayParam = useMemo(() => {
    if (!timeOfDay || timeOfDay.length === ALL_TIME_SLOTS.length) return null
    return timeOfDay
  }, [timeOfDay])

  // ── Cargar datos desde Supabase ──────────────────────────
  useEffect(() => {
    if (!dbCity || !dbCategory) return
    setLoading(true)
    setError(null)

    async function fetchData() {
      try {
        if (viewMode === 'weekly' || viewMode === 'historic') {
          const firstWeek = weekColumns[0]
          const lastWeek  = weekColumns[weekColumns.length - 1]
          const { year: y1, week: w1 } = getYearWeek(firstWeek)
          const lastDate = new Date(lastWeek)
          lastDate.setDate(lastDate.getDate() + 6)
          const { year: y2, week: w2 } = getYearWeek(lastDate)

          const [liveRes, frozenRes] = await Promise.all([
            sb.rpc('get_dashboard_data_weekly', {
              p_city:        dbCity,
              p_category:    dbCategory,
              p_country:     country,
              p_zone:        zone === 'All' ? null : zone,
              p_surge:       surge,
              p_week_start:  w1,
              p_year_start:  y1,
              p_week_end:    w2,
              p_year_end:    y2,
              p_data_source: dataSource,
              p_time_of_day: timeOfDayParam,
            }),
            sb.from('pricing_wa_frozen')
              .select('competition_name,distance_bracket,year,week,avg_price,observation_count')
              .eq('country', country)
              .eq('city', dbCity)
              .eq('category', dbCategory)
              .gte('year', y1)
              .lte('year', y2),
          ])
          if (liveRes.error) throw liveRes.error
          setRawRows(liveRes.data || [])
          setFrozenRows(frozenRes.data || [])
        } else {
          const { data, error: err } = await sb.rpc('get_dashboard_data_daily', {
            p_city:        dbCity,
            p_category:    dbCategory,
            p_country:     country,
            p_zone:        zone === 'All' ? null : zone,
            p_surge:       surge,
            p_date_start:  dailyStart,
            p_date_end:    dailyEnd,
            p_data_source: dataSource,
            p_time_of_day: timeOfDayParam,
          })
          if (err) throw err
          setRawRows(data || [])
          setFrozenRows([])
        }
      } catch (e) {
        setError(e.message || 'Error al cargar datos')
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [country, dbCity, dbCategory, zone, surge, dataSource, viewMode, weekColumns, dailyStart, dailyEnd, timeOfDayParam])

  // ── Construir set de semanas congeladas para indicador visual ──
  const frozenWeeks = useMemo(() => {
    const set = new Set()
    for (const r of frozenRows) {
      set.add(`${r.year}-W${String(r.week).padStart(2, '0')}`)
    }
    return set
  }, [frozenRows])

  // ── Índice de datos congelados: comp → periodKey → bracket → {avg_price, count} ──
  const frozenNested = useMemo(() => {
    const idx = {}
    for (const r of frozenRows) {
      const pk = `${r.year}-W${String(r.week).padStart(2, '0')}`
      if (!idx[r.competition_name]) idx[r.competition_name] = {}
      if (!idx[r.competition_name][pk]) idx[r.competition_name][pk] = {}
      idx[r.competition_name][pk][r.distance_bracket] = {
        avgPrice: Number(r.avg_price),
        count:    Number(r.observation_count),
      }
    }
    return idx
  }, [frozenRows])

  // ── Construir matriz de datos ───────────────────────────
  const { priceMatrix, deltaMatrix, semaforoMatrix, sampleMatrix, diffMatrix, chartData, deltaChartData, periods } =
    useMemo(() => {
      if (!rawRows.length && !frozenRows.length) {
        return { priceMatrix: {}, deltaMatrix: {}, semaforoMatrix: {}, sampleMatrix: {}, diffMatrix: {}, chartData: {}, deltaChartData: {}, periods: [] }
      }

      const weights = buildWeightsMap(dbWeights || [], filters.dbCity) || DEFAULT_WEIGHTS

      // Determinar períodos (columnas)
      let periods = []
      if (filters.viewMode === 'weekly' || filters.viewMode === 'historic') {
        periods = filters.weekColumns.map(d => {
          const { year, week } = getYearWeek(d)
          return { key: `${year}-W${String(week).padStart(2,'0')}`, label: formatWeekLabel(d, locale), year, week }
        })
      } else {
        const dates = [...new Set(rawRows.map(r => r.observed_date))].sort()
        periods = dates.map(d => ({
          key:   d,
          label: formatDayLabel(d, locale),
          date:  d,
        }))
      }

      // Agrupar: competitor → period → bracket → { avgPrice, count }
      // El RPC agrupa por surge (true/false/null son 3 grupos), por lo que puede
      // devolver múltiples filas por (comp, período, bracket). Combinamos con
      // promedio ponderado para que el filtro "Todos" incluya todas las surges.
      // Además normalizamos distance_bracket a snake_case lowercase como defensa
      // ante datos legados con formato inconsistente ('Short' vs 'short').
      const nested = {}
      const normalizeBracket = (b) => {
        if (b == null) return null
        return String(b).toLowerCase().replace(/\s+/g, '_')
      }
      for (const row of rawRows) {
        const periodKey = (filters.viewMode === 'weekly' || filters.viewMode === 'historic')
          ? `${row.year}-W${String(row.week).padStart(2,'0')}`
          : row.observed_date

        const bracketKey = normalizeBracket(row.distance_bracket)
        if (!bracketKey) continue

        if (!nested[row.competition_name]) nested[row.competition_name] = {}
        if (!nested[row.competition_name][periodKey]) nested[row.competition_name][periodKey] = {}

        const existing = nested[row.competition_name][periodKey][bracketKey]
        const newPrice = Number(row.avg_price)
        const newCount = Number(row.observation_count)

        if (!existing) {
          nested[row.competition_name][periodKey][bracketKey] = {
            avgPrice: newPrice,
            count:    newCount,
          }
        } else {
          const totalCount = existing.count + newCount
          const mergedAvg = totalCount > 0
            ? (existing.avgPrice * existing.count + newPrice * newCount) / totalCount
            : existing.avgPrice
          nested[row.competition_name][periodKey][bracketKey] = {
            avgPrice: mergedAvg,
            count:    totalCount,
          }
        }
      }

      const competitors = filters.competitors
      const priceMatrix    = {}
      const deltaMatrix    = {}
      const semaforoMatrix = {}
      const sampleMatrix   = {}
      const diffMatrix     = {}
      const chartData      = {}
      const deltaChartData = {}

      // Inicializar chartData por bracket + WA
      for (const b of [...BRACKETS, '_wa']) {
        chartData[b]      = []
        deltaChartData[b] = []
      }

      for (const period of periods) {
        // ── Paso 1: construir priceMatrix para todos los competidores ──
        for (const comp of competitors) {
          // Preferir datos congelados si existen para esta semana
          const isFrozen  = frozenNested[comp]?.[period.key] != null
          const bracketData = isFrozen
            ? frozenNested[comp][period.key]
            : (nested[comp]?.[period.key] || {})
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
        }

        // ── Paso 2: calcular delta/semaforo/diff vs compareVs ──
        const baseData = priceMatrix[filters.compareVs]?.[period.key] || {}
        const baseWA   = baseData._wa ?? null

        for (const comp of competitors) {
          if (!deltaMatrix[comp])    deltaMatrix[comp]    = {}
          if (!semaforoMatrix[comp]) semaforoMatrix[comp] = {}
          if (!diffMatrix[comp])     diffMatrix[comp]     = {}

          const isBase   = comp === filters.compareVs
          const compData = priceMatrix[comp][period.key]
          const compWA   = compData._wa ?? null

          const deltaWA = isBase ? 0 : computeDelta(compWA, baseWA)
          const diffWA  = isBase ? 0 : (compWA != null && baseWA != null ? compWA - baseWA : null)

          const bDelta    = {}
          const bSemaforo = {}
          const bDiff     = {}

          for (const b of BRACKETS) {
            const compP = compData[b]
            const baseP = baseData[b] ?? null
            const d     = isBase ? 0 : computeDelta(compP, baseP)
            bDelta[b]    = d
            bSemaforo[b] = getSemaforoClass(d)
            bDiff[b]     = isBase ? 0 : (compP != null && baseP != null ? compP - baseP : null)
          }

          deltaMatrix[comp][period.key]    = { _wa: deltaWA,            ...bDelta }
          semaforoMatrix[comp][period.key] = { _wa: getSemaforoClass(deltaWA), ...bSemaforo }
          diffMatrix[comp][period.key]     = { _wa: diffWA,             ...bDiff }
        }

        // ── Paso 3: chartData por bracket + WA ──
        for (const b of BRACKETS) {
          const pricePoint = { period: period.label }
          const deltaPoint = { period: period.label }
          for (const comp of competitors) {
            pricePoint[comp] = priceMatrix[comp][period.key][b] ?? null
            deltaPoint[comp] = deltaMatrix[comp][period.key][b] ?? null
          }
          chartData[b].push(pricePoint)
          deltaChartData[b].push(deltaPoint)
        }

        // WA chart
        const waPricePoint = { period: period.label }
        const waDeltaPoint = { period: period.label }
        for (const comp of competitors) {
          waPricePoint[comp] = priceMatrix[comp][period.key]._wa ?? null
          waDeltaPoint[comp] = deltaMatrix[comp][period.key]._wa ?? null
        }
        chartData['_wa'].push(waPricePoint)
        deltaChartData['_wa'].push(waDeltaPoint)
      }

      return { priceMatrix, deltaMatrix, semaforoMatrix, sampleMatrix, diffMatrix, chartData, deltaChartData, periods }
    }, [rawRows, frozenRows, dbWeights, filters, frozenNested, locale])

  return { loading, error, priceMatrix, deltaMatrix, semaforoMatrix, sampleMatrix, diffMatrix, chartData, deltaChartData, periods, frozenWeeks }
}

// ── Helpers de formato ──────────────────────────────────
function formatWeekLabel(date, locale = 'es-PE') {
  const d = new Date(date)
  return d.toLocaleDateString(locale, { month: 'short', day: 'numeric' })
}

function formatDayLabel(dateStr, locale = 'es-PE') {
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString(locale, { weekday: 'short', day: 'numeric' })
}
