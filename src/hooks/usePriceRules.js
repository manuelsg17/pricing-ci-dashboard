import { useState, useEffect } from 'react'
import { sb } from '../lib/supabase'

export function usePriceRules(country = 'Peru') {
  const [rules,       setRules]       = useState([])
  const [error,       setError]       = useState(null)
  const [rulesLoaded, setRulesLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    setRulesLoaded(false)
    sb.from('price_validation_rules').select('*').eq('country', country)
      .then(({ data, error: e }) => {
        if (cancelled) return
        if (e) {
          console.error('[usePriceRules] Error al cargar reglas:', e.message)
          setError(e.message)
        } else {
          if (!data?.length) console.warn('[usePriceRules] Sin reglas para país:', country)
          setRules(data || [])
          setError(null)
        }
        setRulesLoaded(true)
      })
    return () => { cancelled = true }
  }, [country])

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

  return { rules, rulesLoaded, checkOutliers, error }
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
 * Prioridad: city+category+competition > city+category+'all' > city+'all'+'all' > 999
 */
function getThreshold(rules, city, category, competition) {
  const match = (r) =>
    r.city === city &&
    (r.category === category || r.category === 'all') &&
    (r.competition === competition || r.competition === 'all')

  // Más específica primero
  const specific = rules.find(r => r.city === city && r.category === category && r.competition === competition)
  if (specific) return specific.max_price

  const byCityCat = rules.find(r => r.city === city && r.category === category && r.competition === 'all')
  if (byCityCat) return byCityCat.max_price

  const byCity = rules.find(r => r.city === city && r.category === 'all' && r.competition === 'all')
  if (byCity) return byCity.max_price

  // Sin regla → no bloquear
  return 999
}
