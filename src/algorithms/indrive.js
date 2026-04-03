/**
 * Calcula el precio efectivo para una observación.
 *
 * InDrive: si hay al menos un bid > 0, el precio es el promedio de los bids no-cero.
 * Si todos los bids están vacíos/en cero, usa recommended_price.
 * Todos los demás competidores: price_without_discount ?? recommended_price.
 *
 * @param {Object} row — fila de la tabla pricing_observations
 * @returns {number|null}
 */
export function computeEffectivePrice(row) {
  if (row.competition_name === 'InDrive') {
    const bids = [row.bid_1, row.bid_2, row.bid_3, row.bid_4, row.bid_5]
      .map(b => Number(b) || 0)
      .filter(b => b > 0)

    if (bids.length > 0) {
      return bids.reduce((sum, b) => sum + b, 0) / bids.length
    }
    // Sin bids: usar precio recomendado
    return Number(row.recommended_price) || null
  }

  // Competidores estándar
  return Number(row.price_without_discount) || Number(row.recommended_price) || null
}
