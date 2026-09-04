// ════════════════════════════════════════════════════════════════════════
// Filas y payloads de Ingresar CI (src/lib/dataEntry/rows.js).
//
// Protege lo que ya costó bugs reales en producción:
//   · InDrive solo-recomendado SÍ se guarda (v_effective_price cae al rec).
//   · Una celda S/D produce fila no_data=true SIN precio.
//   · zone '' → null (Corp), para no colar una zona "real" en el DELETE.
//   · `timeslot` es la etiqueta ESTABLE del turno, no la hora de captura.
//   · El DELETE se acota a la RUTA EXACTA (incl. point_a/point_b/zone) y
//     solo al TERMINAR suma las rutas cargadas del historial.
//   · Un competidor "no ofrece" (no visible) no entra al acote del DELETE.
// Run: node scripts/test-data-entry-rows.mjs
// ════════════════════════════════════════════════════════════════════════

import {
  buildRowsForSlot,
  buildInsertPayload,
  collectRouteDeletes,
  buildRoutesPayload,
} from '../src/lib/dataEntry/rows.js'
import { timeslotLabel } from '../src/lib/constants.js'

let pass = 0
let fail = 0
const fallos = []
function ok(cond, label) {
  if (cond) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    fallos.push(label)
    console.log(`  ✗ ${label}`)
  }
}

const ref = { id: 7, bracket: 'short', point_a: 'A', point_b: 'B', waze_distance: 3.2, zone: '' }
const ts = { label: 'Mañana', start_time: '09:00:00' }
const base = {
  comps: ['Yango', 'Uber', 'InDrive'],
  uiCat: 'Economy',
  ref,
  ts,
  rush: false,
  year: 2026,
  week: 36,
}

console.log('\nbuildRowsForSlot')
{
  const rows = buildRowsForSlot({
    ...base,
    entries: { 'Economy|7|Mañana|Yango': '10.5', 'Economy|7|Mañana|Uber': '' },
    indriveExtra: {},
    etaEntries: { 'Economy|7|Mañana|Yango': '4' },
    discEntries: { 'Economy|7|Mañana|Yango': '9' },
    naKeys: new Set(),
  })
  ok(
    rows.length === 1 && rows[0].comp === 'Yango',
    'celdas vacías se descartan; queda la que tiene precio'
  )
  ok(
    rows[0].price === 10.5 && rows[0].eta === 4 && rows[0].disc === 9,
    'precio/eta/desc parseados a número'
  )
  ok(rows[0].bids.length === 0 && rows[0].minBid === null, 'no-InDrive: sin bids ni minBid')
}
{
  const rows = buildRowsForSlot({
    ...base,
    entries: {},
    indriveExtra: {
      'Economy|7|Mañana': { rec: '8', bids: ['', '', '', '', '', '9'], minBid: '5' },
    },
    etaEntries: {},
    discEntries: {},
    naKeys: new Set(),
  })
  ok(rows.length === 1 && rows[0].comp === 'InDrive', 'InDrive solo-recomendado SÍ se guarda')
  ok(rows[0].price === null && rows[0].rec === 8, 'sin promedio → price null, rec 8')
  ok(rows[0].bids.length === 5, 'bids capados a 5 (mig 136)')
  ok(rows[0].minBid === '5', 'minBid viaja crudo (se parsea en el payload)')
}
{
  const rows = buildRowsForSlot({
    ...base,
    entries: { 'Economy|7|Mañana|Uber': '99' },
    indriveExtra: {},
    etaEntries: {},
    discEntries: {},
    naKeys: new Set(['Economy|7|Mañana|Uber']),
  })
  ok(
    rows.length === 1 && rows[0].na === true && rows[0].price === null,
    'S/D gana sobre un precio residual: fila no_data sin precio'
  )
}

console.log('\nbuildInsertPayload')
const ctx = {
  dbCity: 'Lima',
  date: '2026-09-04',
  surge: true,
  userEmail: 'ana@x.com',
  country: 'Peru',
  resolveDbCategory: (uiCat) => (uiCat === 'Economy' ? 'Economy/Comfort' : uiCat),
}
{
  const r = {
    price: 10.5,
    comp: 'Uber',
    ref,
    ts,
    uiCat: 'Economy',
    rush: true,
    year: 2026,
    week: 36,
    bids: [],
    minBid: null,
    rec: null,
    eta: 4,
    disc: null,
    na: false,
  }
  const p = buildInsertPayload(r, '14:37', ctx)
  ok(p.category === 'Economy/Comfort', 'categoría resuelta a BD vía ctx.resolveDbCategory')
  ok(p.observed_time === '14:37', 'observed_time = hora REAL de captura')
  ok(
    p.timeslot === timeslotLabel('09:00'),
    'timeslot = etiqueta ESTABLE derivada del start_time del turno'
  )
  ok(p.zone === null, "zone '' → null (Corp no cuela una zona real)")
  ok(
    p.uploaded_by === 'ana@x.com' && p.data_source === 'manual',
    'dueño explícito + data_source manual'
  )
  ok(p.rush_hour === true && p.surge === true && p.no_data === false, 'flags rush/surge/no_data')
  ok(
    p.price_without_discount === 10.5 && p.price_with_discount === null && p.eta_min === 4,
    'precios y eta'
  )
  ok(
    p.distance_km === 3.2 &&
      p.point_a === 'A' &&
      p.point_b === 'B' &&
      p.distance_bracket === 'short',
    'ruta completa'
  )
  ok(
    !('bid_1' in p) && !('recommended_price' in p) && !('minimal_bid' in p),
    'no-InDrive: sin columnas de bids'
  )
  ok(
    p.country === 'Peru' && p.city === 'Lima' && p.observed_date === '2026-09-04',
    'país/ciudad/fecha del contexto'
  )
}
{
  const r = {
    price: null,
    comp: 'InDrive',
    ref,
    ts,
    uiCat: 'Economy',
    rush: false,
    year: 2026,
    week: 36,
    bids: ['7', 'x', '', '9'],
    minBid: '5',
    rec: 8,
    eta: null,
    disc: null,
    na: false,
  }
  const p = buildInsertPayload(r, '14:37', ctx)
  ok(
    p.bid_1 === 7 && p.bid_4 === 9 && !('bid_2' in p) && !('bid_3' in p),
    'bids: se conserva la POSICIÓN, los inválidos se saltan'
  )
  ok(p.minimal_bid === 5 && p.recommended_price === 8, 'minBid y recomendado en sus columnas')
  ok(
    p.price_without_discount === null,
    'rec-only: sin precio (v_effective_price usa recommended_price)'
  )
}
{
  const r = {
    price: null,
    comp: 'Uber',
    ref,
    ts,
    uiCat: 'Economy',
    rush: false,
    year: 2026,
    week: 36,
    bids: [],
    minBid: null,
    rec: null,
    eta: null,
    disc: null,
    na: true,
  }
  const p = buildInsertPayload(r, '14:37', { ...ctx, userEmail: '' })
  ok(p.no_data === true && p.price_without_discount === null, 'S/D → no_data=true sin precio')
  ok(p.uploaded_by === null, 'sin email → uploaded_by null (legacy)')
}

