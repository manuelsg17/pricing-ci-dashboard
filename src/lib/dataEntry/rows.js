import { normalizeCompetitorName } from '../normalize.js'
import { timeslotLabel } from '../constants.js'
import { priceKey, indKey } from './keys.js'

// Armado de filas y payloads de Ingresar CI (sin React). Extraído de
// DataEntry.jsx (2026-09) sin cambiar ni un campo: cada fila que sale de acá
// es exactamente la que antes armaba el componente inline.

// Filas de una (categoría, ruta, franja) a partir de la rebanada del bucket.
// Se descartan las celdas sin dato. Excepciones que SÍ se guardan: InDrive
// con solo el recomendado (su precio efectivo es el recomendado) y las celdas
// marcadas "sin data" (fila no_data=true).
export function buildRowsForSlot({
  comps,
  uiCat,
  ref,
  ts,
  rush,
  year,
  week,
  entries,
  indriveExtra,
  etaEntries,
  discEntries,
  naKeys,
}) {
  return comps
    .map((comp) => {
      // Celda "sin data" (S/D): fila no_data=true, sin precio ni nada más.
      if (naKeys.has(priceKey(uiCat, ref.id, ts.label, comp))) {
        return {
          price: null,
          comp,
          ref,
          ts,
          uiCat,
          rush,
          year,
          week,
          bids: [],
          minBid: null,
          rec: null,
          eta: null,
          disc: null,
          na: true,
        }
      }
      const raw = entries[priceKey(uiCat, ref.id, ts.label, comp)] ?? ''
      const price = parseFloat(raw)
      const extra = indriveExtra[indKey(uiCat, ref.id, ts.label)]
      // Mig 136: pricing_observations vuelve a tener bid_1..bid_5 → hasta 5
      // bids. Guarda por si un borrador trajera más (nunca debería).
      const bids = comp === 'InDrive' ? (extra?.bids || []).slice(0, 5) : []
      const minBid = comp === 'InDrive' ? extra?.minBid || null : null
      // Precio recomendado por la app de InDrive → recommended_price. NO entra
      // al promedio de bids. Si no hay bids, el precio efectivo cae al
      // recomendado (v_effective_price), por eso una celda solo-recomendado
      // igual debe guardarse (ver filtro de abajo).
      const recNum = comp === 'InDrive' ? parseFloat(extra?.rec ?? '') : NaN
      const etaNum = parseFloat(etaEntries[priceKey(uiCat, ref.id, ts.label, comp)] ?? '')
      const discNum = parseFloat(discEntries[priceKey(uiCat, ref.id, ts.label, comp)] ?? '')
      return {
        price: isNaN(price) ? null : price,
        comp,
        ref,
        ts,
        uiCat,
        rush,
        year,
        week,
        bids,
        minBid,
        rec: isNaN(recNum) ? null : recNum,
        eta: isNaN(etaNum) ? null : etaNum,
        disc: isNaN(discNum) ? null : discNum,
        na: false,
      }
    })
    .filter((r) => r.na || r.price !== null || r.rec !== null)
}

