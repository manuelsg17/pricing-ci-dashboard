import { useState, useCallback, useEffect } from 'react'
import { sb } from '../lib/supabase'
import { DEFAULT_WEIGHTS, LEGACY_WEIGHTS_PE } from '../lib/constants'
import { normalizeCompetitorName } from '../lib/normalize'
import { computePeriodAvg, buildWeightsMap } from '../algorithms/weightedAverage'

// Extraído de Rentabilidad.jsx (Fase 1.2) — carga de precios de TODAS las
// categorías de la ciudad en un solo batch de RPCs, agregados con el mismo
// weighted-average que usa el dashboard.
export function useRentabilidadPrices({
  dbCity,
  dbCategories,
  country,
  refYear,
  refWeek,
  dbWeights,
}) {
  // dbCategory -> { comp -> { avg, count } }
  const [pricesByCat, setPricesByCat] = useState({})
  const [loading, setLoading] = useState(false)

  const loadPrices = useCallback(async () => {
    if (!dbCity || !dbCategories.length) {
      setPricesByCat({})
      return
    }
    setLoading(true)
    // Mismo origen que el "Promedio Ponderado" del dashboard: el RPC _fast lee
    // la MV (bot + manual, precio efectivo) y devuelve el promedio por bracket.
    // Acá colapsamos surge por observación y aplicamos el WA con los mismos
    // pesos (buildWeightsMap) → el número coincide con el WA del dashboard, y
    // aparecen todos los competidores con data (Cabify, Didi, etc.).
    const perCat = await Promise.all(
      dbCategories.map((cat) =>
        sb
          .rpc('get_dashboard_data_weekly_fast', {
            p_city: dbCity,
            p_category: cat,
            p_country: country,
            p_week_start: refWeek,
            p_year_start: refYear,
            p_week_end: refWeek,
            p_year_end: refYear,
          })
          .then(({ data }) => ({ cat, rows: data || [] }))
      )
    )

    const result = {}
    for (const { cat, rows } of perCat) {
      // (comp, bracket) → promedio ponderado por observation_count (colapsa surge)
      const byComp = {}
      for (const r of rows) {
        const comp =
          normalizeCompetitorName(r.competition_name, { city: dbCity }) || r.competition_name
        if (!byComp[comp]) byComp[comp] = {}
        const b = byComp[comp][r.distance_bracket] || { sum: 0, w: 0 }
        b.sum += Number(r.avg_price) * Number(r.observation_count)
        b.w += Number(r.observation_count)
        byComp[comp][r.distance_bracket] = b
      }
      // Mismos pesos que el dashboard (ver usePricingData): Perú usa los pesos
      // históricos reales fijados en código; otros países, la BD. Desde 2026-W25
      // el WA es promedio simple (computePeriodAvg lo decide por refYear/refWeek).
      // `|| DEFAULT_WEIGHTS` era código muerto: buildWeightsMap devuelve `{}`
      // cuando el filtro por país no deja ninguna fila, y `{}` es TRUTHY. La red
      // de seguridad nunca se ejecutaba y el WA histórico del país entero quedaba
      // en null. Hay que preguntar por el contenido, no por la existencia.
      const propios =
        country === 'Peru'
          ? buildWeightsMap(LEGACY_WEIGHTS_PE, dbCity, cat)
          : buildWeightsMap(dbWeights || [], dbCity, cat, country)
      const weights = propios && Object.keys(propios).length > 0 ? propios : DEFAULT_WEIGHTS
      result[cat] = {}
      for (const [comp, brackets] of Object.entries(byComp)) {
        const bracketPrices = {}
        let count = 0
        for (const [bk, { sum, w }] of Object.entries(brackets)) {
          if (w > 0) bracketPrices[bk] = sum / w
          count += w
        }
        const wa = computePeriodAvg(bracketPrices, weights, refYear, refWeek)
        if (wa != null) result[cat][comp] = { avg: wa, count }
      }
    }
    setPricesByCat(result)
    setLoading(false)
  }, [country, dbCity, dbCategories, refYear, refWeek, dbWeights])

  useEffect(() => {
    loadPrices()
  }, [loadPrices])

  return { pricesByCat, loading }
}
