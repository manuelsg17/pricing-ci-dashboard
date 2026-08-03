/**
 * `NULL` de la base ⇄ JS. Un `''` que viene de un Excel parseado es una celda
 * vacía, o sea un NULL, NO un cero — `Number('')` da 0 y eso rompería el
 * COALESCE de abajo.
 */
function col(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isNaN(n) ? null : n
}

/**
 * Calcula el precio efectivo para una observación.
 *
 * ES UN ESPEJO EXACTO de la vista `v_effective_price` en SQL, y esa es toda su
 * razón de ser: el dashboard agrega con la vista y el cliente muestra con esta
 * función, así que cualquier diferencia entre las dos se ve como un número que
 * no cuadra con el que lo explica.
 *
 *     CASE WHEN competition_name = 'InDrive'
 *            AND (coalesce(bid_1,0)+…+coalesce(bid_5,0)) > 0
 *          THEN (coalesce(nullif(bid_1,0),0)+…) / (cantidad de bids > 0)
 *          ELSE COALESCE(price_without_discount, recommended_price)
 *     END
 *
 * DOS DIVERGENCIAS QUE TENÍA esta función y que el SQL no (corregidas acá):
 *
 *  1. Para InDrive SIN bids caía a `recommended_price` a secas. El SQL cae al
 *     `COALESCE(price_without_discount, recommended_price)` completo — o sea que
 *     una fila de InDrive con precio cargado a mano y sin bids valía una cosa en
 *     el agregado y otra en la preview del Upload.
 *  2. Usaba `Number(x) || Number(y)`, que es un OR de falsy, no un COALESCE: un
 *     precio de exactamente 0 se saltaba al siguiente campo en vez de quedarse
 *     en 0.
 *
 * Mig 136 (2026-07-20): bid_4/bid_5 re-agregados — el promedio va sobre bid_1..5.
 *
 * @param {Object} row — fila de pricing_observations (o su equivalente parseado)
 * @returns {number|null}
 */
export function computeEffectivePrice(row) {
  const pwd = col(row.price_without_discount)
  const rec = col(row.recommended_price)
  // COALESCE de verdad: se queda con el primero NO NULO, aunque valga 0.
  const fallback = pwd != null ? pwd : rec

  if (row.competition_name === 'InDrive') {
    const bids = [row.bid_1, row.bid_2, row.bid_3, row.bid_4, row.bid_5].map((b) => col(b) ?? 0)
    // El SQL abre la rama con la suma de TODOS los bids (coalesce a 0), no con
    // "hay alguno positivo". Con bids sanos es lo mismo; se replica igual para
    // que no exista un dato capaz de separarlas.
    const suma = bids.reduce((a, b) => a + b, 0)
    if (suma > 0) {
      const cuantos = bids.filter((b) => b > 0).length
      // `nullif(bid,0)` solo saca los ceros: el numerador sigue siendo la suma
      // completa, el denominador cuenta los estrictamente positivos.
      return cuantos > 0 ? suma / cuantos : null
    }
  }

  return fallback
}
