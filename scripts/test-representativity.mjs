#!/usr/bin/env node
// Tests para src/lib/representativity.js — umbrales, clasificación de celda por
// fuente, y agregación del panel de representatividad.
// Run: node scripts/test-representativity.mjs

import {
  cellFloor,
  cellOptimo,
  levelForTotal,
  classifyCell,
  healthLevel,
  computeRepresentativity,
} from '../src/lib/representativity.js'

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

console.log('\n══ representativity tests ══')

{
  console.log('\n[1] pisos/óptimos: InDrive más exigente que estándar')
  assert(cellFloor('Uber') === 10 && cellOptimo('Uber') === 40, 'estándar 10/40')
  assert(cellFloor('InDrive') === 14 && cellOptimo('InDrive') === 55, 'InDrive 14/55')
}

{
  console.log('\n[2] levelForTotal: bordes del piso y el óptimo (estándar)')
  assert(levelForTotal(9, 'Uber') === 'bad', '9 < piso(10) → bad')
  assert(levelForTotal(10, 'Uber') === 'warn', '10 = piso → warn')
  assert(levelForTotal(39, 'Uber') === 'warn', '39 < óptimo(40) → warn')
  assert(levelForTotal(40, 'Uber') === 'ok', '40 = óptimo → ok')
}

{
  console.log('\n[3] levelForTotal: InDrive usa sus propios umbrales')
  assert(levelForTotal(13, 'InDrive') === 'bad', '13 < 14 → bad')
  assert(levelForTotal(14, 'InDrive') === 'warn', '14 = piso InDrive → warn')
  assert(levelForTotal(54, 'InDrive') === 'warn', '54 < 55 → warn')
  assert(levelForTotal(55, 'InDrive') === 'ok', '55 = óptimo InDrive → ok')
}

{
  console.log('\n[4] classifyCell: total = bot + apps, y clasificación de fuente')
  const none = classifyCell({ competition_name: 'Uber', bot_n: 3, manual_n: 4 })
  assert(none.total === 7 && none.level === 'bad' && none.source === 'none', 'total 7 < piso → none/bad')

  const botDep = classifyCell({ competition_name: 'Uber', bot_n: 30, manual_n: 2 })
  assert(botDep.source === 'bot' && botDep.level === 'warn', 'bot 30 ≥ piso, apps 2 < piso → depende del bot')

  const appsEss = classifyCell({ competition_name: 'Uber', bot_n: 2, manual_n: 12 })
  assert(appsEss.source === 'apps', 'apps 12 ≥ piso, bot 2 < piso → apps esenciales')

  // bot 20 y apps 15: ambas ≥ piso(10) por sí solas → source 'both'; total
  // 35 < óptimo(40) → nivel 'warn'.
  const both = classifyCell({ competition_name: 'Uber', bot_n: 20, manual_n: 15 })
  assert(both.source === 'both', 'ambas fuentes ≥ piso → source both')
  assert(both.level === 'warn', 'total 35 < óptimo 40 → warn')

  const pooled = classifyCell({ competition_name: 'Uber', bot_n: 6, manual_n: 6 })
  assert(pooled.source === 'pooled' && pooled.level === 'warn', '6+6=12 ≥ piso pero ninguna sola → pooled')
}

{
  console.log('\n[5] classifyCell InDrive: piso 14')
  const c = classifyCell({ competition_name: 'InDrive', bot_n: 8, manual_n: 8 })
  assert(c.total === 16 && c.level === 'warn' && c.source === 'pooled', '8+8=16 ≥ 14 pooled/warn')
  const bad = classifyCell({ competition_name: 'InDrive', bot_n: 5, manual_n: 5 })
  assert(bad.total === 10 && bad.level === 'bad' && bad.source === 'none', '10 < 14 → none/bad')
}

{
  console.log('\n[6] healthLevel: ratio de cobertura')
  assert(healthLevel(0.96) === 'ok', '96% → ok')
  assert(healthLevel(0.9) === 'warn', '90% → warn')
  assert(healthLevel(0.7) === 'bad', '70% → bad')
}

