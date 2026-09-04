#!/usr/bin/env node
// Tests para src/lib/yangoGmvBonus.js — bono Yango por % de GMV (escalera
// por # de viajes, topeada). Dinero real mostrado en Rentabilidad/
// DriverEarnings — mismo motivo que competitorBonus.js para tener tests.
//
// Run: node scripts/test-yango-gmv-bonus.mjs

import { hasYangoGmvTable, yangoGmvDetail, yangoGmvBonus } from '../src/lib/yangoGmvBonus.js'

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

console.log('\n══ yangoGmvBonus tests ══')

{
  console.log('\n[1] hasYangoGmvTable: ciudades con tabla hardcodeada (fallback) vs sin tabla')
  assert(hasYangoGmvTable('Lima') === true, "Lima tiene tabla hardcodeada")
  assert(hasYangoGmvTable('Trujillo') === true, "Trujillo tiene tabla hardcodeada")
  assert(hasYangoGmvTable('Corp') === false, "Corp (aeropuertos/Corp) NO tiene tabla — por diseño")
  assert(hasYangoGmvTable('CiudadInexistente') === false, "ciudad desconocida → false, no crashea")
}

{
  console.log('\n[2] yangoGmvDetail: peldaño MÁS ALTO alcanzado, no el primero que matchea')
  // Lima unbranded: t=10 pct=9 cap=50, t=30 pct=10 cap=110 ...
  const d10 = yangoGmvDetail('Lima', 'Economy', false, 10, 10)
  assert(d10.pct === 9, '10 viajes → peldaño de 10 (pct=9)')
  const d35 = yangoGmvDetail('Lima', 'Economy', false, 10, 35)
  assert(d35.pct === 10, '35 viajes → peldaño de 30 (el más alto alcanzado, pct=10), no el de 10')
}

{
  console.log('\n[3] yangoGmvDetail: bono = min(pct% * GMV, cap) — GMV = fare * viajes REALES')
  // Lima unbranded t=10 pct=9 cap=50
  const fare = 15
  const trips = 10
  const d = yangoGmvDetail('Lima', 'Economy', false, fare, trips)
  const expectedGmv = fare * trips // 150
  assert(d.gmv === expectedGmv, `GMV = fare*viajes = ${expectedGmv}`)
  assert(Math.abs(d.bono - Math.min(0.09 * expectedGmv, 50)) < 0.001, 'bono = min(9%*GMV, cap=50)')
}

{
  console.log('\n[4] yangoGmvDetail: cap topea cuando el fare es alto')
  // Lima unbranded t=10 pct=9 cap=50 — con fare muy alto, 9%*GMV supera 50
  const d = yangoGmvDetail('Lima', 'Economy', false, 1000, 10)
  assert(d.bono === 50, 'fare alto → bono topeado en 50, no 9%*10000=900')
}

{
  console.log('\n[5] yangoGmvDetail: branded vs unbranded usan escaleras DISTINTAS')
  const unbranded = yangoGmvDetail('Lima', 'Economy', false, 10, 30)
  const branded = yangoGmvDetail('Lima', 'Economy', true, 10, 30)
  assert(unbranded.pct !== branded.pct, 'branded y unbranded dan % distinto para los mismos 30 viajes')
}

{
  console.log('\n[6] yangoGmvDetail: VIP (Lima + Premier) usa la tabla vip, ignora branded')
  const vipViaUnbranded = yangoGmvDetail('Lima', 'Premier', false, 10, 4)
  const vipViaBranded = yangoGmvDetail('Lima', 'Premier', true, 10, 4)
  assert(vipViaUnbranded.pct === 43, 'Lima Premier, 4 viajes → tabla VIP (pct=43), no unbranded')
  assert(
    vipViaUnbranded.pct === vipViaBranded.pct && vipViaUnbranded.cap === vipViaBranded.cap,
    'VIP ignora el flag branded — misma tabla para ambos'
  )
}

