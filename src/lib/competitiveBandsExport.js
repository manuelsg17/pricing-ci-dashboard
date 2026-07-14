import { escapeCsvCell } from './csvSafety'

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
  link.download = `competitividad-${competitorName}-${category}-${new Date().toISOString().slice(0, 10)}.csv`
  link.click()
  URL.revokeObjectURL(url)
}
