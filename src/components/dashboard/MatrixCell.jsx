import { memo } from 'react'
import { formatPrice, formatCount } from '../../lib/format.js'

/**
 * Celda de la matriz.
 * value: número a mostrar
 * semaforoClass: 'sem-green' | 'sem-yellow' | 'sem-red' | 'sem-none' | undefined
 * format: 'price' | 'delta' | 'count'
 *
 * `format='price'` usa formatPrice() que aplica separador de miles
 * (coma) + 2 decimales: 60000 → "60,000.00".
 *
 * memo() — esta celda se renderiza ~144 veces por sección (6 brackets ×
 * 4 competidores × 6 períodos). Sin memo, cualquier cambio en el padre
 * fuerza re-render de todas. Con memo, solo se actualizan las que
 * tienen props distintos. Mejora notable en interactividad.
 */
function MatrixCell({ value, semaforoClass, format = 'price', isBase = false }) {
  if (value === null || value === undefined) {
    return <td className={`cell-empty ${semaforoClass || ''}`}>—</td>
  }

  let display
  if (format === 'price') {
    display = formatPrice(value)
  } else if (format === 'delta') {
    if (isBase) {
      display = '0%'
    } else {
      const sign = value >= 0 ? '+' : ''
      display = `${sign}${Number(value).toFixed(0)}%`
    }
  } else if (format === 'count') {
    display = formatCount(value)
  }

  return <td className={semaforoClass || ''}>{display}</td>
}

export default memo(MatrixCell)
