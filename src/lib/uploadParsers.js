// Capa de parseo del upload de Excel — extraída de Upload.jsx (2026-07-31).
//
// POR QUÉ VIVE ACÁ Y NO EN LA PÁGINA:
//   Son ~450 líneas de funciones PURAS que forman el camino de ingesta masiva
//   a producción: fechas serial de Excel, horas fraccionarias, precios con
//   símbolo de moneda y coma decimal, booleanos en 3 idiomas, fill-down de
//   celdas combinadas y detección de ciudad por nombre de pestaña. Es la
//   superficie con más formatos raros de todo el proyecto.
//
//   Mientras vivieron dentro de Upload.jsx no se podían importar, y por eso
//   tenían CERO tests pese a ser críticas. Moverlas acá las hace testeables
//   (ver scripts/test-upload-parsers.mjs). El movimiento fue literal: no se
//   cambió una sola línea de lógica, solo se agregaron los `export`.
//
//   Cualquier cambio de comportamiento acá tiene que venir con su test.

import { normalizeBracket, toSnakeCase } from './normalize.js'
import { normalizeTukTukDistrict } from './tuktukDistricts.js'

// Mapa: nombre de columna en Excel/CSV → nombre en BD
// Incluye variantes con "(for pivot)" usadas en ARQ, TRU, AIRPORT
// NOTA (mig 94): 'Year' y 'Week'/'Week (for pivot)' deliberadamente NO se mapean
// — son derivados de observed_date vía el trigger trg_assign_computed_fields.
// Antes los Excel del campo traían WEEKNUM con offset distinto al ISO 8601 y
// contaminaban la columna week con valores -1 del real.
export const COL_MAP = {
  'Rush Hour': 'rush_hour',
  'Rush hour': 'rush_hour',
  'Point A': 'point_a',
  'Point B': 'point_b',
  'Travel Distance (Km)': 'distance_km',
  'Travel Distance (km)': 'distance_km',
  Category: 'category',
  Timeslot: 'timeslot',
  'Timeslot (for pivot)': 'timeslot',
  'Distance bracket': 'distance_bracket',
  'Distance Bracket': 'distance_bracket',
  'Distance bracket (for pivot)': 'distance_bracket',
  'Distance Bracket (for pivot)': 'distance_bracket',
  Date: 'observed_date',
  Time: 'observed_time',
  'Competition Name': 'competition_name',
  Surge: 'surge',
  'Travel Time(Min)': 'travel_time_min',
  'Travel Time (Min)': 'travel_time_min',
  'ETA(min)': 'eta_min',
  'ETA (min)': 'eta_min',
  'ETA (Min)': 'eta_min',
  'Recommend Price': 'recommended_price',
  'Recommended Price': 'recommended_price',
  'Minimal bid': 'minimal_bid',
  'Minimal Bid': 'minimal_bid',
  'Price With Discount': 'price_with_discount',
  'PriceW/ODiscount': 'price_without_discount',
  'Price W/O Discount': 'price_without_discount',
  Zone: 'zone',
  'Bid 1': 'bid_1',
  'Bid 2': 'bid_2',
  'Bid 3': 'bid_3',
  'Bid 4': 'bid_4',
  'Bid 5': 'bid_5',
  // Mig 136 (2026-07-20): bid_4/bid_5 re-agregados a pricing_observations
  // para que los hubs puedan cargar hasta 5 bids de InDrive (el promedio usa
  // todos). discount_offer/diff/for_pivot siguen dropeados (mig 98) — se
  // ignoran si aparecen en el Excel.
}

// Normalización de categorías del Excel legacy → nombre canónico en BD nuevo.
// Los Excel históricos usan nombres viejos; aquí los traducimos al esquema nuevo.
export const CATEGORY_NORMALIZE = {
  // Esquema nuevo (Perú 2026): categorías tal cual
  'Economy/Comfort': 'Economy/Comfort',
  'Comfort+': 'Comfort+',
  // Esquema legacy (Excel anteriores)
  'Comfort/Comfort+': 'Comfort+', // TRU/ARQ legacy: antes "Comfort" agrupaba todo → ahora Comfort+
  'Comfort+/Premier': 'Premier', // Lima legacy: "Comfort+/Premier" → Premier
  Economy: 'Economy/Comfort', // Legacy: Economy se fusionó con Comfort
  Comfort: 'Comfort+', // Legacy: Comfort (de Uber/InDrive) ahora es Comfort+
}

