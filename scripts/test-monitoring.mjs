#!/usr/bin/env node
// Tests para src/lib/monitoring.js — clasificación de latido de sesión activa
// y el label ciudad+distrito de los paneles de Monitoreo.
// Run: node scripts/test-monitoring.mjs

import {
  classifySession,
  formatCityZoneLabel,
  LIVE_STALE_MS,
  DEBUG_WINDOW_MS,
} from '../src/lib/monitoring.js'

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

console.log('\n══ monitoring tests ══')

{
  console.log('\n[1] classifySession: bordes exactos de los 2 umbrales')
  const now = 1_800_000_000_000 // ancla fija, no depende del reloj real
  assert(classifySession(null, now) === 'expired', 'sin last_seen → expired')
  assert(
    classifySession(new Date(now).toISOString(), now) === 'live',
    'latido en el instante exacto (edad 0) → live'
  )
  assert(
    classifySession(new Date(now - LIVE_STALE_MS).toISOString(), now) === 'live',
    'edad = LIVE_STALE_MS exacto (borde inclusive) → live'
  )
  assert(
    classifySession(new Date(now - LIVE_STALE_MS - 1).toISOString(), now) === 'recent_inactive',
    'edad = LIVE_STALE_MS + 1ms → recent_inactive'
  )
  assert(
    classifySession(new Date(now - DEBUG_WINDOW_MS).toISOString(), now) === 'recent_inactive',
    'edad = DEBUG_WINDOW_MS exacto (borde inclusive) → recent_inactive'
  )
  assert(
    classifySession(new Date(now - DEBUG_WINDOW_MS - 1).toISOString(), now) === 'expired',
    'edad = DEBUG_WINDOW_MS + 1ms → expired'
  )
}

{
  console.log('\n[2] classifySession: entradas inválidas no crashean')
  assert(classifySession(undefined) === 'expired', 'undefined → expired')
  assert(classifySession('') === 'expired', 'string vacío → expired')
  assert(classifySession('no-es-una-fecha') === 'expired', 'fecha inválida → expired')
}

{
  console.log('\n[3] formatCityZoneLabel: ciudad sola vs. TukTuk por distrito')
  assert(formatCityZoneLabel('Lima', null) === 'Lima', 'sin zona → solo la ciudad')
  assert(formatCityZoneLabel('Lima', '') === 'Lima', 'zona vacía (falsy) → solo la ciudad')
  assert(
    formatCityZoneLabel('Lima', 'Comas') === 'Lima TukTuk · Comas',
    'con zona → "Ciudad TukTuk · Distrito"'
  )
  assert(
    formatCityZoneLabel('Corp', null) === 'Corp',
    'Corp (getCityLabel ya mapea el nombre) sin zona'
  )
}

console.log(`\nResultado: ${pass} pasados / ${fail} fallidos`)
if (fail > 0) {
  console.log('\nFallidos:')
  failures.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('Todo OK ✓')
