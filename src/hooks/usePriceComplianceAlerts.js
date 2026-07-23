import { useState, useEffect, useCallback } from 'react'
import { sb } from '../lib/supabase'
import { getISOYearWeek } from '../lib/dateUtils'

// Alertas de precio (pedido 11): se apoya en la infraestructura YA existente
// de bandas de competitividad (mig 124-127, Config → Competitividad) en vez
// de inventar un sistema nuevo — solo agrega la vista "¿algún par configurado
// está mal esta semana?" para Monitoreo. Reusa el mismo umbral de 3 niveles
// que ya usa Competitividad.jsx (≥60 bueno / ≥30 mixto / <30 malo).
export function usePriceComplianceAlerts(country) {
  const [alerts, setAlerts] = useState([])
  const [loading, setLoading] = useState(false)
  // Bug real (revisión adversarial 2026-07-23): antes, un error de red/RPC
  // en cualquiera de estas consultas se trataba IGUAL que "sin observaciones
  // esta semana" — la alerta simplemente no aparecía, indistinguible de
  // "todo cumple la banda". `failed` deja que el panel avise que no se pudo
  // calcular, en vez de mostrar silencio como si estuviera todo bien.
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    if (!country) return
    setLoading(true)
    setFailed(false)
    const { year, week } = getISOYearWeek(new Date())
    const { data: bands, error: bandsErr } = await sb
      .from('competitive_bands')
      .select('competitor_name, category, min_pct, max_pct')
      .eq('country', country)
      .eq('is_active', true)
    if (bandsErr) {
      console.error('[usePriceComplianceAlerts] competitive_bands error:', bandsErr)
      setFailed(true)
      setAlerts([])
      setLoading(false)
      return
    }
    if (!bands || !bands.length) {
      setAlerts([])
      setLoading(false)
      return
    }
    let anyErrored = false
    const results = await Promise.all(
      bands.map(async (b) => {
        const { data: rows, error } = await sb.rpc('get_competitive_band_breakdown', {
          p_country: country,
          p_competitor_name: b.competitor_name,
          p_category: b.category,
          p_min_pct: b.min_pct,
          p_max_pct: b.max_pct,
          p_year_start: year,
          p_week_start: week,
          p_year_end: year,
          p_week_end: week,
        })
        if (error) {
          console.error('[usePriceComplianceAlerts] get_competitive_band_breakdown error:', error)
          anyErrored = true
          return null
        }
        if (!rows?.length) return null
        const totalObs = rows.reduce((s, r) => s + (Number(r.total_observations) || 0), 0)
        const totalWithin = rows.reduce((s, r) => s + (Number(r.within_count) || 0), 0)
        if (totalObs === 0) return null
        const withinPct = (100 * totalWithin) / totalObs
        return {
          competitor: b.competitor_name,
          category: b.category,
          withinPct: Math.round(withinPct * 10) / 10,
          totalObs,
        }
      })
    )
    setFailed(anyErrored)
    setAlerts(results.filter((r) => r && r.withinPct < 30))
    setLoading(false)
  }, [country])

  useEffect(() => {
    load()
  }, [load])

  return { alerts, loading, failed }
}
