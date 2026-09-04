import { sanitizeForFilename, sanitizeForSpreadsheet } from './csvSafety'

const HEADERS = [
  'País',
  'Ciudad',
  'Categoría',
  'Competidor',
  'Fuente',
  'Año',
  'Semana',
  'Fecha',
  'Hora',
  'Rush hour',
  'Surge',
  'Bracket',
  'Zona',
  'Distancia (km)',
  'Punto A',
  'Punto B',
  'Precio sin descuento',
  'Precio con descuento',
  'Precio recomendado',
  'Bid mínimo',
  'Bid 1',
  'Bid 2',
  'Bid 3',
  'Bid 4',
  'Bid 5',
  'ETA (min)',
]

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function boolLabel(value) {
  if (value === true) return 'Sí'
  if (value === false) return 'No'
  return null
}

function buildRow(r) {
  return [
    r.country ?? null,
    r.city ?? null,
    r.category ?? null,
    r.competition_name ?? null,
    r.data_source ?? null,
    r.year ?? null,
    r.week ?? null,
    r.observed_date ?? null,
    r.observed_time ?? null,
    boolLabel(r.rush_hour),
    boolLabel(r.surge),
    r.distance_bracket ?? null,
    // zone no está en una whitelist a nivel DB para filas del bot (a
    // diferencia de category/competition_name) — mismo tratamiento que
    // point_a/point_b.
    sanitizeForSpreadsheet(r.zone ?? null),
    toNumberOrNull(r.distance_km),
    sanitizeForSpreadsheet(r.point_a ?? null),
    sanitizeForSpreadsheet(r.point_b ?? null),
    toNumberOrNull(r.price_without_discount),
    toNumberOrNull(r.price_with_discount),
    toNumberOrNull(r.recommended_price),
    toNumberOrNull(r.minimal_bid),
    toNumberOrNull(r.bid_1),
    toNumberOrNull(r.bid_2),
    toNumberOrNull(r.bid_3),
    toNumberOrNull(r.bid_4),
    toNumberOrNull(r.bid_5),
    toNumberOrNull(r.eta_min),
  ]
}

// Exporta filas crudas de pricing_observations (RawData.jsx) a un .xlsx —
// una fila por observación tal cual está en BD (sin agregar/redondear), para
// análisis externo (ej. head de partners haciendo análisis en frío fuera del
// dashboard). Mismo patrón Blob/URL.createObjectURL que el resto de los
// exports del proyecto — solo cambian los bytes (XLSX.write en vez de CSV).
export async function exportRawDataXlsx({ rows, dbCity, dbCategory }) {
  // xlsx se importa bajo demanda: RawData no paga el chunk hasta exportar.
  const XLSX = await import('xlsx')
  const aoa = [HEADERS, ...rows.map(buildRow)]
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Raw data')

  const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
  const blob = new Blob([bytes], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  const catPart = dbCategory ? `-${sanitizeForFilename(dbCategory)}` : ''
  link.download = `raw-data-${sanitizeForFilename(dbCity)}${catPart}-${new Date().toISOString().slice(0, 10)}.xlsx`
  link.click()
  URL.revokeObjectURL(url)
}
