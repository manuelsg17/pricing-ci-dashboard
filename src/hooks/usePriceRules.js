import { useState, useEffect } from 'react'
import { sb } from '../lib/supabase'

/**
 * Carga las reglas de validación de precios desde la BD.
 * Retorna una función checkOutliers(rows) que devuelve las filas sospechosas.
 */
export function usePriceRules() {
  const [rules, setRules] = useState([])
  const [error, setError] = useState(null)

  useEffect(() => {
    sb.from('price_validation_rules').select('*')
      .then(({ data, error: e }) => {
        if (e) { setError(e.message); return }
        setRules(data || [])
      })
  }, [])

  /**
   * Evalúa cada fila y retorna las sospechosas.
   * @param {Array} rows - filas a validar (con city, category, competition_name, price_without_discount, etc.)
   * @returns {{ ok: Array, suspects: Array }}
   *   suspects[i] = { idx, row, field, value, threshold }
   */
  function checkOutliers(rows) {
    const ok = []
    const suspects = []

    rows.forEach((row, idx) => {
      const priceField = row.price_without_discount ?? row.recommended_price ?? row.price_with_discount
      if (priceField == null) { ok.push(row); return }

      // Buscar la regla más específica que aplique a esta fila
      const threshold = getThreshold(rules, row.city, row.category, row.competition_name)

      if (priceField > threshold) {
        suspects.push({ idx, row, field: 'price_without_discount', value: priceField, threshold })
      } else {
        ok.push(row)
      }
    })

    return { ok, suspects }
  }

  return { rules, checkOutliers, error }
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
