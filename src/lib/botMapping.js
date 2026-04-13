import { getCountryConfig } from './constants'

/**
 * Mapeo de columnas del bot → pricing_observations
 *
 * El CSV del bot tiene: timestamp_utc, timestamp_local, timezone, run_id,
 * app, country, city, start_address, end_address, observed_start_address,
 * observed_end_address, distance_bracket, main_category, vehicle_category,
 * observed_vehicle_category, estimated_eta_text, eta_mins,
 * price_regular_value, price_discounted_value, currency, surge, status, error
 */

// Normalización de nombres de app → competition_name de la BD
const APP_MAP = {
  uber:      'Uber',
  yango:     'Yango',
  yango_api: 'Yango',
  didi:      'Didi',
  indrive:   'InDrive',
  cabify:    'Cabify',
}

// Normalización vehicle_category + city → category DB
// vehicle_category del bot: economy, comfort, premium, tuktuk, xl, moto, taxi, courier, etc.
const VEHICLE_CATEGORY_MAP = {
  economy:  'Economy',
  comfort:  'Comfort',
  premium:  'Comfort', // Default safe fallback
  tuktuk:   'TukTuk',
  xl:       'XL',
}

// Overrides específicos (ej: premium → Premier en Lima)
const CATEGORY_OVERRIDES = {
  Lima: { premium: 'Premier' },
  Airport: { premium: 'Premier' },
}

// Categorías válidas en la BD (solo estas se insertan)
const VALID_CATEGORIES = new Set(['Economy', 'Comfort', 'Premier', 'TukTuk', 'XL', 'Corp'])

// Normalización de distance_bracket del bot → bracket de la BD
const BRACKET_MAP = {
  'very short': 'very_short',
  'very_short': 'very_short',
  'short':      'short',
  'median':     'median',
  'average':    'average',
  'long':       'long',
  'very long':  'very_long',
  'very_long':  'very_long',
}

/**
 * Parsea precio del bot. Maneja puntos como separador decimal.
 * Descarta precios > maxPrice.
 */
function parsePrice(val, maxPrice) {
  if (val === null || val === undefined || val === '') return null
  const s = String(val).trim().replace(/,/g, '')  // quitar comas (Colombia)
  const n = parseFloat(s)
  if (isNaN(n) || n <= 0 || n > maxPrice) return null
  return n
}

/**
 * Parsea timestamp_local "2026-03-11T15:26:10-05:00" → { date, time }
 */
function parseTimestamp(ts) {
  if (!ts) return { date: null, time: null }
  const m = String(ts).match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/)
  if (!m) return { date: null, time: null }
  return { date: m[1], time: m[2] }
}

/**
 * Transforma rows del CSV del bot → formato pricing_observations.
 *
 * @param {object[]} rows - filas parseadas del CSV del bot
 * @param {string} activeCountry - "Peru" | "Colombia"
 * @returns {{ ok: object[], skipped: { row: object, reason: string }[] }}
 */