{
  console.log('\n[7] yangoGmvDetail: sin match / entradas inválidas → null')
  assert(yangoGmvDetail('CiudadInexistente', 'Economy', false, 10, 10) === null, 'ciudad sin tabla → null')
  assert(yangoGmvDetail('Lima', 'Economy', false, 10, 0) === null, 'trips=0 → null (sin viajes no hay bono)')
  assert(yangoGmvDetail('Lima', 'Economy', false, 0, 10) === null, 'fare=0 → null')
  assert(yangoGmvDetail('Lima', 'Economy', false, 10, 5) === null, '5 viajes (bajo el primer umbral=10) → null')
}

{
  console.log('\n[8] yangoGmvBonus: wrapper devuelve 0 (NO null) cuando no aplica — evita NaN en sumas')
  assert(yangoGmvBonus('CiudadInexistente', 'Economy', false, 10, 10) === 0, 'sin tabla → 0, no null')
  assert(yangoGmvBonus('Lima', 'Economy', false, 10, 5) === 0, 'bajo el umbral → 0, no null')
  const bono = yangoGmvBonus('Lima', 'Economy', false, 15, 10)
  assert(bono > 0, 'con match real → bono > 0')
}

{
  console.log('\n[9] tabla desde BD (rows de yango_gmv_tiers) reemplaza el hardcode, filtra is_active=false')
  const rows = [
    { city: 'Lima', variant: 'unbranded', min_trips: 5, pct: 20, cap: 100, is_active: true },
    { city: 'Lima', variant: 'unbranded', min_trips: 50, pct: 99, cap: 999, is_active: false },
  ]
  const d = yangoGmvDetail('Lima', 'Economy', false, 10, 5, rows)
  assert(d.pct === 20, 'usa la tabla de BD (pct=20 en vez del hardcode)')
  const d2 = yangoGmvDetail('Lima', 'Economy', false, 10, 60, rows)
  assert(d2.pct === 20, 'la fila is_active=false se filtra — 60 viajes NO alcanza el peldaño 99% inactivo')
  assert(hasYangoGmvTable('Lima', rows) === true, 'hasYangoGmvTable respeta las filas de BD')
}

{
  console.log('\n[10] tabla desde BD vacía/inválida cae al hardcode (fallback documentado)')
  const d = yangoGmvDetail('Lima', 'Economy', false, 15, 10, [])
  assert(d.pct === 9, 'rows=[] → cae al hardcode (Lima unbranded t=10 pct=9)')
  const d2 = yangoGmvDetail('Lima', 'Economy', false, 15, 10, null)
  assert(d2.pct === 9, 'rows=null → cae al hardcode, no crashea')
}

{
  console.log('\n[V] vigencia (mig 237): asOf elige la versión de la escalera; fuera de vigencia → sin tabla')
  const rows = [
    { city: 'Lima', variant: 'unbranded', min_trips: 10, pct: 9, cap: 50, valid_from: '2025-07-01', valid_to: '2026-08-31' },
    { city: 'Lima', variant: 'unbranded', min_trips: 10, pct: 12, cap: 80, valid_from: '2026-09-01', valid_to: null },
  ]
  assert(yangoGmvDetail('Lima', 'Economy', false, 10, 10, rows, '2026-08-15').pct === 9, 'agosto → versión vieja (9%)')
  assert(yangoGmvDetail('Lima', 'Economy', false, 10, 10, rows, '2026-09-01').pct === 12, '1-sep → versión nueva (12%)')
  assert(yangoGmvDetail('Lima', 'Economy', false, 10, 10, rows, '2025-01-01') === null, 'antes de toda vigencia → null (no cae al hardcode)')
  assert(hasYangoGmvTable('Lima', rows, '2025-01-01') === false, 'hasYangoGmvTable respeta asOf')
  assert(yangoGmvBonus('Lima', 'Economy', false, 10, 10, rows) === 12, 'sin asOf → no filtra: gana el peldaño más alto cargado (12% de 100 = 12)')
}

console.log(`\nResultado: ${pass} pasados / ${fail} fallidos`)
if (fail > 0) {
  console.log('\nFallidos:')
  failures.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('Todo OK ✓')
