#!/usr/bin/env node
// Tests para el corte "Promedio Ponderado → Promedio Simple" desde 2026-W25.
//   - isSimpleAvgPeriod: borde exacto W24 (ponderado) vs W25 (simple)
//   - computeSimpleAvg: media aritmética con exclusión de precio <= 1
//   - computePeriodAvg: dispatcher por período
//   - LEGACY_WEIGHTS_PE: pesos históricos reales de Perú resueltos por buildWeightsMap
//
// Run: node scripts/test-simple-avg-cutoff.mjs

import {
  isSimpleAvgPeriod,
  computeSimpleAvg,
  computePeriodAvg,
  computeWeightedAvg,
  buildWeightsMap,
  SIMPLE_AVG_SINCE,
} from '../src/algorithms/weightedAverage.js'
import { LEGACY_WEIGHTS_PE, BRACKETS } from '../src/lib/constants.js'
import { isoWeekMonday } from '../src/lib/dateUtils.js'

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
const approx = (a, b, eps = 1e-9) => a != null && b != null && Math.abs(a - b) < eps

console.log('\n══ Corte promedio simple (2026-W25) ══')

// [1] Borde exacto del corte
{
  console.log('\n[1] isSimpleAvgPeriod — borde W24/W25')
  assert(SIMPLE_AVG_SINCE.year === 2026 && SIMPLE_AVG_SINCE.week === 25, 'constante = 2026-W25')
  assert(isSimpleAvgPeriod(2026, 24) === false, '2026-W24 → ponderado (false)')
  assert(isSimpleAvgPeriod(2026, 25) === true, '2026-W25 → simple (true)')
  assert(isSimpleAvgPeriod(2026, 26) === true, '2026-W26 → simple (true)')
  assert(isSimpleAvgPeriod(2026, 1) === false, '2026-W01 → ponderado (false)')
  assert(isSimpleAvgPeriod(2025, 52) === false, '2025-W52 → ponderado (false)')
  assert(isSimpleAvgPeriod(2027, 1) === true, '2027-W01 → simple (true)')
  assert(isSimpleAvgPeriod(null, null) === false, 'null/null → false (no rompe)')
  assert(isSimpleAvgPeriod(2026, undefined) === false, 'week undefined → false')
}

// [2] computeSimpleAvg — media con exclusión <= 1
{
  console.log('\n[2] computeSimpleAvg')
  const prices = { very_short: 10, short: 20, median: 30, average: null, long: 0.5, very_long: 1 }
  // incluidos: 10, 20, 30 (average null, long 0.5, very_long 1 excluidos) → 20
  assert(approx(computeSimpleAvg(prices), 20), 'media de brackets con dato (>1) = 20')
  assert(computeSimpleAvg({}) === null, 'sin datos → null')
  assert(
    approx(computeSimpleAvg({ very_short: 12.5, short: 14.5 }), 13.5),
    'dos brackets → media 13.5'
  )
  // Con pesos iguales, computeWeightedAvg == computeSimpleAvg (self-normaliza)
  const equal = { very_short: 1, short: 1, median: 1, average: 1, long: 1, very_long: 1 }
  assert(
    approx(computeSimpleAvg(prices), computeWeightedAvg(prices, equal)),
    'equal weights ⇒ computeWeightedAvg = simple'
  )
}

// [3] computePeriodAvg — dispatcher
{
  console.log('\n[3] computePeriodAvg')
  const prices = { very_short: 10, short: 20, median: 30, average: 40, long: 50, very_long: 60 }
  const w = buildWeightsMap(LEGACY_WEIGHTS_PE, 'Lima', 'all')
  assert(
    approx(computePeriodAvg(prices, w, 2026, 25), computeSimpleAvg(prices)),
    'W25 → simple (ignora pesos)'
  )
  assert(
    approx(computePeriodAvg(prices, w, 2026, 24), computeWeightedAvg(prices, w)),
    'W24 → ponderado con los pesos dados'
  )
  // El ponderado de Lima NO es una media simple (pesos custom) → deben diferir
  assert(
    !approx(computeWeightedAvg(prices, w), computeSimpleAvg(prices)),
    'ponderado Lima ≠ simple (confirma que los pesos importan en el histórico)'
  )
}

// [4] LEGACY_WEIGHTS_PE — fidelidad + resolución
{
  console.log('\n[4] LEGACY_WEIGHTS_PE')
  const expect = {
    all: [0.0983, 0.1967, 0.1939, 0.1384, 0.075, 0.297],
    Corp: [0.0983, 0.1967, 0.1939, 0.1384, 0.075, 0.297],
    Lima: [0.0975, 0.2043, 0.1952, 0.133, 0.085, 0.285],
    Arequipa: [0.1003, 0.186, 0.2118, 0.0861, 0.1158, 0.2236],
    Trujillo: [0.1003, 0.186, 0.2118, 0.0861, 0.1158, 0.2236],
    Airport: [0.0666, 0.1221, 0.2222, 0, 0.5891, 0],
    Lima_Airport_A: [0.0666, 0.1221, 0.2222, 0, 0.5891, 0],
    Lima_Airport_B: [0.0666, 0.1221, 0.2222, 0, 0.5891, 0],
    Arequipa_Airport_A: [0.1003, 0.186, 0.2118, 0.0861, 0.1158, 0.3],
    Arequipa_Airport_B: [0.1003, 0.186, 0.2118, 0.0861, 0, 0.3336],
    Trujillo_Airport_A: [0.1003, 0.186, 0.2118, 0.0861, 0.4058, 0],
    Trujillo_Airport_B: [0.1003, 0.186, 0.2118, 0, 0, 0.4136],
  }
  for (const [city, arr] of Object.entries(expect)) {
    const m = buildWeightsMap(LEGACY_WEIGHTS_PE, city, 'all')
    const ok = BRACKETS.every((b, i) => approx(m[b], arr[i]))
    assert(ok, `${city}: pesos exactos vía buildWeightsMap`)
  }
  // Fallback: una ciudad no listada cae en ('all','all') canónico (nunca {} → nunca WA null)
  const fb = buildWeightsMap(LEGACY_WEIGHTS_PE, 'CiudadInexistente', 'all')
  assert(
    BRACKETS.every((b, i) => approx(fb[b], expect.all[i])),
    'ciudad no listada → fallback canónico (all/all), no vacío'
  )
  // Categoría específica cae al nivel (city,'all')
  const eco = buildWeightsMap(LEGACY_WEIGHTS_PE, 'Lima', 'Economy')
  assert(
    BRACKETS.every((b, i) => approx(eco[b], expect.Lima[i])),
    'Lima/Economy → cascada a (Lima, all)'
  )
}

// [5] isoWeekMonday — fechas del corte (para los indicadores UI)
{
  console.log('\n[5] isoWeekMonday (bordes del corte)')
  const iso = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  assert(iso(isoWeekMonday(2026, 24)) === '2026-06-08', '2026-W24 → lunes 8-jun-2026')
  assert(iso(isoWeekMonday(2026, 25)) === '2026-06-15', '2026-W25 → lunes 15-jun-2026')
  assert(iso(isoWeekMonday(2026, 1)) === '2025-12-29', '2026-W01 → lunes 29-dic-2025')
}

console.log(`\nResultado: ${pass} pasados / ${fail} fallidos`)
if (fail > 0) {
  console.log('\nFallidos:')
  failures.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('Todo OK ✓')
