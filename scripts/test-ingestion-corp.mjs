#!/usr/bin/env node
// Tests para normalizeRow de ingestionFilters.js — el bug histórico de Corp
// donde 'YangoPremier' y 'YangoComfort+' se aplastaban a 'Yango' (perdiendo
// la distinción de competidor en Corp). Ver mig 69 + commit hermano.
//
// Run: node scripts/test-ingestion-corp.mjs

import { normalizeRow } from '../src/algorithms/ingestionFilters.js'

let pass = 0, fail = 0, failures = []
function assert(cond, label) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}`) }
}

console.log('\n══ Ingestion Corp tests ══')

// ── Corp: Premier y Comfort+ NO se aplastan a 'Yango' ──────────────────
// Convención canónica (2026-05-19): PEGADO sin espacios para Corp,
// matcheando el Excel original. Sin transformaciones intermedias.
{
  console.log('\n[1] Corp city: Premier/Comfort+ preservan identidad pegada')
  const r1 = normalizeRow({ city: 'Corp', category: 'Corp', competition_name: 'YangoPremier' })
  assert(r1.competition_name === 'YangoPremier',
    `YangoPremier en Corp → YangoPremier (got: ${r1.competition_name})`)

  const r2 = normalizeRow({ city: 'Corp', category: 'Corp', competition_name: 'YangoComfort+' })
  assert(r2.competition_name === 'YangoComfort+',
    `YangoComfort+ en Corp → YangoComfort+ (got: ${r2.competition_name})`)

  const r3 = normalizeRow({ city: 'Corp', category: 'Corp', competition_name: 'YangoEconomy' })
  assert(r3.competition_name === 'YangoEconomy',
    `YangoEconomy en Corp → YangoEconomy (got: ${r3.competition_name})`)

  const r4 = normalizeRow({ city: 'Corp', category: 'Corp', competition_name: 'YangoComfort' })
  assert(r4.competition_name === 'YangoComfort',
    `YangoComfort en Corp → YangoComfort (got: ${r4.competition_name})`)

  // Si llegan con espacios (legacy), también convergen a pegado
  const r5 = normalizeRow({ city: 'Corp', category: 'Corp', competition_name: 'Yango Premier' })
  assert(r5.competition_name === 'YangoPremier',
    `Yango Premier (legacy) en Corp → YangoPremier (got: ${r5.competition_name})`)
}

// ── Fuera de Corp: comportamiento legacy preservado ────────────────────
// En Lima E/C 'YangoPremier' SE APLASTA a 'Yango' (sub-variante del WA).
// Esto es la convención histórica del proyecto. No tocar.
{
  console.log('\n[2] Lima E/C: aplastado legacy preservado')
  const r1 = normalizeRow({ city: 'Lima', category: 'Economy/Comfort', competition_name: 'YangoPremier' })
  assert(r1.competition_name === 'Yango',
    `YangoPremier en Lima E/C → Yango (got: ${r1.competition_name})`)

  const r2 = normalizeRow({ city: 'Lima', category: 'Economy/Comfort', competition_name: 'YangoComfort+' })
  assert(r2.competition_name === 'Yango',
    `YangoComfort+ en Lima E/C → Yango (got: ${r2.competition_name})`)
}

// ── Casing fixes aplican siempre, en Corp o no ─────────────────────────
{
  console.log('\n[3] Casing fixes universales')
  const r1 = normalizeRow({ city: 'Corp', competition_name: 'Indrive' })
  assert(r1.competition_name === 'InDrive',
    `Indrive → InDrive (Corp) (got: ${r1.competition_name})`)

  const r2 = normalizeRow({ city: 'Lima', competition_name: 'DiDi' })
  assert(r2.competition_name === 'Didi',
    `DiDi → Didi (Lima) (got: ${r2.competition_name})`)
}

// ── Idempotencia ───────────────────────────────────────────────────────
{
  console.log('\n[4] Idempotencia')
  const r1 = normalizeRow({ city: 'Corp', competition_name: 'YangoPremier' })
  assert(r1.competition_name === 'YangoPremier',
    `YangoPremier canónico se queda igual en Corp (got: ${r1.competition_name})`)

  const r2 = normalizeRow({ city: 'Lima', competition_name: 'Yango' })
  assert(r2.competition_name === 'Yango',
    `Yango canónico se queda igual en Lima (got: ${r2.competition_name})`)
}

console.log(`\nResultado: ${pass} pasados / ${fail} fallidos`)
if (fail > 0) {
  console.log('\nFallidos:')
  failures.forEach(f => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('Todo OK ✓')