// Normalización de distance_bracket: display → formato BD (snake_case)
export const BRACKET_NORMALIZE = {
  'Very short': 'very_short',
  'Very Short': 'very_short',
  Short: 'short',
  Median: 'median',
  Average: 'average',
  Long: 'long',
  'Very long': 'very_long',
  'Very Long': 'very_long',
}

// Normalización de nombres de competidor. Mismo split que en
// ingestionFilters.js: fixes de casing siempre aplican; el aplastado
// "Yango-master" (Premier/Comfort+ → Yango) sólo fuera de Corp donde
// Premier y Comfort+ son sub-variantes de Yango. En Corp son competidores
// legítimos separados — aplastarlos perdió 1190 filas históricas (mig 69).
export const COMPETITOR_CASING_FIXES = {
  Indrive: 'InDrive',
  DiDi: 'Didi',
}
export const COMPETITOR_YANGO_MASTER_FLATTEN = {
  'Yango premier': 'Yango',
  'Yango  premier': 'Yango',
  YangoPremier: 'Yango',
  'YangoComfort+': 'Yango',
}

// ── Helpers de parseo ──────────────────────────────────────

export function excelSerialToDate(serial) {
  const date = new Date((serial - 25569) * 86400 * 1000)
  return date.toISOString().slice(0, 10)
}

export function parseExcelDate(val) {
  if (val === null || val === undefined || val === '') return null

  // Número serial de Excel (como número o como string numérico puro, ej: "45659")
  if (typeof val === 'number') return excelSerialToDate(Math.floor(val))
  if (typeof val === 'string' && /^\d{4,6}$/.test(val.trim())) {
    return excelSerialToDate(parseInt(val.trim(), 10))
  }

  if (typeof val === 'string') {
    const s = val.trim()
    // Formato DD/MM/YYYY → YYYY-MM-DD
    if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) {
      const [d, m, y] = s.split('/')
      return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
    }
    // Formato DD-MM-YYYY
    if (/^\d{1,2}-\d{1,2}-\d{4}$/.test(s)) {
      const [d, m, y] = s.split('-')
      return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
    }
    // Ya en formato YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
    return null
  }

  if (val instanceof Date) return val.toISOString().slice(0, 10)
  return null
}

export function parseExcelTime(val) {
  if (val === null || val === undefined || val === '') return null
  if (typeof val === 'string') {
    const s = val.trim()
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(s)) return s
    return null
  }
  if (typeof val === 'number') {
    const fraction = val % 1
    const totalSeconds = Math.round(fraction * 86400)
    const h = Math.floor(totalSeconds / 3600)
    const m = Math.floor((totalSeconds % 3600) / 60)
    const s = totalSeconds % 60
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }
  if (val instanceof Date) return val.toTimeString().slice(0, 8)
  return null
}

// Columnas que deben ser números en la BD.
// Mig 136 re-agregó bid_4/bid_5 (hasta 5 bids InDrive). discount_offer/diff
// siguen dropeados (mig 98) — no van en el INSERT.
export const NUMERIC_COLS = new Set([
  'distance_km',
  'travel_time_min',
  'eta_min',
  'recommended_price',
  'minimal_bid',
  'price_with_discount',
  'price_without_discount',
  'bid_1',
  'bid_2',
  'bid_3',
  'bid_4',
  'bid_5',
])

// Columnas que deben ser enteros
export const INT_COLS = new Set(['year', 'week'])

// Columnas de fecha/hora — necesitan el valor RAW (no convertido a string)
export const RAW_COLS = new Set(['observed_date', 'observed_time'])

