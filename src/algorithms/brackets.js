/**
 * Asigna el bracket de distancia del lado del cliente.
 * Usado en el preview de Upload antes de que el trigger de BD lo asigne.
 *
 * @param {number} distanceKm
 * @param {Array}  thresholds — filas de distance_thresholds ya filtradas
 *                              por city+category, en cualquier orden
 * @returns {string}
 */
export function assignBracket(distanceKm, thresholds) {
  if (!thresholds || thresholds.length === 0) return 'unknown'

  // Ordenar ascendentemente por max_km, con NULL al final
  const sorted = [...thresholds].sort((a, b) => {
    if (a.max_km === null) return 1
    if (b.max_km === null) return -1
    return a.max_km - b.max_km
  })

  for (const t of sorted) {
    if (t.max_km === null || Number(distanceKm) <= Number(t.max_km)) {
      return t.bracket
    }
  }

  return 'very_long'
}
