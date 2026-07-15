import { escapeCsvCell } from './csvSafety'

// Sanea un valor para usarlo en el nombre de archivo de descarga. Categorías
// reales de este dashboard incluyen '/' (ej. "Economy/Comfort") — sin esto,
// el navegador puede guardar el archivo en una subcarpeta inesperada o
// truncar el nombre en vez del .csv que el usuario espera encontrar.
function sanitizeForFilename(value) {
  return String(value ?? '').replace(/[/\\?%*:|"<>]/g, '-')
}

// Arma y dispara la descarga CSV del análisis de banda competitiva —
// mismo patrón Blob/URL.createObjectURL que Dashboard.jsx handleExportCSV.
export function exportCompetitiveBandCsv({
  country,
  competitorName,
  category,
  minPct,
  maxPct,
  summary,
  breakdown,
}) {
  const rows = []
  rows.push(['Análisis de competitividad'])
  rows.push(['País', country])
  rows.push(['Competidor', competitorName])
  rows.push(['Categoría', category])
  rows.push(['Banda configurada (%)', `${minPct} a ${maxPct}`])
  rows.push([])

  if (summary) {
    rows.push(['Resumen general'])
    rows.push(['Total observaciones', summary.total_observations])
    rows.push(['Por debajo de la banda', summary.below_count, `${summary.below_pct}%`])
    rows.push(['Dentro de la banda', summary.within_count, `${summary.within_pct}%`])
    rows.push(['Por encima de la banda', summary.above_count, `${summary.above_pct}%`])
    rows.push(['Promedio Δ%', summary.avg_pct_diff])
    rows.push(['P10', summary.p10])
    rows.push(['P25', summary.p25])
    rows.push(['P50 (mediana)', summary.p50])
    rows.push(['P75', summary.p75])
    rows.push(['P90', summary.p90])
    rows.push([])
  }

  rows.push(['Desglose por ciudad y distancia'])
  rows.push([
    'Ciudad',
    'Distancia',
    'Observaciones',
    '% dentro de banda',
    'Promedio Δ%',
    'Mediana Δ%',
  ])
  for (const r of breakdown) {
    rows.push([
      r.city,
      r.distance_bracket,
      r.total_observations,
      `${r.within_pct}%`,
      r.avg_pct_diff,
      r.p50,
    ])
  }

  const csv = rows.map((row) => row.map(escapeCsvCell).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `competitividad-${sanitizeForFilename(competitorName)}-${sanitizeForFilename(category)}-${new Date().toISOString().slice(0, 10)}.csv`
  link.click()
  URL.revokeObjectURL(url)
}

// Arma y dispara la descarga CSV de la comparación de volatilidad de precio
// (mig 126, get_price_volatility_by_category) — mismo patrón Blob que
// exportCompetitiveBandCsv, shape de datos distinto (precio real, no Δ%),
// por eso es una función hermana en vez de sobrecargar la anterior.
export function exportPriceVolatilityCsv({ country, category, city, currency, rows: dataRows }) {
  const rows = []
  rows.push(['Volatilidad de precio por competidor'])
  rows.push(['País', country])
  rows.push(['Ciudad', city || 'Todas'])
  rows.push(['Categoría', category])
  rows.push(['Moneda', currency])
  rows.push([])
  rows.push(['Competidor', 'Muestras', 'Mín', 'P10', 'P25', 'P50', 'P75', 'P90', 'Máx', 'Promedio'])
  for (const r of dataRows) {
    rows.push([
      r.competitor_name,
      r.n_buckets,
      r.min_price,
      r.p10,
      r.p25,
      r.p50,
      r.p75,
      r.p90,
      r.max_price,
      r.avg_price,
    ])
  }

  const csv = rows.map((row) => row.map(escapeCsvCell).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  const cityPart = city ? `-${sanitizeForFilename(city)}` : ''
  link.download = `volatilidad-precio-${sanitizeForFilename(category)}${cityPart}-${new Date().toISOString().slice(0, 10)}.csv`
  link.click()
  URL.revokeObjectURL(url)
}
