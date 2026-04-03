import { BRACKETS } from '../lib/constants'

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
 * Si no hay pesos para la ciudad, usa los pesos globales ('all').
 *
 * @param {Array}  dbWeights — filas de bracket_weights
 * @param {string} city
 * @returns {Object} { very_short: 0.0983, ... }
 */
export function buildWeightsMap(dbWeights, city) {
  const cityWeights = dbWeights.filter(w => w.city === city)
  const allWeights  = dbWeights.filter(w => w.city === 'all')

  const source = cityWeights.length > 0 ? cityWeights : allWeights

  return source.reduce((acc, w) => {
    acc[w.bracket] = Number(w.weight)
    return acc
  }, {})
}
