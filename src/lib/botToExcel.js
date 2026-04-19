/**
 * botToExcel.js
 *
 * Convierte el xlsx de salida del bot → formato CI Final Claude.xlsx
 * Genera un archivo xlsx por ciudad (Lima, Trujillo, Arequipa, Bogotá, etc.).
 *
 * Reutiliza mapBotRows() de botMapping.js para normalización y filtros de calidad.
 */

import * as XLSX from 'xlsx'
import { mapBotRows } from './botMapping'
import { getCountryConfig } from './constants'

// Competidores a incluir en la salida (Cabify excluido en esta etapa)
const INCLUDE_COMPETITORS = new Set([
  'Yango', 'YangoPremier', 'YangoComfort+', 'Uber', 'Didi', 'InDrive',
])

// Reverse: formato DB bracket → display Excel
const BRACKET_DISPLAY = {
  very_short: 'Very short',
  short:      'Short',
  median:     'Median',
  average:    'Average',
  long:       'Long',
  very_long:  'Very long',
}

// ── Derivaciones desde fecha/hora ──────────────────────────────────────────

function deriveYear(dateStr) {
  if (!dateStr) return null
  return parseInt(dateStr.slice(0, 4), 10)
}

function deriveWeek(dateStr) {
  if (!dateStr) return null
  const d = new Date(dateStr + 'T12:00:00')
  const day = d.getDay() || 7
  d.setDate(d.getDate() + 4 - day)
  const yearStart = new Date(d.getFullYear(), 0, 1)
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7)
}

function deriveRushHour(timeStr) {
  if (!timeStr) return null
  const [h, m] = timeStr.split(':').map(Number)
  const mins = h * 60 + m
  const isRush =
    (mins >= 7 * 60 && mins <= 9 * 60) ||
    (mins >= 17 * 60 && mins <= 20 * 60)
  return isRush ? 'Rush hour' : 'Valley Hour'
}

function deriveTimeslot(timeStr) {
  if (!timeStr) return null
  const h = parseInt(timeStr.slice(0, 2), 10)
  if (h < 12)  return 'Morning'
  if (h < 17)  return 'Midday'
  return 'Evening'
}

// ── Construcción de fila para AOA ──────────────────────────────────────────

/**
 * Convierte una fila normalizada (salida de mapBotRows) al array de 29 valores
 * que corresponde a las columnas del formato CI Final Claude.xlsx.
 */
function buildRow(row, city, countryConfig) {
  // Use category label if available (though bot usually has raw names)
  const categoryDisplay = row.category
  const bracketDisplay  = BRACKET_DISPLAY[row.distance_bracket] ?? row.distance_bracket ?? null
  const surgeDisplay    = row.surge === true ? 'yes' : row.surge === false ? 'no' : null
  const isInDrive       = row.competition_name === 'InDrive'

  return [
    deriveYear(row.observed_date),          // 1  Year
    deriveRushHour(row.observed_time),       // 2  Rush Hour
    row.point_a ?? null,                     // 3  Point A
    row.point_b ?? null,                     // 4  Point B
    null,                                    // 5  Travel Distance (Km) — bot no entrega
    categoryDisplay,                         // 6  Category
    deriveWeek(row.observed_date),           // 7  Week
    deriveTimeslot(row.observed_time),       // 8  Timeslot
    bracketDisplay,                          // 9  Distance bracket
    row.observed_date ?? null,               // 10 Date
    row.observed_time ?? null,               // 11 Time
    row.competition_name ?? null,            // 12 Competition Name
    surgeDisplay,                            // 13 Surge
    null,                                    // 14 Travel Time (Min)
    row.eta_min ?? null,                     // 15 ETA (Min)
    isInDrive ? row.recommended_price : null,// 16 Recommended Price (InDrive only)
    isInDrive ? row.minimal_bid : null,      // 17 Minimal bid (InDrive only)
    isInDrive ? null : row.price_with_discount, // 18 Price With Discount
    isInDrive ? null : row.price_without_discount, // 19 PriceW/ODiscount
    null,                                    // 20 Zone
    null,                                    // 21 Bid 1
    null,                                    // 22 Bid 2
    null,                                    // 23 Bid 3
    null,                                    // 24 Bid 4
    null,                                    // 25 Bid 5
    null,                                    // 26 Discount offer
    null,                                    // 27 For pivot
    null,                                    // 28 Diff (manualy calc)
    null,                                    // 29 Minimal Bid Vs Recomm Price
  ]
}

