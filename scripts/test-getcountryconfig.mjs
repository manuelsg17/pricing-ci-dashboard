#!/usr/bin/env node
// Tests para getCountryConfig — el helper que decide qué config se
// devuelve para un país dado (DB > constants.js > Peru fallback).
//
// El comportamiento que protegemos:
//   1. dbConfigs override gana sobre constants.js
//   2. País conocido sin dbConfigs → devuelve el de constants.js
//   3. País desconocido → devuelve Peru COMO FALLBACK pero con warning
//      en console (antes era fallback silencioso, ahora es visible)
//
// Run: node scripts/test-getcountryconfig.mjs

import { getCountryConfig, COUNTRY_CONFIG } from '../src/lib/constants.js'

let pass = 0, fail = 0, failures = []
function assert(cond, label) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}`) }
}

console.log('\n══ getCountryConfig tests ══')

// — País conocido sin dbConfigs
{
  const peru = getCountryConfig('Peru')
  assert(peru === COUNTRY_CONFIG.Peru, 'Peru sin dbConfigs → COUNTRY_CONFIG.Peru')

  const colombia = getCountryConfig('Colombia')
  assert(colombia === COUNTRY_CONFIG.Colombia, 'Colombia sin dbConfigs → COUNTRY_CONFIG.Colombia')

  const bolivia = getCountryConfig('Bolivia')
  assert(bolivia === COUNTRY_CONFIG.Bolivia, 'Bolivia sin dbConfigs → COUNTRY_CONFIG.Bolivia')
}

// — dbConfigs override
{
  const mockDb = {
    Peru:     { currency: 'PEN-DB', cities: [], dbCities: [] },
    NewLand:  { currency: 'XYZ',    cities: [], dbCities: [] },
  }
  const peruDb = getCountryConfig('Peru', mockDb)
  assert(peruDb.currency === 'PEN-DB', 'Peru con dbConfigs override → usa DB version')

  const newLand = getCountryConfig('NewLand', mockDb)
  assert(newLand.currency === 'XYZ', 'País DB-only (no en constants.js) → usa DB version')
}

// — Fallback con warning (capturamos console.warn)
{
  const origWarn = console.warn
  let warnCalls = []
  console.warn = (...args) => warnCalls.push(args.join(' '))

  const result = getCountryConfig('Unobtanium')
  assert(result === COUNTRY_CONFIG.Peru, 'País desconocido → fallback a Peru (retrocompat)')
  assert(warnCalls.some(m => m.includes('Unobtanium')), 'País desconocido → warning visible en console')

  // Segunda llamada con mismo país no warnea (cache _warned)
  const lenAfter1 = warnCalls.length
  getCountryConfig('Unobtanium')
  assert(warnCalls.length === lenAfter1, 'Segunda llamada al mismo país no duplica warning')

  console.warn = origWarn
}

// — dbConfigs vacío/null no rompe
{
  const a = getCountryConfig('Peru', null)
  assert(a === COUNTRY_CONFIG.Peru, 'dbConfigs=null tolerado')
  const b = getCountryConfig('Peru', {})
  assert(b === COUNTRY_CONFIG.Peru, 'dbConfigs={} tolerado')
}

console.log(`\nResultado: ${pass} pasados / ${fail} fallidos`)
if (fail > 0) {
  console.log('\nFallidos:')
  failures.forEach(f => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('Todo OK ✓')
