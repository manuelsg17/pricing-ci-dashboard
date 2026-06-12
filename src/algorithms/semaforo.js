/**
 * Calcula el delta porcentual de un competidor vs Yango.
 * Positivo = el competidor cobra más que Yango.
 * Fórmula Excel: (precioCompetidor / precioYango) - 1
 *
 * @param {number} competitorPrice
 * @param {number} yangoPrice
 * @returns {number|null}
 */
export function computeDelta(competitorPrice, yangoPrice) {
  if (!yangoPrice || yangoPrice <= 0 || !competitorPrice) return null
  return (competitorPrice / yangoPrice - 1) * 100
}

/**
 * Retorna la clase CSS de semáforo según el delta %.
 *
 * Verde:    5% ≤ delta ≤ 10%
 * Amarillo: 1% ≤ delta < 5%  O  10% < delta ≤ 12%
 * Rojo:     todo lo demás (incluyendo negativos)
 *
 * @param {number|null} deltaPct
 * @returns {'sem-green'|'sem-yellow'|'sem-red'|'sem-none'}
 */
export function getSemaforoClass(deltaPct) {
  if (deltaPct === null || deltaPct === undefined) return 'sem-none'
  const d = Number(deltaPct)
  if (d >= 5 && d <= 10) return 'sem-green'
  if ((d >= 1 && d < 5) || (d > 10 && d <= 12)) return 'sem-yellow'
  return 'sem-red'
}