{
  console.log('\n[7] computeRepresentativity: agrega y ordena las rojas peor-primero')
  const rows = [
    { city: 'Lima', category: 'Economy/Comfort', competition_name: 'Uber', distance_bracket: 'short', bot_n: 50, manual_n: 5 }, // 55 ok
    { city: 'Lima', category: 'Economy/Comfort', competition_name: 'Uber', distance_bracket: 'long', bot_n: 12, manual_n: 0 }, // 12 warn (bot)
    { city: 'Arequipa', category: 'Económico+', competition_name: 'Uber', distance_bracket: 'short', bot_n: 0, manual_n: 4 }, // 4 bad (none)
    { city: 'Arequipa', category: 'Económico+', competition_name: 'InDrive', distance_bracket: 'long', bot_n: 0, manual_n: 2 }, // 2 bad (none)
  ]
  const s = computeRepresentativity(rows)
  assert(s.totalCells === 4, '4 celdas')
  assert(s.green === 1 && s.amber === 1 && s.red === 2, '1 verde / 1 amarilla / 2 rojas')
  assert(s.covered === 2 && s.coveragePct === 50, 'cobertura 2/4 = 50%')
  assert(s.noSource === 2, '2 sin fuente')
  assert(s.botFloor === 2, 'bot solo cubre 2 (short 50, long 12)')
  assert(s.redCells[0].total === 2 && s.redCells[1].total === 4, 'rojas ordenadas: total 2 antes que 4')
  assert(Object.keys(s.byCity).length === 2, 'agrupa por 2 ciudades')
}

{
  console.log('\n[8] robustez ante entrada vacía/null')
  const s = computeRepresentativity([])
  assert(s.totalCells === 0 && s.coverageRatio === 1 && s.level === 'ok', '[] → 0 celdas, 100%, ok')
  assert(computeRepresentativity(null).totalCells === 0, 'null no crashea')
}

{
  console.log('\n[9] no_data ("atendida sin oferta"): estado aparte, no penaliza ni alerta')
  const rows = [
    { city: 'Lima', category: 'Eco', competition_name: 'Uber', distance_bracket: 'short', bot_n: 50, manual_n: 0 }, // ok
    { city: 'Lima', category: 'Eco', competition_name: 'Didi', distance_bracket: 'short', bot_n: 0, manual_n: 3, no_data_n: 2 }, // 3<10 pero S/D → atendida sin oferta
    { city: 'Lima', category: 'Eco', competition_name: 'Cabify', distance_bracket: 'short', bot_n: 0, manual_n: 4, no_data_n: 0 }, // 4<10 sin S/D → roja
    { city: 'Lima', category: 'Eco', competition_name: 'InDrive', distance_bracket: 'long', bot_n: 0, manual_n: 0, no_data_n: 5 }, // solo S/D → atendida sin oferta
  ]
  const s = computeRepresentativity(rows)
  assert(s.totalCells === 4, '4 celdas')
  assert(s.green === 1, '1 verde (Uber 50)')
  assert(s.attendedNoOffer === 2, '2 atendidas sin oferta (Didi, InDrive)')
  assert(s.red === 1, '1 roja real (Cabify)')
  assert(s.noSource === 1 && s.redCells.length === 1, 'la alerta solo tiene la Cabify')
  assert(s.redCells[0].comp === 'Cabify', 'la roja es Cabify')
  assert(s.covered === 1 && s.coveragePct === 50, 'cobertura 1/(4-2) = 50% (excluye sin-oferta)')
}

{
  console.log('\n[10] todo "sin oferta" → 100% (nada que medir)')
  const rows = [
    { city: 'X', category: 'Eco', competition_name: 'Uber', distance_bracket: 'short', bot_n: 0, manual_n: 0, no_data_n: 3 },
    { city: 'X', category: 'Eco', competition_name: 'Didi', distance_bracket: 'short', bot_n: 0, manual_n: 0, no_data_n: 1 },
  ]
  const s = computeRepresentativity(rows)
  assert(s.attendedNoOffer === 2 && s.covered === 0, '2 sin oferta, 0 cubiertas')
  assert(s.coveragePct === 100 && s.level === 'ok', 'sin nada que medir → 100% ok')
  assert(s.noSource === 0 && s.redCells.length === 0, 'sin alerta de faltantes')
}

console.log(`\nResultado: ${pass} pasados / ${fail} fallidos`)
if (fail > 0) {
  console.log('\nFallidos:')
  failures.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('Todo OK ✓')