// ── Construcción del xlsx por ciudad ──────────────────────────────────────

const META_HEADERS = [
  null, null, null, null, null,
  'colocar lista de eleccion',               // col 6
  null, null, null, null, null, null, null, null, null,
  'InDrive',                                 // col 16
  'InDrive',                                 // col 17
  'All exc. InDrive',                        // col 18
  'All',                                     // col 19
  null,
  'InDrive bids (4-5 bids) for analysis',   // col 21
  null, null, null, null, null, null, null, null,
]

const COL_HEADERS = [
  'Year', 'Rush Hour', 'Point A', 'Point B', 'Travel Distance (Km)',
  'Category', 'Week', 'Timeslot', 'Distance bracket', 'Date', 'Time',
  'Competition Name', 'Surge', 'Travel Time (Min)', 'ETA (Min)',
  'Recommended Price', 'Minimal bid', 'Price With Discount', 'PriceW/ODiscount',
  'Zone', 'Bid 1', 'Bid 2', 'Bid 3', 'Bid 4', 'Bid 5',
  'Discount offer', 'For pivot', 'Diff (manualy calc)', 'Minimal Bid Vs Recomm Price',
]

function buildCityXlsx(rows, city, countryConfig) {
  // Nombres de sheet: TRU_... ARQ_... para Peru, City_... para el resto
  let sheetName = `${city}_Pricing_CI_FINAL`
  if (city === 'Trujillo') sheetName = 'TRU_Pricing_CI_FINAL'
  if (city === 'Arequipa') sheetName = 'ARQ_Pricing_CI_FINAL'

  const dataRows  = rows.map(r => buildRow(r, city, countryConfig))
  const aoa       = [META_HEADERS, COL_HEADERS, ...dataRows]

  const ws = XLSX.utils.aoa_to_sheet(aoa)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, sheetName)

  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
}

// ── Función principal exportada ────────────────────────────────────────────

/**
 * Convierte filas crudas del bot al formato CI Final Excel.
 *
 * @param {object[]} rawRows - filas tal como vienen del xlsx del bot (objeto plano)
 * @param {string} country - "Peru" | "Colombia"
 * @returns {{
 *   files:   { [cityName: string]: Uint8Array },
 *   summary: { [cityName: string]: number, total: number },
 *   skipped: { row: object, reason: string }[],
 *   ok:      object[]  — filas válidas (para chequeo de outliers en el caller)
 * }}
 */
export function convertBotToExcel(rawRows, country = 'Peru') {
  const config = getCountryConfig(country)
  
  // 1. Normalizar y filtrar calidad (mapBotRows ya hace todo el trabajo duro)
  const { ok, skipped } = mapBotRows(rawRows, country)

  // 2. Filtrar solo los competidores del scope actual
  const inScope           = ok.filter(r => INCLUDE_COMPETITORS.has(r.competition_name))
  const skippedCompetitor = ok
    .filter(r => !INCLUDE_COMPETITORS.has(r.competition_name))
    .map(r => ({ row: r, reason: `Competidor fuera de scope: ${r.competition_name}` }))

  // 3. Filtrar filas sin precio en columna de salida
  const filtered        = inScope.filter(r =>
    r.competition_name === 'InDrive'
      ? r.recommended_price != null
      : r.price_without_discount != null,
  )
  const skippedNoPrice  = inScope
    .filter(r =>
      r.competition_name === 'InDrive'
        ? r.recommended_price == null
        : r.price_without_discount == null,
    )
    .map(r => ({ row: r, reason: 'Sin precio en columna de salida' }))

  const allSkipped = [...skipped, ...skippedCompetitor, ...skippedNoPrice]

  // 4. Agrupar por ciudad definida en el país
  const byCity = {}
  const summary = { total: 0 }
  
  for (const dbCity of config.dbCities) {
    byCity[dbCity] = []
    summary[dbCity] = 0
  }

  for (const row of filtered) {
    if (byCity[row.city]) {
      byCity[row.city].push(row)
    }
  }

  // 5. Generar xlsx por ciudad (solo si tiene filas)
  const files   = {}

  for (const city of config.dbCities) {
    summary[city]  = byCity[city].length
    summary.total += byCity[city].length
    if (byCity[city].length > 0) {
      files[city] = buildCityXlsx(byCity[city], city, config)
    }
  }

  return { files, summary, skipped: allSkipped, ok: filtered }
}
