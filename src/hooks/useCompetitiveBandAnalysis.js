import { useState, useEffect, useCallback } from 'react'
import { sb } from '../lib/supabase'

// Llama get_competitive_band_summary / _breakdown (mig 124/125). min_pct/
// max_pct se pasan como parámetro (no se leen de competitive_bands en la
// RPC) — esto es lo que permite "previsualizar" una banda antes de guardarla.
//
// includeBreakdown=false salta get_competitive_band_breakdown (GROUP BY
// city+bracket con percentile_cont por grupo — la más cara de las dos) para
// consumers que solo necesitan el resumen, como el preview en vivo de
// CompetitiveBandsConfig.
export function useCompetitiveBandAnalysis({
  country,
  competitorName,
  category,
  minPct,
  maxPct,
  yearStart,
  weekStart,
  yearEnd,
  weekEnd,
  includeBreakdown = true,
}) {
  const [summary, setSummary] = useState(null)
  const [breakdown, setBreakdown] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [reloadTick, setReloadTick] = useState(0)

  // minPct<=maxPct (no solo Number.isFinite): evita mandar la RPC con un
  // rango invertido mientras el usuario tipea dos campos independientes
  // (la RPC lo rechaza con excepción desde mig 125, pero mejor no llamarla
  // con un estado transitorio inválido en primer lugar).
  const ready =
    !!country &&
    !!competitorName &&
    !!category &&
    Number.isFinite(minPct) &&
    Number.isFinite(maxPct) &&
    minPct <= maxPct

  // Cancel flag (mismo patrón que usePricingData.js): si el usuario cambia
  // de banda/rango rápido, una respuesta vieja no debe pisar una más nueva.
  // `cancelled` vive en el scope del efecto (no dentro de la función async)
  // para que el cleanup de React lo marque en el momento correcto.
  useEffect(() => {
    if (!ready) {
      setSummary(null)
      setBreakdown([])
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)

    async function fetchData() {
      const rpcArgs = {
        p_country: country,
        p_competitor_name: competitorName,
        p_category: category,
        p_min_pct: minPct,
        p_max_pct: maxPct,
        p_year_start: yearStart ?? null,
        p_week_start: weekStart ?? null,
        p_year_end: yearEnd ?? null,
        p_week_end: weekEnd ?? null,
      }
      try {
        const [summaryRes, breakdownRes] = await Promise.all([
          sb.rpc('get_competitive_band_summary', rpcArgs),
          includeBreakdown
            ? sb.rpc('get_competitive_band_breakdown', rpcArgs)
            : Promise.resolve({ data: [], error: null }),
        ])
        if (cancelled) return
        if (summaryRes.error) throw summaryRes.error
        if (breakdownRes.error) throw breakdownRes.error
        setSummary(summaryRes.data?.[0] || null)
        setBreakdown(breakdownRes.data || [])
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
  }, [
    ready,
    country,
    competitorName,
    category,
    minPct,
    maxPct,
    yearStart,
    weekStart,
    yearEnd,
    weekEnd,
    includeBreakdown,
    reloadTick,
  ])

  const reload = useCallback(() => setReloadTick((t) => t + 1), [])

  // Drill-down: detalle de una celda puntual (ciudad + bracket), reusa la
  // misma RPC de summary con el scope acotado. Acción puntual del usuario
  // (click) — no necesita el cancel-guard del efecto de arriba.
  const drillInto = useCallback(
    async (city, distanceBracket) => {
      if (!ready) return null
      const { data, error: e } = await sb.rpc('get_competitive_band_summary', {
        p_country: country,
        p_competitor_name: competitorName,
        p_category: category,
        p_min_pct: minPct,
        p_max_pct: maxPct,
        p_year_start: yearStart ?? null,
        p_week_start: weekStart ?? null,
        p_year_end: yearEnd ?? null,
        p_week_end: weekEnd ?? null,
        p_city: city,
        p_distance_bracket: distanceBracket,
      })
      if (e) return null
      return data?.[0] || null
    },
    [
      ready,
      country,
      competitorName,
      category,
      minPct,
      maxPct,
      yearStart,
      weekStart,
      yearEnd,
      weekEnd,
    ]
  )

  return { summary, breakdown, loading, error, reload, drillInto }
}
