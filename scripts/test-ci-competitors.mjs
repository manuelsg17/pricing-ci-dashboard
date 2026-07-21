#!/usr/bin/env node
// Tests para getCiCompetitors — la lista de competidores que se MUESTRA en
// "Ingresar CI": igual que getCompetitors pero sin los marcados "no ofrece"
// (ciHidden) para esa ciudad×categoría. El dashboard sigue usando la lista
// completa (getCompetitors), así que "no ofrece" NO borra histórico.
//
// Protegemos:
//   1. ciHidden filtra SOLO en getCiCompetitors, no en getCompetitors.
//   2. Categoría sin ciHidden → getCiCompetitors === lista completa (retrocompat).
//   3. Un nombre en ciHidden que no está en competitors → no rompe (no-op).
//   4. dbConfigToInternal produce ciHiddenByDbCityCategory (default []).
//
// Run: node scripts/test-ci-competitors.mjs

import { dbConfigToInternal, getCiCompetitors, getCompetitors } from '../src/lib/constants.js'

let pass = 0,
  fail = 0
const failures = []
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
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

console.log('\n══ getCiCompetitors tests ══')

const row = {
  country_key: 'TestLand',
  label: 'TestLand',
  currency: 'PEN',
  cities: [
    {
      uiName: 'AirportA',
      dbName: 'AirportA',
      categories: [
        // Cabify no ofrece esta categoría en el aeropuerto
        { name: 'Eco', dbName: 'Eco', competitors: ['Uber', 'Cabify', 'InDrive'], ciHidden: ['Cabify'] },
        // Sin ciHidden → retrocompatible (todos ofrecen)
        { name: 'Comfort', dbName: 'Comfort', competitors: ['Uber', 'Yango'] },
        // ciHidden con un nombre que no está en competitors → no-op
        { name: 'XL', dbName: 'XL', competitors: ['Uber'], ciHidden: ['NoExiste'] },
        // varios ocultos
        { name: 'Premier', dbName: 'Premier', competitors: ['Uber', 'Cabify', 'Didi'], ciHidden: ['Cabify', 'Didi'] },
      ],
    },
  ],
}

const internal = dbConfigToInternal(row)
const dbConfigs = { TestLand: internal }

// (4) dbConfigToInternal produce el mapa, default []
assert(!!internal.ciHiddenByDbCityCategory, 'dbConfigToInternal produce ciHiddenByDbCityCategory')
assert(eq(internal.ciHiddenByDbCityCategory.AirportA.Eco, ['Cabify']), 'ciHidden Eco = [Cabify]')
assert(eq(internal.ciHiddenByDbCityCategory.AirportA.Comfort, []), 'ciHidden Comfort = [] (default)')

// (1) filtra en CI, NO en getCompetitors
assert(
  eq(getCiCompetitors('AirportA', 'Eco', null, 'TestLand', dbConfigs), ['Uber', 'InDrive']),
  'CI Eco oculta Cabify → [Uber, InDrive]'
)
assert(
  eq(getCompetitors('AirportA', 'Eco', null, 'TestLand', dbConfigs), ['Uber', 'Cabify', 'InDrive']),
  'getCompetitors Eco = lista completa (dashboard intacto)'
)

// (2) retrocompat: sin ciHidden
assert(
  eq(getCiCompetitors('AirportA', 'Comfort', null, 'TestLand', dbConfigs), ['Uber', 'Yango']),
  'CI Comfort (sin ciHidden) = lista completa'
)

// (3) nombre inexistente en ciHidden → no-op
assert(
  eq(getCiCompetitors('AirportA', 'XL', null, 'TestLand', dbConfigs), ['Uber']),
  'CI XL con ciHidden=[NoExiste] → sin cambios'
)

// varios ocultos
assert(
  eq(getCiCompetitors('AirportA', 'Premier', null, 'TestLand', dbConfigs), ['Uber']),
  'CI Premier oculta Cabify y Didi → [Uber]'
)

console.log(`\nResultado: ${pass} pasados / ${fail} fallidos`)
if (fail > 0) {
  console.log('Fallos:', failures.join(' | '))
  process.exit(1)
}
console.log('Todo OK ✓')