console.log('\ncollectRouteDeletes')
const refB = { id: 8, bracket: 'short', point_a: 'C', point_b: 'D', zone: null }
const tsTarde = { label: 'Tarde', start_time: '14:00:00' }
const mk = (r, t, comp = 'Yango') => ({ uiCat: 'Economy', ref: r, ts: t, comp })
const resolveDbCategory = () => 'Economy/Comfort'
{
  const dels = collectRouteDeletes(
    [mk(ref, ts), mk(ref, ts, 'Uber'), mk(refB, ts), mk(ref, tsTarde)],
    {
      isFinish: false,
      loadedCombos: null,
      resolveDbCategory,
    }
  )
  ok(dels.size === 3, 'dedupe por ruta exacta: 2 competidores de la misma ruta = 1 descriptor')
  const vals = [...dels.values()]
  ok(
    vals.every(
      (v) => v.timeslot === timeslotLabel('09:00') || v.timeslot === timeslotLabel('14:00')
    ),
    'timeslot = etiqueta estable'
  )
  ok(vals.find((v) => v.pa === 'A').zone === null, "zone '' → null en el descriptor")
  ok(
    vals.some((v) => v.pa === 'A') && vals.some((v) => v.pa === 'C'),
    'mismo bracket, distintos puntos → dos rutas (no se pisa la hermana)'
  )
}
{
  const loaded = new Map([
    [
      'x',
      {
        uiCat: 'Economy',
        dbCat: 'Economy/Comfort',
        timeslot: timeslotLabel('09:00'),
        bracket: 'long',
        pa: 'Z',
        pb: 'W',
      },
    ],
  ])
  const progreso = collectRouteDeletes([mk(ref, ts)], {
    isFinish: false,
    loadedCombos: loaded,
    resolveDbCategory,
  })
  const terminar = collectRouteDeletes([mk(ref, ts)], {
    isFinish: true,
    loadedCombos: loaded,
    resolveDbCategory,
  })
  ok(progreso.size === 1, 'Guardar progreso NO suma las rutas cargadas del historial')
  ok(terminar.size === 2, 'Terminar SÍ las suma (para borrar las que el hub vació)')
  ok([...terminar.values()].find((v) => v.pa === 'Z').zone === null, 'combo sin zone → zone null')
}

console.log('\nbuildRoutesPayload')
{
  const dels = collectRouteDeletes([mk(ref, ts)], {
    isFinish: false,
    loadedCombos: null,
    resolveDbCategory,
  })
  const payload = buildRoutesPayload(dels, {
    competitorsFor: () => ['Yango', 'Uber'],
    dbCity: 'Lima',
  })
  ok(payload.length === 1, 'una ruta → un elemento')
  const rt = payload[0]
  ok(
    rt.category === 'Economy/Comfort' &&
      rt.bracket === 'short' &&
      rt.point_a === 'A' &&
      rt.point_b === 'B',
    'campos de ruta exacta'
  )
  ok(rt.timeslot === timeslotLabel('09:00'), 'timeslot estable')
  ok(rt.competitors.length === 2, 'competidores visibles normalizados')
  const vacio = buildRoutesPayload(dels, { competitorsFor: () => [], dbCity: 'Lima' })
  ok(
    vacio.length === 0,
    'sin competidores visibles → la ruta NO entra al DELETE (conserva histórico de "no ofrece")'
  )
  const sinUiCat = new Map([
    [
      'k',
      {
        uiCat: null,
        dbCat: 'X',
        timeslot: 'Morning',
        bracket: 'short',
        pa: null,
        pb: null,
        zone: null,
      },
    ],
  ])
  ok(
    buildRoutesPayload(sinUiCat, { competitorsFor: () => ['Yango'], dbCity: 'Lima' }).length === 0,
    'sin uiCat → sin competidores → fuera'
  )
}

console.log(`\n${pass} ok, ${fail} fallos`)
if (fail) {
  console.log(fallos.map((f) => `  - ${f}`).join('\n'))
  process.exit(1)
}
