#!/usr/bin/env node
// Tests para buildWeightsMap — cascada de pesos por (city, category).
// Espejo del JOIN en freeze_pricing_wa (mig 56).
//
// Niveles de cascada (en orden):
//   1. (city, category)   — exact match
//   2. (city, 'all')      — peso global de la categoría
//   3. ('all', category)  — peso global de la ciudad
//   4. ('all', 'all')     — fallback global del país
//
// Run: node scripts/test-weights-cascade.mjs

import { buildWeightsMap } from '../src/algorithms/weightedAverage.js'

let pass = 0, fail = 0, failures = []
function assert(cond, label) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}`) }
}

console.log('\n══ buildWeightsMap cascade tests ══')

// — Fixture: 4 niveles de pesos
const dbWeights = [
  // Nivel 1: (Bogota, Bike) — específico
  { city: 'Bogota', category: 'Bike',    bracket: 'very_short', weight: 0.40 },
  { city: 'Bogota', category: 'Bike',    bracket: 'short',      weight: 0.30 },
  // Nivel 2: (Bogota, all) — fallback de Bogota
  { city: 'Bogota', category: 'all',     bracket: 'very_short', weight: 0.10 },
  { city: 'Bogota', category: 'all',     bracket: 'short',      weight: 0.20 },
  // Nivel 3: (all, Economy) — fallback global de Economy
  { city: 'all',    category: 'Economy', bracket: 'very_short', weight: 0.05 },
  { city: 'all',    category: 'Economy', bracket: 'short',      weight: 0.15 },
  // Nivel 4: (all, all) — fallback total
  { city: 'all',    category: 'all',     bracket: 'very_short', weight: 0.001 },
  { city: 'all',    category: 'all',     bracket: 'short',      weight: 0.002 },
]

// [1] Match exacto (Bogota, Bike)
{
  console.log('\n[1] Match exacto (Bogota, Bike)')
  const m = buildWeightsMap(dbWeights, 'Bogota', 'Bike')
  assert(m.very_short === 0.40, 'very_short = 0.40 (de Bogota,Bike)')
  assert(m.short      === 0.30, 'short      = 0.30 (de Bogota,Bike)')
}

// [2] Fallback a (Bogota, all): pide Bogota+Comfort, no existe
{
  console.log('\n[2] Fallback a (Bogota, all) para Comfort')
  const m = buildWeightsMap(dbWeights, 'Bogota', 'Comfort')
  assert(m.very_short === 0.10, 'very_short = 0.10 (de Bogota,all)')
  assert(m.short      === 0.20, 'short      = 0.20 (de Bogota,all)')
}

// [3] Fallback a (all, Economy): pide Cali+Economy, no existe Cali
{
  console.log('\n[3] Fallback a (all, Economy) para Cali')
  const m = buildWeightsMap(dbWeights, 'Cali', 'Economy')
  assert(m.very_short === 0.05, 'very_short = 0.05 (de all,Economy)')
  assert(m.short      === 0.15, 'short      = 0.15 (de all,Economy)')
}

// [4] Fallback a (all, all): pide Cali+Bike, no existe ni Cali ni Bike global
{
  console.log('\n[4] Fallback a (all, all) para Cali+Bike')
  const m = buildWeightsMap(dbWeights, 'Cali', 'Bike')
  assert(m.very_short === 0.001, 'very_short = 0.001 (de all,all)')
  assert(m.short      === 0.002, 'short      = 0.002 (de all,all)')
}

// [5] Retrocompat: rows sin category (pre mig 56) tratados como 'all'
{
  console.log('\n[5] Retrocompat: rows sin category')
  const legacy = [
    { city: 'Lima', bracket: 'very_short', weight: 0.0983 },
    { city: 'Lima', bracket: 'short',      weight: 0.1967 },
  ]
  // Sin category: getDbValue trata como 'all' → match en nivel (Lima, 'all')
  const m = buildWeightsMap(legacy, 'Lima')
  assert(m.very_short === 0.0983, 'rows sin category match con call sin category')
  assert(m.short      === 0.1967, 'shapes legacy funcionan')

  // Si pido categoría específica, también match porque legacy se trata como 'all'
  const m2 = buildWeightsMap(legacy, 'Lima', 'Economy')
  assert(m2.very_short === 0.0983, 'fallback a (Lima, all) cuando legacy y se pide Economy')
}

// [6] dbWeights vacío
{
  console.log('\n[6] dbWeights vacío')
  const m = buildWeightsMap([], 'Bogota', 'Bike')
  assert(typeof m === 'object' && Object.keys(m).length === 0, '{} para input vacío')
}

// [7] dbWeights null/undefined
{
  console.log('\n[7] dbWeights null')
  const m1 = buildWeightsMap(null, 'Bogota', 'Bike')
  const m2 = buildWeightsMap(undefined, 'Bogota', 'Bike')
  assert(typeof m1 === 'object' && Object.keys(m1).length === 0, 'null tolerado')
  assert(typeof m2 === 'object' && Object.keys(m2).length === 0, 'undefined tolerado')
}

console.log(`\nResultado: ${pass} pasados / ${fail} fallidos`)
if (fail > 0) {
  console.log('\nFallidos:')
  failures.forEach(f => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('Todo OK ✓')