export function toNumeric(val) {
  if (val === null || val === undefined || val === '') return null
  if (typeof val === 'number') return isNaN(val) ? null : val
  // Quitar prefijo de moneda (ej: "S/.9.00" → "9.00", "$8.50" → "8.50")
  // y normalizar coma decimal ("13,2" → "13.2")
  const s = String(val)
    .trim()
    .replace(/^[^\d-]+/, '')
    .replace(',', '.')
  const n = parseFloat(s)
  return isNaN(n) ? null : n
}

export function toInt(val) {
  const n = toNumeric(val)
  return n === null ? null : Math.round(n)
}

export function parseBool(val) {
  if (val === null || val === undefined || val === '') return null
  if (typeof val === 'boolean') return val
  if (typeof val === 'number') return val !== 0
  const s = String(val).trim().toLowerCase()
  if (s === '' || s === 'null' || s === 'n/a') return null
  return s === 'si' || s === 'sí' || s === 'yes' || s === '1' || s === 'true' || s === 'rush hour'
}

export function cleanStr(val) {
  if (val === null || val === undefined) return null
  return String(val).trim() || null
}

export function parseRows(sheetData, city) {
  if (!sheetData.length) return []

  // Encontrar la fila de cabeceras: la primera que contenga al menos una columna conocida en COL_MAP
  // (ignora filas de metadata como "colocar lista de eleccion", "InDrive", "All exc. InDrive"…)
  const headerRowIdx = sheetData.findIndex(
    (r) => r && r.some((c) => COL_MAP[String(c || '').trim()])
  )
  if (headerRowIdx === -1) return []
  const headers = sheetData[headerRowIdx]

  const mappedRows = sheetData.slice(headerRowIdx + 1).map((row) => {
    // Ignorar filas completamente vacías
    if (!row || row.every((c) => c === null || c === '')) return null

    const obj = { city }
    headers.forEach((h, i) => {
      const dbCol = COL_MAP[String(h || '').trim()]
      if (!dbCol) return
      const raw = row[i] ?? null
      if (RAW_COLS.has(dbCol))
        obj[dbCol] = raw // fecha/hora: conservar número original
      else if (NUMERIC_COLS.has(dbCol)) obj[dbCol] = toNumeric(raw)
      else if (INT_COLS.has(dbCol)) obj[dbCol] = toInt(raw)
      else obj[dbCol] = cleanStr(raw)
    })

    // Fecha y hora
    obj.observed_date = parseExcelDate(obj.observed_date)
    obj.observed_time = parseExcelTime(obj.observed_time)

    // Booleans — forzar true/false/null sin excepción
    const rawSurge = obj.surge
    const rawRushHour = obj.rush_hour

    obj.surge = typeof rawSurge === 'boolean' ? rawSurge : parseBool(rawSurge)

    obj.rush_hour =
      typeof rawRushHour === 'string'
        ? rawRushHour.toLowerCase().includes('rush')
          ? true
          : rawRushHour.toLowerCase().includes('valley')
            ? false
            : null
        : typeof rawRushHour === 'boolean'
          ? rawRushHour
          : parseBool(rawRushHour)

    // Red de seguridad final: si algo raro llegó, forzar null
    if (obj.surge !== null && typeof obj.surge !== 'boolean') obj.surge = null
    if (obj.rush_hour !== null && typeof obj.rush_hour !== 'boolean') obj.rush_hour = null

    // Limpiar nombres clave (sin espacios extra, sin saltos de línea)
    obj.competition_name = cleanStr(obj.competition_name)
    obj.category = cleanStr(obj.category)
    obj.distance_bracket = cleanStr(obj.distance_bracket)

    // Normalizar categorías, competidores y bracket a nombres canónicos en BD
    if (obj.category) obj.category = CATEGORY_NORMALIZE[obj.category] ?? obj.category
    if (obj.competition_name) {
      let legacy = COMPETITOR_CASING_FIXES[obj.competition_name] ?? obj.competition_name
      // El flatten YangoPremier/YangoComfort+ → Yango sólo aplica fuera de
      // contextos Corp. Verificamos AMBOS: city='Corp' (archivo corp) Y
      // category='Corp' (filas con categoría corporativa dentro de city
      // distinta). Sin el chequeo por category se perdían sub-marcas en
      // archivos mal detectados (ej. "corp lima (1)" detectado como Lima).
      if (obj.city !== 'Corp' && obj.category !== 'Corp') {
        legacy = COMPETITOR_YANGO_MASTER_FLATTEN[legacy] ?? legacy
      }
      obj.competition_name = legacy
    }
    if (obj.distance_bracket)
      obj.distance_bracket =
        BRACKET_NORMALIZE[obj.distance_bracket] ?? normalizeBracket(obj.distance_bracket)

    // TukTuk: canonicalizar el distrito (columna Zone) a la lista válida.
    if (obj.category === 'TukTuk' && obj.zone) {
      const d = normalizeTukTukDistrict(obj.zone)
      if (d) obj.zone = d
    }

    return obj
  })

  // Fill-down: hereda competition_name, observed_date y category de la fila anterior
  // cuando la celda llega null (patrón de celdas combinadas en Excel).
  // Se resetea en filas completamente vacías (null) para no cruzar secciones.
  let lastDate = null
  let lastCompetitor = null
  let lastCategory = null
  const filled = []
  for (const r of mappedRows) {
    if (!r) {
      lastDate = null
      lastCompetitor = null
      lastCategory = null
      filled.push(r)
      continue
    }
    if (r.observed_date) lastDate = r.observed_date
    else if (lastDate) r.observed_date = lastDate

    if (r.competition_name) lastCompetitor = r.competition_name
    else if (lastCompetitor) r.competition_name = lastCompetitor

    if (r.category) lastCategory = r.category
    else if (lastCategory) r.category = lastCategory

    filled.push(r)
  }

  // Contar descartadas para diagnóstico visible en la UI
  let droppedNoDate = 0
  let droppedNoCompetitor = 0
  let droppedNoCategory = 0
  let droppedCorpYango = 0
  const rows = filled.filter((r) => {
    if (!r) return false
    if (!r.observed_date) {
      droppedNoDate++
      return false
    }
    if (!r.competition_name) {
      droppedNoCompetitor++
      return false
    }
    if (!r.category) {
      droppedNoCategory++
      return false
    }
    // Mig 71: Corp rechaza 'Yango' anónimo (debe ser YangoEconomy/YangoComfort/
    // YangoComfort+/YangoPremier/YangoXL). Si el Excel trae bare 'Yango' para
    // Corp (en cualquier casing o con espacios), lo dropeamos acá en lugar de
    // dejar que la DB tire 23514 al final. La DB normaliza 'yango'/'YANGO'/'Yango '
    // a 'Yango' canónico y luego el guard lo rechaza, así que el match acá es
    // sobre el lowercase trim.
    if (r.city === 'Corp' && (r.competition_name || '').trim().toLowerCase() === 'yango') {
      droppedCorpYango++
      return false
    }
    return true
  })

  // TukTuk: diagnóstico de distrito (no se descartan filas, solo se avisa).
  let tuktukRows = 0
  let tuktukNoDistrict = 0
  for (const r of rows) {
    if (r.category === 'TukTuk') {
      tuktukRows++
      if (!normalizeTukTukDistrict(r.zone)) tuktukNoDistrict++
    }
  }

  return {
    rows,
    droppedNoDate,
    droppedNoCompetitor,
    droppedNoCategory,
    droppedCorpYango,
    tuktukRows,
    tuktukNoDistrict,
  }
}

