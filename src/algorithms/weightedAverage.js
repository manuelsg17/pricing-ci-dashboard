// Extensión .js explícita para que Node ESM strict (CI) pueda resolver.
// Vite resuelve sin extensión, pero `node scripts/test-*.mjs` no.
import { BRACKETS } from '../lib/constants.js'

/**
 * Calcula el Promedio Ponderado para un competidor en un período dado.
 *
 * REGLA DE EXCLUSIÓN: si un bracket tiene precio null, 0 o <= 1,
 * ese bracket Y su peso son ignorados completamente.
 * Esto evita que datos faltantes bajen el precio promedio.
 *
 * @param {Object} bracketPrices  — { very_short: 12.5, short: 14.0, ... }
 * @param {Object} bracketWeights — { very_short: 0.0983, short: 0.1967, ... }
 * @returns {number|null}
 */
export function computeWeightedAvg(bracketPrices, bracketWeights) {
  let weightedSum = 0
  let totalWeight = 0

  for (const bracket of BRACKETS) {
    const price  = bracketPrices?.[bracket]
    const weight = bracketWeights?.[bracket] ?? 0

    // Exclusión: vacío, 0 o <= 1 (igual que SI(Y(K16<>"",K16<>0,K16<>1)) del Excel)
    if (price === null || price === undefined || Number(price) <= 1) continue

    weightedSum += Number(price) * weight
    totalWeight += weight
  }

  if (totalWeight === 0) return null
  return weightedSum / totalWeight
}

/**
 * Construye un mapa de pesos desde el array de bracket_weights de la BD.
 *
 * Cascada (espejo de freeze_pricing_wa SQL mig 56):
 *   1. (city, category)   — match exacto
 *   2. (city, 'all')      — misma ciudad, peso global de categoría
 *   3. ('all', category)  — peso global de city, categoría exacta
 *   4. ('all', 'all')     — fallback global del país
 *
 * Si category no se pasa (legacy callers), trata como 'all' → mismo
 * comportamiento que antes de mig 56.
 *
 * @param {Array}  dbWeights — filas de bracket_weights con shape
 *                              { city, category, bracket, weight }
 * @param {string} city
 * @param {string} [category]  — opcional, default 'all'
 * @returns {Object} { very_short: 0.0983, ... }
 */
export function buildWeightsMap(dbWeights, city, category = 'all') {
  if (!Array.isArray(dbWeights) || dbWeights.length === 0) return {}

  // Filas existentes pueden no tener `category` (pre mig 56) — tratamos
  // como 'all' para retrocompat.
  const cat = (row) => row.category ?? 'all'

  const tryFilter = (cityMatch, categoryMatch) =>
    dbWeights.filter(w => cityMatch(w.city) && categoryMatch(cat(w)))

  // Probamos cada nivel en orden
  const candidates = [
    tryFilter(c => c === city, c => c === category),       // (1) exact
    tryFilter(c => c === city, c => c === 'all'),          // (2) all categoría
    tryFilter(c => c === 'all', c => c === category),      // (3) all city
    tryFilter(c => c === 'all', c => c === 'all'),         // (4) global
  ]

  const source = candidates.find(arr => arr.length > 0) || []
  return source.reduce((acc, w) => {
    acc[w.bracket] = Number(w.weight)
    return acc
  }, {})
}
