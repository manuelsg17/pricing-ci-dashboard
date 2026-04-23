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

// App del CSV → clave de regla (botRules.app). Se mantiene 'Yango' como
// competition_name por defecto si la regla no lo sobrescribe.
const APP_KEY_MAP = {
  uber:      'uber',
  yango:     'yango',
  yango_api: 'yango',
  didi:      'didi',
  indrive:   'indrive',
  cabify:    'cabify',
}

// competition_name por defecto cuando no se usan reglas (fallback legacy)
const APP_MAP = {
  uber:      'Uber',
  yango:     'Yango',
  yango_api: 'Yango',
  didi:      'Didi',
  indrive:   'InDrive',
  cabify:    'Cabify',
}

// ── Legacy path (países sin botRules) ─────────────────────
// vehicle_category del bot: economy, comfort, premium, tuktuk, xl, moto, taxi, courier, etc.
const VEHICLE_CATEGORY_MAP = {
  economy:  'Economy',
  comfort:  'Comfort',
  premium:  'Comfort',
  tuktuk:   'TukTuk',
  xl:       'XL',
}

const LEGACY_VALID_CATEGORIES = new Set(['Economy', 'Comfort', 'Premier', 'TukTuk', 'XL', 'Corp'])

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
 * Resuelve (competition_name, category) usando botRules del país activo.
 * Devuelve null si ninguna regla calza (fila omitida).
 */
function resolveByRules(rules, { appKey, vcRaw, ovcRaw, dbCity }) {
  for (const r of rules) {
    if (r.app !== appKey) continue
    if (r.vc  !== vcRaw)  continue
    if (r.ovc !== '*' && r.ovc !== ovcRaw) continue
    if (r.cities && !r.cities.includes(dbCity)) continue
    return { competition_name: r.name, category: r.category }
  }
  return null
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
  const botRules = Array.isArray(config.botRules) ? config.botRules : null
  const competitorsByDbCC = config.competitorsByDbCityCategory || {}
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

    // 2. App → clave de regla (y fallback competition_name)
    const appRaw = String(row.app || '').trim().toLowerCase()
    const appKey = APP_KEY_MAP[appRaw]
    if (!appKey) {
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

    // 4. Resolver (competition_name, category)
    const vcRaw  = String(row.vehicle_category || '').trim().toLowerCase()
    // Null/empty ovc se trata como '*' para que matchee reglas wildcard (ej: TukTuk)
    const ovcRaw = row.observed_vehicle_category
      ? String(row.observed_vehicle_category).trim().toLowerCase()
      : '*'

    let competition_name = null
    let category = null

    if (botRules) {
      const match = resolveByRules(botRules, { appKey, vcRaw, ovcRaw, dbCity })
      if (!match) {
        skipped.push({ row, reason: `Sin regla: ${appRaw}/${vcRaw}/${ovcRaw} en ${dbCity}` })
        continue
      }
      competition_name = match.competition_name
      category = match.category

      // Validar contra competitorsByDbCityCategory (si existe)
      const allowed = competitorsByDbCC?.[dbCity]?.[category]
      if (!allowed) {
        skipped.push({ row, reason: `Categoría ${category} no existe en ${dbCity}` })
        continue
      }
    } else {
      // Legacy path: vehicle_category → category (sin observed)
      category = VEHICLE_CATEGORY_MAP[vcRaw]
      if (!category || !LEGACY_VALID_CATEGORIES.has(category)) {
        skipped.push({ row, reason: `Categoría omitida: ${row.vehicle_category}` })
        continue
      }
      competition_name = APP_MAP[appRaw]
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

    if (appKey === 'indrive') {
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