export function mapBotRows(rows, activeCountry = 'Peru') {
  const ok      = []
  const skipped = []
  const config = getCountryConfig(activeCountry)
  const maxPrice = config.maxPrice || 300
  const botCityMap = config.botCityMap || {}
  const targetCountry = activeCountry.toLowerCase()

  for (const row of rows) {
    // 1. Filtrar solo el país activo y status ok
    const rowCountry = String(row.country || '').trim().toLowerCase()
    const status     = String(row.status  || '').trim().toLowerCase()
    
    // El bot a veces registra "Peru", a veces "Columbia" (typo común)
    if (rowCountry !== targetCountry && rowCountry !== 'peru' && targetCountry === 'peru') {
       skipped.push({ row, reason: `País: ${row.country} (se esperaba ${activeCountry})` })
       continue
    }
    // Para Colombia, el bot suele decir "colombia"
    if (targetCountry === 'colombia' && rowCountry !== 'colombia') {
       skipped.push({ row, reason: `País: ${row.country} (se esperaba Colombia)` })
       continue
    }

    if (status !== 'ok') {
      skipped.push({ row, reason: `Status: ${row.status}` })
      continue
    }

    // 2. App → competition_name
    const appKey  = String(row.app || '').trim().toLowerCase()
    const compName = APP_MAP[appKey]
    if (!compName) {
      skipped.push({ row, reason: `App desconocida: ${row.app}` })
      continue
    }

    // 3. City → dbCity
    const cityRaw = String(row.city || '').trim().toLowerCase()
    const dbCity  = botCityMap[cityRaw]
    if (!dbCity) {
      skipped.push({ row, reason: `Ciudad desconocida o no mapeada: ${row.city}` })
      continue
    }

    // 4. vehicle_category → category
    const vcRaw    = String(row.vehicle_category || '').trim().toLowerCase()
    const category = CATEGORY_OVERRIDES[dbCity]?.[vcRaw] || VEHICLE_CATEGORY_MAP[vcRaw]
    
    if (!category || !VALID_CATEGORIES.has(category)) {
      skipped.push({ row, reason: `Categoría omitida: ${row.vehicle_category}` })
      continue
    }

    // 5. competition_name ajuste: para Yango + premium en Lima → YangoPremier
    let competition_name = compName
    if (compName === 'Yango' && category === 'Premier' && (dbCity === 'Lima' || dbCity === 'Airport')) {
      competition_name = 'YangoPremier'
    }
    // Para Yango + Comfort en TRU/ARQ premium → YangoComfort+
    if (compName === 'Yango' && vcRaw === 'premium' && (dbCity === 'Trujillo' || dbCity === 'Arequipa')) {
      competition_name = 'YangoComfort+'
    }

    // 6. distance_bracket
    const bracketRaw = String(row.distance_bracket || '').trim().toLowerCase()
    const bracket    = BRACKET_MAP[bracketRaw]

    // 7. Precios
    const priceRegular    = parsePrice(row.price_regular_value, maxPrice)
    const priceDiscounted = parsePrice(row.price_discounted_value, maxPrice)

    // Para InDrive: regular = recommended, discounted = minimal_bid
    // Para otros:   regular = price_without_discount, discounted = price_with_discount
    let recommended_price      = null
    let price_without_discount = null
    let price_with_discount    = null
    let minimal_bid            = null

    if (compName === 'InDrive') {
      recommended_price = priceRegular
      minimal_bid       = priceDiscounted
    } else {
      price_without_discount = priceRegular
      price_with_discount    = priceDiscounted
    }

    // 8. Timestamp
    const { date, time } = parseTimestamp(row.timestamp_local)
    if (!date) {
      skipped.push({ row, reason: 'Sin timestamp' })
      continue
    }

    // 9. Surge
    const surgeVal = String(row.surge || '').trim().toUpperCase()
    const surge    = surgeVal === 'TRUE' || surgeVal === '1' || surgeVal === 'YES' || surgeVal === 'SÍ'
      ? true
      : surgeVal === 'FALSE' || surgeVal === '0' || surgeVal === 'NO'
        ? false
        : null

    // 10. ETA
    const eta_min = row.eta_mins !== '' && row.eta_mins !== undefined
      ? parseFloat(row.eta_mins) || null
      : null

    ok.push({
      city:                   dbCity,
      category,
      competition_name,
      observed_date:          date,
      observed_time:          time,
      point_a:                String(row.start_address || '').trim().slice(0, 200) || null,
      point_b:                String(row.end_address   || '').trim().slice(0, 200) || null,
      distance_km:            null,
      distance_bracket:       bracket || null,
      surge,
      recommended_price,
      price_without_discount,
      price_with_discount,
      minimal_bid,
      eta_min,
      zone: null,
      country: activeCountry,
    })
  }

  return { ok, skipped }
}
