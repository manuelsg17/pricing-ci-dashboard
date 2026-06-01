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
 *
 * a11y: además del color, prepende un icono ✓ / ⚠ / ✗ según el semáforo
 * para que daltónicos (8% de hombres con deuteranopía) o lectores con
 * monitor poco calibrado distingan la categoría sin depender del color.
 * El icono lleva aria-hidden (texto decorativo) y la celda lleva
 * aria-label semántico ('favorable' | 'atención' | 'desfavorable').
 */

const SEMAFORO_INDICATOR = {
  'sem-green':  { icon: '✓', label: 'favorable' },
  'sem-yellow': { icon: '⚠', label: 'atención' },
  'sem-red':    { icon: '✗', label: 'desfavorable' },
}

function MatrixCell({ value, semaforoClass, format = 'price', isBase = false }) {
  const indicator = semaforoClass ? SEMAFORO_INDICATOR[semaforoClass] : null
  const ariaLabel = indicator ? indicator.label : undefined

  if (value === null || value === undefined) {
    return <td className={`cell-empty ${semaforoClass || ''}`} aria-label={ariaLabel}>—</td>
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

  return (
    <td className={semaforoClass || ''} aria-label={ariaLabel}>
      {indicator && (
        <span
          aria-hidden="true"
          style={{ marginRight: 4, fontSize: '0.85em', opacity: 0.75 }}
        >
          {indicator.icon}
        </span>
      )}
      {display}
    </td>
  )
}

export default memo(MatrixCell)
