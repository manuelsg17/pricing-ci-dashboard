// ════════════════════════════════════════════════════════════════════════
// Conteos de Ingresar CI (src/lib/dataEntry/draftCounts.js).
//
// Estas funciones son la fuente ÚNICA de verdad para el pill de progreso, el
// conteo del borrador restaurado y el escaneo de "borradores sin terminar".
// Cuando divergieron (rec-only de InDrive contado en un lado y no en otro) un
// borrador válido no se restauraba y el recomendado se perdía en silencio.
// Run: node scripts/test-data-entry-counts.mjs
// ════════════════════════════════════════════════════════════════════════

import {
  countFilledEntries,
  hasMeaningfulIndriveExtra,
  countAllFilled,
  earliestTurnoStart,
  countFilledByTimeslot,
} from '../src/lib/dataEntry/draftCounts.js'

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

console.log('\ncountFilledEntries')
ok(countFilledEntries({}) === 0, 'vacío → 0')
ok(countFilledEntries(null) === 0, 'null → 0 (no rompe)')
ok(countFilledEntries({ a: '12', b: '' }) === 1, "celda tipeada y borrada ('') NO cuenta")
ok(countFilledEntries({ a: 'abc', b: '3.5' }) === 1, 'texto no numérico no cuenta')
ok(countFilledEntries({ a: '0' }) === 1, "'0' es un número real y cuenta")

console.log('\nhasMeaningfulIndriveExtra')
ok(hasMeaningfulIndriveExtra({}) === false, 'vacío → false')
ok(
  hasMeaningfulIndriveExtra({ k: { bids: ['', ''], minBid: '', rec: '' } }) === false,
  'todo en blanco → false'
)
ok(hasMeaningfulIndriveExtra({ k: { bids: ['', '7'] } }) === true, 'un bid → true')
ok(hasMeaningfulIndriveExtra({ k: { rec: '9' } }) === true, 'solo recomendado → true')
ok(hasMeaningfulIndriveExtra({ k: { minBid: '4' } }) === true, 'solo minBid → true')

console.log('\ncountAllFilled')
const entries = { 'E|1|Mañana|Yango': '10', 'E|1|Mañana|InDrive': '' }
ok(countAllFilled(entries, {}) === 1, 'sin indriveExtra: cuenta solo entries')
ok(
  countAllFilled(entries, { 'E|1|Mañana': { rec: '8' } }) === 2,
  'InDrive solo-recomendado (sin promedio) suma 1'
)
ok(
  countAllFilled({ ...entries, 'E|1|Mañana|InDrive': '8.5' }, { 'E|1|Mañana': { rec: '8' } }) === 2,
  'InDrive con promedio Y recomendado no se cuenta dos veces'
)
ok(countAllFilled(entries, { 'E|1|Mañana': { rec: '' } }) === 1, 'rec vacío no suma')
ok(countAllFilled(entries, { 'E|1|Mañana': { rec: 'x' } }) === 1, 'rec no numérico no suma')

console.log('\nearliestTurnoStart')
ok(earliestTurnoStart(null) === null, 'null → null')
ok(earliestTurnoStart({}) === null, 'sin turnos → null')
ok(
  earliestTurnoStart({ Mañana: { endedAt: '2026-07-24T12:00:00Z' } }) === null,
  'sin startedAt → null'
)
ok(
  earliestTurnoStart({
    Tarde: { startedAt: '2026-07-24T13:00:00Z' },
    Mañana: { startedAt: '2026-07-24T09:00:00Z' },
  }) === Date.parse('2026-07-24T09:00:00Z'),
  'devuelve el startedAt más antiguo (no el primero en el objeto)'
)
ok(
  earliestTurnoStart({ A: { startedAt: 'basura' }, B: { startedAt: '2026-07-24T09:00:00Z' } }) ===
    Date.parse('2026-07-24T09:00:00Z'),
  'un timestamp inválido se ignora en vez de romper'
)

console.log('\ncountFilledByTimeslot')
const timeslots = [{ label: 'Mañana' }, { label: 'Tarde' }]
const byTs = countFilledByTimeslot(
  { 'E|1|Mañana|Yango': '10', 'E|1|Tarde|Yango': '', 'E|1|Noche|Yango': '5' },
  { 'E|1|Tarde': { rec: '7' }, 'E|1|Mañana': { rec: '7' } },
  new Set(['E|2|Tarde|Uber']),
  timeslots
)
ok(byTs.Mañana === 2, 'Mañana: precio Yango + rec-only de InDrive = 2')
ok(byTs.Tarde === 2, 'Tarde: rec-only de InDrive + una celda S/D')
ok(!('Noche' in byTs), 'una franja fuera del set de timeslots no aparece')
// Mañana tiene rec sin promedio de InDrive → debería sumar 1 más.
const byTs2 = countFilledByTimeslot({}, { 'E|1|Mañana': { rec: '7' } }, new Set(), timeslots)
ok(byTs2.Mañana === 1 && byTs2.Tarde === 0, 'rec-only suma en su franja y solo ahí')
const byTs3 = countFilledByTimeslot(
  { 'E|1|Mañana|InDrive': '7' },
  { 'E|1|Mañana': { rec: '7' } },
  new Set(),
  timeslots
)
ok(byTs3.Mañana === 1, 'InDrive con promedio y rec cuenta una sola vez por franja')

console.log(`\n${pass} ok, ${fail} fallos`)
if (fail) {
  console.log(fallos.map((f) => `  - ${f}`).join('\n'))
  process.exit(1)
}