// Fila de `pricing_observations` para una celda. `ctx`:
//   dbCity, date, surge, userEmail, country, resolveDbCategory(uiCat)
export function buildInsertPayload(r, capturedTime, ctx) {
  const { dbCity, date, surge, userEmail, country, resolveDbCategory } = ctx
  const base = {
    city: dbCity,
    category: resolveDbCategory(r.uiCat),
    // Normalización context-aware: en city='Corp' el canónico usa espacios
    // ('Yango Comfort'), en E/C es pegado ('YangoComfort'). r.comp ya viene
    // canónico del catálogo; normalize es idempotente (defensa en profundidad).
    competition_name: normalizeCompetitorName(r.comp, { city: dbCity }),
    observed_date: date,
    // Hora REAL de captura (mig 148): una sola marca por click de guardado,
    // igual para todas las filas. `timeslot` identifica el turno.
    observed_time: capturedTime,
    // Turno ESTABLE (mig 148): deriva de la hora CANÓNICA del timeslot, nunca
    // de observed_time — así el DELETE-antes-de-INSERT y el reload siguen
    // encontrando la fila sin importar a qué hora real se guardó.
    timeslot: timeslotLabel(r.ts.start_time?.slice(0, 5)),
    rush_hour: r.rush,
    surge,
    distance_bracket: r.ref.bracket,
    distance_km: r.ref.waze_distance ?? null,
    eta_min: r.eta ?? null,
    point_a: r.ref.point_a ?? null,
    point_b: r.ref.point_b ?? null,
    // Distrito (solo TukTuk). '' → null: las filas nuevas de Corp quedan
    // zone=NULL, igual que las ~17k filas históricas.
    zone: r.ref.zone || null,
    price_without_discount: r.price,
    price_with_discount: r.disc ?? null,
    year: r.year,
    week: r.week,
    data_source: 'manual',
    // Dueño de la fila: el hub que la cargó (mig 139). Legacy = null.
    uploaded_by: userEmail || null,
    // "Sin data" (S/D): sin precio → no ensucia promedios.
    no_data: r.na || false,
    country,
  }
  if (r.comp === 'InDrive') {
    r.bids.forEach((b, i) => {
      const n = parseFloat(b)
      if (!isNaN(n)) base[`bid_${i + 1}`] = n
    })
    const mn = parseFloat(r.minBid)
    if (!isNaN(mn)) base.minimal_bid = mn
    // Recomendado en su columna propia (NO en un bid, para no sesgar el
    // promedio). Si no hay bids, v_effective_price cae a recommended_price.
    if (r.rec != null) base.recommended_price = r.rec
  }
  return base
}

// Descriptores de RUTA EXACTA a limpiar antes de re-insertar (CLAUDE.md §2:
// DELETE + INSERT por ruta exacta, nunca por categoría/franja completa —
// varias rutas comparten categoría+bracket y difieren solo en los puntos,
// p.ej. TukTuk por distrito). Solo al TERMINAR se suman las rutas cargadas
// del historial (`loadedCombos`), para borrar las que el hub vació tras
// reabrir; "Guardar progreso" nunca borra una ruta que no se re-guarda.
const SEP = '\u0001' // separador que no aparece en direcciones/coords

export function collectRouteDeletes(rowsToInsert, { isFinish, loadedCombos, resolveDbCategory }) {
  const routeDels = new Map()
  const addRoute = (uiCat, dbCat, timeslot, bracket, pa, pb, rz) => {
    const k = [dbCat, timeslot, bracket, pa ?? '', pb ?? '', rz ?? ''].join(SEP)
    if (!routeDels.has(k))
      routeDels.set(k, {
        uiCat,
        dbCat,
        timeslot,
        bracket,
        pa: pa ?? null,
        pb: pb ?? null,
        zone: rz ?? null,
      })
  }
  for (const r of rowsToInsert) {
    addRoute(
      r.uiCat,
      resolveDbCategory(r.uiCat),
      // Etiqueta ESTABLE del turno (mig 148), no la hora real de captura.
      timeslotLabel(r.ts.start_time?.slice(0, 5)),
      r.ref.bracket,
      r.ref.point_a,
      r.ref.point_b,
      // '' → null: rutas de Corp con zone='' no deben colarse como zona real.
      r.ref.zone || null
    )
  }
  if (isFinish && loadedCombos) {
    for (const c of loadedCombos.values())
      addRoute(c.uiCat, c.dbCat, c.timeslot, c.bracket, c.pa, c.pb, c.zone ?? null)
  }
  return routeDels
}

// p_routes de save_ci_batch (migs 182/186). Los competidores VISIBLES se
// calculan en el cliente (dependen de la config, getCiCompetitors/ciHidden);
// un competidor "no ofrece" conserva su histórico porque no entra al acote.
export function buildRoutesPayload(routeDels, { competitorsFor, dbCity }) {
  return (
    Array.from(routeDels.values())
      .map((rt) => ({
        category: rt.dbCat,
        timeslot: rt.timeslot,
        bracket: rt.bracket,
        point_a: rt.pa,
        point_b: rt.pb,
        competitors: (rt.uiCat ? competitorsFor(rt.uiCat) : []).map((c) =>
          normalizeCompetitorName(c, { city: dbCity })
        ),
      }))
      // Sin competidores visibles no hay nada que borrar.
      .filter((rt) => rt.competitors.length > 0)
  )
}
