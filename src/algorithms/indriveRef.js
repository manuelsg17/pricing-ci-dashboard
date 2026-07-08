/**
 * indriveRef.js
 *
 * Calcula la "referencia reciente" del uplift de InDrive (cuánto suben los bids
 * reales sobre el precio recomendado) a partir del desglose semanal ya cargado
 * (`get_indrive_weekly`), en vez del promedio de toda la historia.
 *
 * Método: por cada semana se toma su "Diferencia %" = (avgBid/avgRec − 1)·100
 * — exactamente el número que muestra la tabla "Por semana" — y se promedia sobre
 * las últimas `weeks` semanas CON datos, PONDERANDO POR OBSERVACIONES:
 *   pct = Σ(pct_w · obs_w) / Σ(obs_w)
 *
 * Se pondera el % semanal (no rec y bid por separado) a propósito: en el RPC
 * `avg_bid` promedia sobre las `obs` filas con bids, pero `avg_rec` excluye
 * outliers (`recommended_price > threshold`), así que agrupar rec y bid por
 * separado con el mismo `obs` sesgaría el resultado cuando la fracción de outliers
 * varía entre semanas. Promediar el % semanal evita ese sesgo y mantiene la Ref.
 * reciente consistente con lo que el usuario ve en la vista "Por semana".
 *
 * Semanas sin avgRec/avgBid válidos (p.ej. solo outliers → avg_rec null) se ignoran.
 */

/**
 * @param {Array<{city:string, category:string, week:string, obs:number|string,
 *                avgRec:number|string|null, avgBid:number|string|null}>} weeklyRows
 * @param {string[]|null} dbCities  ciudades permitidas (o null = todas)
 * @param {number|'all'} weeks      cuántas semanas recientes con datos usar
 * @returns {Record<string, {pct:number|null, obs:number, weeksUsed:string[]}>}
 *          map keyed `${city}|${category}`
 */
export function computeRecentRef(weeklyRows, dbCities, weeks) {
  const allowed = dbCities ? new Set(dbCities) : null
  const groups = new Map()

  for (const r of weeklyRows || []) {
    if (allowed && !allowed.has(r.city)) continue
    const rec = r.avgRec != null ? Number(r.avgRec) : null
    const bid = r.avgBid != null ? Number(r.avgBid) : null
    const obs = Number(r.obs) || 0
    // Solo semanas con ambos promedios válidos y observaciones
    if (
      rec == null ||
      bid == null ||
      !Number.isFinite(rec) ||
      !Number.isFinite(bid) ||
      rec <= 0 ||
      obs <= 0
    ) {
      continue
    }
    const key = `${r.city}|${r.category}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push({ week: String(r.week), obs, pct: (bid / rec - 1) * 100 })
  }

  const out = {}
  for (const [key, rows] of groups) {
    // Orden descendente por semana ISO ("IYYY-Www" ordena lexicográficamente bien)
    rows.sort((a, b) => (a.week < b.week ? 1 : a.week > b.week ? -1 : 0))
    const take = weeks === 'all' ? rows : rows.slice(0, Math.max(1, Number(weeks) || 1))

    let sumObs = 0
    let wPct = 0
    for (const x of take) {
      sumObs += x.obs
      wPct += x.pct * x.obs
    }
    if (sumObs <= 0) continue

    out[key] = { pct: wPct / sumObs, obs: sumObs, weeksUsed: take.map((x) => x.week) }
  }
  return out
}
