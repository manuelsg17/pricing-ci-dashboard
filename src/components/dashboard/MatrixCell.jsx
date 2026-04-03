/**
 * Celda de la matriz.
 * value: número a mostrar
 * semaforoClass: 'sem-green' | 'sem-yellow' | 'sem-red' | 'sem-none' | undefined
 * format: 'price' | 'delta' | 'count'
 */
export default function MatrixCell({ value, semaforoClass, format = 'price', isBase = false }) {
  if (value === null || value === undefined) {
    return <td className={`cell-empty ${semaforoClass || ''}`}>—</td>
  }

  let display
  if (format === 'price') {
    display = Number(value).toFixed(2)
  } else if (format === 'delta') {
    if (isBase) {
      display = '0%'
    } else {
      const sign = value >= 0 ? '+' : ''
      display = `${sign}${Number(value).toFixed(0)}%`
    }
  } else if (format === 'count') {
    display = Number(value).toLocaleString()
  }

  return <td className={semaforoClass || ''}>{display}</td>
}