// Detecta la ciudad a partir del nombre de la pestaña o archivo.
//
// NOTA SOBRE AIRPORT (post mig 78-85):
//   Los nombres legacy Lima_Airport / Trujillo_Airport / Arequipa_Airport
//   ya NO existen como cities — fueron reemplazados por Lima_Airport_A /
//   Lima_Airport_B (origen vs destino aeropuerto). La clasificación A/B
//   ya no se hace por sheet name — se hace por la columna `Zone` del
//   Excel + el trigger BEFORE INSERT (mig 83) que lee zone y rutea.
//
//   Para upload Excel de aeropuerto:
//     - Sheet nombrada "lima_airport_*"  → detecta como 'Lima'
//     - Cada fila DEBE tener columna `Zone` = 'Airport_A' o 'Airport_B'
//     - Trigger reasigna city correctamente al INSERT
//
//   Si la fila NO tiene Zone, el trigger intenta detectar por keyword en
//   point_a/point_b (mig 78). Si tampoco matchea, queda en city base.
export const SHEET_CITY_MAP = {
  lima_pricing_ci_corp_final: 'Corp',
  lima_pricing_ci_corp: 'Corp',
  lima_corp: 'Corp',
  lima_pricing_ci_final: 'Lima',
  tru_pricing_ci_final: 'Trujillo',
  trujillo: 'Trujillo',
  arq_pricing_ci_final: 'Arequipa',
  arequipa: 'Arequipa',
  // Airport sheets → base city. Zone column + trigger hace la clasificación.
  lima_airport_ci_final: 'Lima',
  lima_airport: 'Lima',
  tru_airport_ci_final: 'Trujillo',
  trujillo_airport: 'Trujillo',
  arq_airport_ci_final: 'Arequipa',
  arequipa_airport: 'Arequipa',
  // Legacy (Excel viejos donde "airport" = Lima sin city explícita)
  airport_ci_final: 'Lima',
  airport: 'Lima',
}

