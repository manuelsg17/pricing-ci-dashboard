#!/usr/bin/env node
// Tests para computeRecentRef — la "Ref. reciente" del uplift de InDrive.
//   - pooling ponderado por obs sobre las últimas N semanas con datos
//   - ignora semanas sin avgRec/avgBid válidos (p.ej. solo outliers → Lima W27)
//   - respeta la ventana (1/2/4/'all') y el filtro dbCities
//
// Run: node scripts/test-indrive-recent-ref.mjs

import { computeRecentRef } from '../src/algorithms/indriveRef.js'

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
const approx = (a, b, eps = 0.05) => a != null && b != null && Math.abs(a - b) < eps

// Datos reales (Arequipa Económico), + una semana "basura" y otra ciudad
const WEEKLY = [
  { city: 'Arequipa', category: 'Economy/Comfort', week: '2026-W27', obs: 1, avgRec: null, avgBid: '111.50' }, // solo outlier → ignorar
  { city: 'Arequipa', category: 'Economy/Comfort', week: '2026-W26', obs: 24, avgRec: '9.32', avgBid: '10.97' },
  { city: 'Arequipa', category: 'Economy/Comfort', week: '2026-W25', obs: 72, avgRec: '9.61', avgBid: '11.27' },
  { city: 'Arequipa', category: 'Economy/Comfort', week: '2026-W24', obs: 72, avgRec: '9.15', avgBid: '10.55' },
  { city: 'OtherCity', category: 'Economy/Comfort', week: '2026-W26', obs: 99, avgRec: '5.00', avgBid: '9.00' },
]
const CITIES = ['Arequipa', 'Trujillo', 'Lima']
const KEY = 'Arequipa|Economy/Comfort'

console.log('\n══ computeRecentRef (Ref. reciente InDrive) ══')

// [1] Ventana = 1 semana → usa W26 (no la basura W27)
{
  console.log('\n[1] weeks=1 usa la última semana CON datos (ignora W27 sin avgRec)')
  const r = computeRecentRef(WEEKLY, CITIES, 1)[KEY]
  assert(r != null, 'hay referencia para Arequipa')
  assert(approx(r.pct, 17.7), `pct ≈ 17.7 (fue ${r.pct?.toFixed(2)})`)
  assert(r.obs === 24, `obs = 24 (fue ${r.obs})`)
  assert(r.weeksUsed.length === 1 && r.weeksUsed[0] === '2026-W26', 'weeksUsed = [W26]')
}

// [2] Ventana = 2 semanas → pooling ponderado por obs de W26+W25
{
  console.log('\n[2] weeks=2 pondera por obs (W26+W25)')
  const r = computeRecentRef(WEEKLY, CITIES, 2)[KEY]
  // pooledRec=(9.32*24+9.61*72)/96=9.5375 ; pooledBid=(10.97*24+11.27*72)/96=11.195
  // pct=(11.195/9.5375-1)*100 ≈ 17.38
  assert(approx(r.pct, 17.38), `pct ≈ 17.38 (fue ${r.pct?.toFixed(2)})`)
  assert(r.obs === 96, `obs = 96 (fue ${r.obs})`)
  assert(r.weeksUsed.length === 2, 'usa 2 semanas')
}

// [3] Ventana = 'all' → todas las semanas con datos (3, sin W27)
{
  console.log("\n[3] weeks='all' usa todas las semanas con datos")
  const r = computeRecentRef(WEEKLY, CITIES, 'all')[KEY]
  assert(r.obs === 168, `obs = 24+72+72 = 168 (fue ${r.obs})`)
  assert(r.weeksUsed.length === 3, 'usa 3 semanas (W27 basura excluida)')
}

// [4] dbCities filtra ciudades fuera de la config
{
  console.log('\n[4] dbCities filtra OtherCity')
  const map = computeRecentRef(WEEKLY, CITIES, 1)
  assert(map['OtherCity|Economy/Comfort'] === undefined, 'OtherCity ausente (no está en dbCities)')
  // sin filtro sí aparece
  const mapAll = computeRecentRef(WEEKLY, null, 1)
  assert(mapAll['OtherCity|Economy/Comfort'] != null, 'sin filtro, OtherCity presente')
}

// [5] Orden descendente aunque la entrada venga desordenada
{
  console.log('\n[5] toma la MÁS reciente aunque el input esté desordenado')
  const shuffled = [WEEKLY[3], WEEKLY[1], WEEKLY[2]] // W24, W26, W25
  const r = computeRecentRef(shuffled, CITIES, 1)[KEY]
  assert(r.weeksUsed[0] === '2026-W26', 'la más reciente es W26')
  assert(approx(r.pct, 17.7), 'pct de W26 pese al desorden')
}

// [6] Sin datos válidos → clave ausente / entrada vacía
{
  console.log('\n[6] robustez: vacío / solo semanas inválidas')
  assert(Object.keys(computeRecentRef([], CITIES, 1)).length === 0, 'array vacío → {}')
  assert(Object.keys(computeRecentRef(null, CITIES, 1)).length === 0, 'null → {}')
  const onlyBad = [{ city: 'Lima', category: 'Economy/Comfort', week: '2026-W27', obs: 1, avgRec: null, avgBid: '111.5' }]
  assert(computeRecentRef(onlyBad, CITIES, 1)['Lima|Economy/Comfort'] === undefined, 'semana solo-outlier → clave ausente')
}

// [7] Pooling PONDERADO POR OBS del % semanal (no promedio simple)
{
  console.log('\n[7] pondera el % semanal por obs (no promedio simple)')
  const rows = [
    // pct semanal = (bid/rec-1)*100 → W02: 30%, W01: 10%
    { city: 'Lima', category: 'Economy/Comfort', week: '2026-W02', obs: 10, avgRec: '10', avgBid: '13' },
    { city: 'Lima', category: 'Economy/Comfort', week: '2026-W01', obs: 30, avgRec: '10', avgBid: '11' },
  ]
  const r = computeRecentRef(rows, CITIES, 2)['Lima|Economy/Comfort']
  // ponderado: (30*10 + 10*30)/40 = 15% ; promedio simple daría 20%
  assert(approx(r.pct, 15.0), `pct ponderado ≈ 15.0, no 20.0 (fue ${r.pct?.toFixed(2)})`)
  assert(r.obs === 40, `obs = 40 (fue ${r.obs})`)
}

console.log(`\nResultado: ${pass} pasados / ${fail} fallidos`)
if (fail > 0) {
  console.log('\nFallidos:')
  failures.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('Todo OK ✓')
