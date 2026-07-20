// Lógica de promedio InDrive, compartida entre InDriveCell.jsx (input en
// vivo) y DataEntry.jsx (restauración de borrador) — antes vivía duplicada
// en ambos archivos, con el riesgo real de que un fix se aplicara en uno y
// no en el otro (pasó con el fix de "el mínimo no entra al promedio").

// El promedio se calcula SOLO con los bids — el mínimo es un dato de
// referencia aparte (se guarda en minimal_bid), nunca entra al promedio.
export function calcIndriveAvg(bids) {
  const nums = (bids || []).map((b) => parseFloat(b)).filter((n) => !isNaN(n) && n > 0)
  if (!nums.length) return ''
  return (nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(2)
}

// Mig 98: bid_4/bid_5 dropeados de pricing_observations. Un borrador guardado
// en localStorage antes de este fix puede traer hasta 5 bids — se truncan a
// 3 al restaurar (y se recalcula el promedio) para que la UI no muestre algo
// que el guardado va a cortar silenciosamente.
export function capIndriveExtraBids(indriveExtra) {
  const capped = {}
  const avgUpdates = {}
  for (const [key, extra] of Object.entries(indriveExtra || {})) {
    const bids = (extra?.bids || []).slice(0, 3)
    capped[key] = { ...extra, bids }
    avgUpdates[`${key}|InDrive`] = calcIndriveAvg(bids)
  }
  return { capped, avgUpdates }
}
