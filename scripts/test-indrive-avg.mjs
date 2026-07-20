#!/usr/bin/env node
// Tests para src/lib/indriveAvg.js — promedio de InDrive (solo bids, el
// mínimo NUNCA entra) y el tope de 3 bids al restaurar un borrador viejo
// (mig 98: bid_4/bid_5 dropeados de pricing_observations).
//
// Run: node scripts/test-indrive-avg.mjs

import { calcIndriveAvg, capIndriveExtraBids } from '../src/lib/indriveAvg.js'

let pass = 0,
  fail = 0,
  failures = []
function assert(cond, label) {
  if (cond) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    failures.push(label)
    console.log(`  ✗ ${label}`)
  }
}

console.log('\n══ indriveAvg tests ══')

{
  console.log('\n[1] calcIndriveAvg: promedio simple de bids válidos')
  assert(calcIndriveAvg(['10', '20']) === '15.00', "['10','20'] → '15.00'")
  assert(calcIndriveAvg(['9.5', '10.5', '11']) === '10.33', "3 bids → '10.33'")
}

{
  console.log('\n[2] calcIndriveAvg: bids vacíos/inválidos se ignoran, no rompen el promedio')
  assert(calcIndriveAvg(['10', '', '20']) === '15.00', "bid vacío en el medio se ignora")
  assert(calcIndriveAvg(['abc', '10']) === '10.00', "bid no-numérico se ignora")
  assert(calcIndriveAvg(['0', '10']) === '10.00', "bid = 0 se ignora (no es un bid real)")
  assert(calcIndriveAvg(['-5', '10']) === '10.00', "bid negativo se ignora")
}

{
  console.log('\n[3] calcIndriveAvg: sin bids válidos → string vacío (no NaN, no crashea)')
  assert(calcIndriveAvg([]) === '', "[] → ''")
  assert(calcIndriveAvg(['', '']) === '', "['','' ] → ''")
  assert(calcIndriveAvg(null) === '', "null → '' (no crashea)")
  assert(calcIndriveAvg(undefined) === '', "undefined → '' (no crashea)")
}

{
  console.log('\n[4] calcIndriveAvg: el mínimo NUNCA debe pasarse como si fuera un bid más')
  // Antes del fix, minBid se sumaba al array de bids como un elemento extra
  // y arrastraba el promedio hacia abajo/arriba sin que fuera un bid real.
  const bids = ['20', '22']
  const minBidAsIfBid = ['20', '22', '5'] // simula el bug viejo
  assert(calcIndriveAvg(bids) === '21.00', "promedio real de los bids = 21.00")
  assert(
    calcIndriveAvg(minBidAsIfBid) !== calcIndriveAvg(bids),
    "colar el mínimo en el array SÍ cambia el resultado — probando que la función no debe recibirlo nunca"
  )
}

{
  console.log('\n[5] capIndriveExtraBids: trunca a 3 bids y recalcula el promedio')
  const indriveExtra = {
    'Economy/Comfort|1|Mañana': { bids: ['10', '10', '10', '40', '50'], minBid: '5' },
  }
  const { capped, avgUpdates } = capIndriveExtraBids(indriveExtra)
  assert(
    capped['Economy/Comfort|1|Mañana'].bids.length === 3,
    "se truncan 5 bids a 3"
  )
  assert(
    JSON.stringify(capped['Economy/Comfort|1|Mañana'].bids) === JSON.stringify(['10', '10', '10']),
    "conserva los primeros 3, descarta bid_4 y bid_5"
  )
  assert(
    capped['Economy/Comfort|1|Mañana'].minBid === '5',
    "minBid no se toca al capear bids"
  )
  assert(
    avgUpdates['Economy/Comfort|1|Mañana|InDrive'] === '10.00',
    "el promedio se recalcula SOLO con los 3 bids que quedaron (10.00), no con los 5 originales"
  )
}

{
  console.log('\n[6] capIndriveExtraBids: borrador ya con 3 o menos bids queda intacto')
  const indriveExtra = {
    key1: { bids: ['15', '25'], minBid: '' },
  }
  const { capped, avgUpdates } = capIndriveExtraBids(indriveExtra)
  assert(capped.key1.bids.length === 2, "2 bids no se tocan")
  assert(avgUpdates['key1|InDrive'] === '20.00', "promedio correcto sin truncar nada")
}

{
  console.log('\n[7] capIndriveExtraBids: robustez ante indriveExtra vacío/null')
  assert(JSON.stringify(capIndriveExtraBids({}).capped) === '{}', "{} → capped {}")
  assert(JSON.stringify(capIndriveExtraBids(null).capped) === '{}', "null → capped {} (no crashea)")
}

console.log(`\nResultado: ${pass} pasados / ${fail} fallidos`)
if (fail > 0) {
  console.log('\nFallidos:')
  failures.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('Todo OK ✓')
