import { sb } from '../lib/supabase'
import { useStaleWhileRevalidate } from './useStaleWhileRevalidate'

/**
 * Lee price_validation_rules para un país y devuelve un checker de outliers.
 * Cache local + live-sync vía useStaleWhileRevalidate.
 */
export function usePriceRules(country = 'Peru') {
  const { data: rules = [], loading, error } = useStaleWhileRevalidate({
    key: `cfg.price_validation_rules.${country}`,
    enabled: !!country,
    liveSyncTable: 'price_validation_rules',
    fetcher: async () => {
      const { data, error } = await sb.from('price_validation_rules')
        .select('*').eq('country', country)
      if (error) throw error
      if (!data?.length) console.warn('[usePriceRules] Sin reglas para país:', country)
      return data || []
    },
  })

  function checkOutliers(rows) {
    const ok = []
    const suspects = []
    rows.forEach((row, idx) => {
      const { field, value: priceField } = getPriceField(row)
      if (priceField == null) { ok.push(row); return }
      const threshold = getThreshold(rules, row.city, row.category, row.competition_name)
      if (priceField > threshold) {
        suspects.push({ idx, row, field, value: priceField, threshold })
      } else {
        ok.push(row)
      }
    })
    return { ok, suspects }
  }

  // rulesLoaded conservado por compat con callers existentes (semántica:
  // "el fetch inicial terminó"). loading=false del SWR cumple lo mismo.
  return { rules, rulesLoaded: !loading, checkOutliers, error }
}

function getPriceField(row) {
  if (row.competition_name === 'InDrive') {
    if (row.recommended_price != null) return { field: 'recommended_price', value: row.recommended_price }
    if (row.price_without_discount != null) return { field: 'price_without_discount', value: row.price_without_discount }
    return { field: 'price_with_discount', value: row.price_with_discount }
  }
  if (row.price_without_discount != null) return { field: 'price_without_discount', value: row.price_without_discount }
  if (row.price_with_discount != null) return { field: 'price_with_discount', value: row.price_with_discount }
  return { field: 'recommended_price', value: row.recommended_price }
}

/**
 * Retorna el umbral máximo para una combinación city/category/competition.
 * Prioridad: city+category+competition > city+category+'all' > city+'all'+'all' > Infinity.
 *
 * NO usar 999 como fallback — rompe países con escala COP (un viaje de
 * 50000 COP en Colombia se marcaría falsamente como outlier).
 */
function getThreshold(rules, city, category, competition) {
  const specific = rules.find(r => r.city === city && r.category === category && r.competition === competition)
  if (specific) return specific.max_price

  const byCityCat = rules.find(r => r.city === city && r.category === category && r.competition === 'all')
  if (byCityCat) return byCityCat.max_price

  const byCity = rules.find(r => r.city === city && r.category === 'all' && r.competition === 'all')
  if (byCity) return byCity.max_price

  return Infinity
}
