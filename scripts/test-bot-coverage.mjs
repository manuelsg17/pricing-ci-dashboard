#!/usr/bin/env node
// Tests para src/lib/botCoverage.js — el semáforo de frescura (dashboard) y
// el coloreado de la matriz. La comparación es RELATIVA al bracket más fresco
// de la misma ciudad (tz-agnóstica).
//
// Run: node scripts/test-bot-coverage.mjs

import { computeCoverageStatus, staleColors, pivotByCity } from '../src/lib/botCoverage.js'

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

const D = '2026-07-20'
const cell = (city, bracket, time) => ({
  city,
  distance_bracket: bracket,
  last_date: D,
  last_time: time,
  n_recent: 10,
})

console.log('\n══ botCoverage: semáforo de frescura ══')

{
  console.log('\n[1] Ciudad con 3 brackets congelados horas atrás → rojo')
  const rows = [
    cell('Lima', 'short', '22:00:00'), // ref (más fresco)
    cell('Lima', 'very_short', '21:30:00'), // 30 min → ok
    cell('Lima', 'average', '21:45:00'), // 15 min → ok
    cell('Lima', 'median', '08:00:00'), // 14h → rojo
    cell('Lima', 'long', '08:10:00'), // ~14h → rojo
    cell('Lima', 'very_long', '08:20:00'), // ~14h → rojo
  ]
  const s = computeCoverageStatus(rows)
  assert(s.red === 3, `3 tramos en rojo (fue ${s.red})`)
  assert(s.ok === 3, `3 tramos al día (fue ${s.ok})`)
  assert(s.level === 'bad', `nivel 'bad' (fue '${s.level}')`)
}

{
  console.log('\n[2] Ciudad toda fresca → ok')
  const rows = [
    cell('Arequipa', 'short', '23:00:00'),
    cell('Arequipa', 'median', '23:03:00'),
    cell('Arequipa', 'very_long', '23:05:00'),
  ]
  const s = computeCoverageStatus(rows)
  assert(s.red === 0 && s.amber === 0, 'sin rojos ni amarillos')
  assert(s.level === 'ok', "nivel 'ok'")
}

{
  console.log('\n[3] Retraso leve (90 min) → amarillo, no rojo')
  const rows = [
    cell('Trujillo', 'short', '21:00:00'), // ref
    cell('Trujillo', 'long', '19:30:00'), // 90 min → amarillo
  ]
  const s = computeCoverageStatus(rows)
  assert(s.amber === 1 && s.red === 0, `1 amarillo, 0 rojo (fue amber=${s.amber} red=${s.red})`)
  assert(s.level === 'warn', "nivel 'warn'")
}

{
  console.log('\n[4] El peor nivel manda entre ciudades (una ok, otra con rojo)')
  const rows = [
    cell('Arequipa', 'short', '23:00:00'),
    cell('Arequipa', 'long', '23:01:00'),
    cell('Lima', 'short', '22:00:00'),
    cell('Lima', 'long', '05:00:00'), // 17h → rojo
  ]
  const s = computeCoverageStatus(rows)
  assert(s.level === 'bad', "nivel global 'bad' por Lima")
  assert(s.cities === 2, `2 ciudades (fue ${s.cities})`)
}

{
  console.log('\n[5] Robustez: vacío / null → ok, sin crashear')
  assert(computeCoverageStatus([]).level === 'ok', '[] → ok')
  assert(computeCoverageStatus(null).level === 'ok', 'null → ok')
  assert(computeCoverageStatus([]).red === 0, '[] → 0 rojos')
  assert(Object.keys(pivotByCity(null)).length === 0, 'pivotByCity(null) → {}')
}

{
  console.log('\n[6] staleColors: umbrales correctos')
  assert(staleColors(null).fg === '#94a3b8', 'sin data → gris')
  assert(staleColors(0).bg === '#dcfce7', '0 min → verde')
  assert(staleColors(90).bg === '#fef9c3', '90 min → amarillo')
  assert(staleColors(200).bg === '#fee2e2', '200 min → rojo')
}

console.log(`\nResultado: ${pass} pasados / ${fail} fallidos`)
if (fail > 0) {
  console.log('\nFallidos:')
  failures.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('Todo OK ✓')