// `countryConfig` viene de useCountry() y ya respeta el override DB →
// países onboardeados via wizard funcionan sin tocar este archivo. El
// SHEET_CITY_MAP hardcoded queda como fallback Peru-específico (cubre
// sufijos legacy como `_pricing_ci_final` que el bot no envía).
export function detectCity(sheetName, countryConfig) {
  const key = toSnakeCase(sheetName)
  const lowerPattern = key.toLowerCase()

  // (0) Keywords semánticamente específicas que ganan sobre cualquier nombre
  //     de ciudad embebido. Ejemplo: "corp lima (1)" debe detectar como
  //     'Corp', NO como 'Lima' (lima aparece como substring pero corp es
  //     la categoría real del archivo).
  if (lowerPattern.includes('corp')) return 'Corp'

  // (1) Data-driven: cada ciudad del país activo tiene botKey definido en
  //     country_config.cities (jsonb). Tolera prefijo/sufijo.
  const botCityMap = countryConfig?.botCityMap || {}
  for (const [botKey, dbCity] of Object.entries(botCityMap)) {
    if (!botKey) continue
    if (
      key === botKey ||
      key.startsWith(botKey + '_') ||
      key.endsWith('_' + botKey) ||
      key.includes('_' + botKey + '_')
    ) {
      return dbCity
    }
  }

  // (2) Fallback Peru: el bot histórico envía pestañas con sufijo
  //     `_pricing_ci_final` que no caen en (1) porque no son botKey puro.
  for (const [pattern, city] of Object.entries(SHEET_CITY_MAP)) {
    if (key.includes(pattern.replace(/_/g, '')) || key === pattern) return city
  }

  // (3) Heurísticas por keyword (Peru/Colombia legacy).
  // Airport detection ya NO mapea a Lima_Airport/Trujillo_Airport/Arequipa_Airport
  // (cities legacy retiradas en mig 79+84). Las filas de aeropuerto se rutean
  // por la columna Zone del Excel + trigger BEFORE INSERT (mig 83) — acá
  // simplemente caemos a la base city y dejamos que el trigger haga la
  // clasificación A/B.
  // ('corp' ya fue chequeado en paso (0) — gana sobre nombres de ciudad embebidos)
  if (lowerPattern.includes('lima')) return 'Lima'
  if (lowerPattern.includes('tru') || lowerPattern.includes('trujillo')) return 'Trujillo'
  if (lowerPattern.includes('arq') || lowerPattern.includes('arequipa')) return 'Arequipa'
  // Fallback Lima si dice "airport" sin city específica
  if (lowerPattern.includes('airport') || lowerPattern.includes('aero')) return 'Lima'
  if (lowerPattern.includes('bog')) return 'Bogota'
  if (lowerPattern.includes('med')) return 'Medellin'
  if (lowerPattern.includes('cali')) return 'Cali'
  return null
}
