#!/usr/bin/env node
// Tests para src/lib/bracketGrouping.js — agrupar rutas por bracket para el
// flujo "Ingresar CI" por bracket, sin emparejar por posición de array
// cuando una categoría tiene 2+ rutas en el mismo bracket (riesgo real con
// TukTuk, que carga varias rutas por distrito en el mismo bracket).
//
// Run: node scripts/test-bracket-grouping.mjs

import { buildRefsByBracket } from '../src/lib/bracketGrouping.js'

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

console.log('\n══ Bracket grouping tests ══')

const CATEGORIES = ['Economy/Comfort', 'XL', 'TukTuk']

{
  console.log('\n[1] Caso normal: 1 ruta por categoría por bracket → se empareja')
  const refsByUICat = {
    'Economy/Comfort': [{ id: 1, bracket: 'short', point_a: 'Aeropuerto', point_b: 'Centro' }],
    XL: [{ id: 2, bracket: 'short', point_a: 'Aeropuerto', point_b: 'Centro' }],
    TukTuk: [{ id: 3, bracket: 'short', point_a: 'Aeropuerto', point_b: 'Centro' }],
  }
  const result = buildRefsByBracket(refsByUICat, CATEGORIES, 'Economy/Comfort')
  const shortGroup = result.find((b) => b.bracket === 'short')
  assert(shortGroup.groups.length === 1, 'un solo grupo para el bracket')
  assert(shortGroup.groups[0].byCategory.XL.id === 2, 'XL se empareja con la ancla')
  assert(shortGroup.groups[0].byCategory.TukTuk.id === 3, 'TukTuk se empareja con la ancla')
  assert(shortGroup.extras.length === 0, 'sin extras cuando todo empareja 1 a 1')
}

{
  console.log('\n[2] TukTuk con 3 rutas por distrito en el mismo bracket que la ancla (1 ruta) — NO se empareja por índice')
  const refsByUICat = {
    'Economy/Comfort': [
      { id: 1, bracket: 'short', point_a: 'Aeropuerto Jorge Chávez', point_b: 'Centro Histórico' },
    ],
    XL: [],
    TukTuk: [
      { id: 101, bracket: 'short', point_a: 'Comas - Mercado Central', point_b: 'Comas - Parque Norte' },
      { id: 102, bracket: 'short', point_a: 'San Juan de Lurigancho - Zárate', point_b: 'SJL - Canto Grande' },
      { id: 103, bracket: 'short', point_a: 'Villa El Salvador - Sector 2', point_b: 'VES - Sector 7' },
    ],
  }
  const result = buildRefsByBracket(refsByUICat, CATEGORIES, 'Economy/Comfort')
  const shortGroup = result.find((b) => b.bracket === 'short')
  assert(shortGroup.groups.length === 1, 'un solo grupo ancla (Economy/Comfort)')
  assert(
    shortGroup.groups[0].byCategory.TukTuk === undefined,
    'TukTuk NO se empareja con la ancla del aeropuerto — antes esto tomaba la ruta de Comas por índice 0, sin ninguna relación real'
  )
  assert(
    shortGroup.groups[0].byCategory.XL === undefined,
    'XL sin rutas en este bracket tampoco aparece emparejado (queda fuera, se marca "sin ruta" en la UI)'
  )
  assert(shortGroup.extras.length === 3, 'las 3 rutas de TukTuk aparecen todas en extras, cada una con su propia cabecera')
  const extraIds = shortGroup.extras.map((e) => e.ref.id).sort()
  assert(JSON.stringify(extraIds) === JSON.stringify([101, 102, 103]), 'ninguna ruta de TukTuk se pierde')
}

{
  console.log('\n[3] Ancla (Economy/Comfort) con 2 rutas en el mismo bracket — tampoco empareja hermanas por índice')
  const refsByUICat = {
    'Economy/Comfort': [
      { id: 1, bracket: 'median', point_a: 'Ruta A1', point_b: 'Ruta B1' },
      { id: 2, bracket: 'median', point_a: 'Ruta A2', point_b: 'Ruta B2' },
    ],
    XL: [{ id: 3, bracket: 'median', point_a: 'Ruta A1', point_b: 'Ruta B1' }],
    TukTuk: [],
  }
  const result = buildRefsByBracket(refsByUICat, CATEGORIES, 'Economy/Comfort')
  const medianGroup = result.find((b) => b.bracket === 'median')
  assert(medianGroup.groups.length === 2, 'dos grupos ancla, uno por cada ruta de Economy/Comfort')
  assert(
    medianGroup.groups.every((g) => g.byCategory.XL === undefined),
    'XL no se empareja con ninguno de los dos anclas (no hay forma confiable de saber cuál)'
  )
  assert(medianGroup.extras.length === 1, 'la ruta de XL aparece en extras en vez de arriesgar un emparejamiento')
}

{
  console.log('\n[4] Categoría sin ninguna ruta en un bracket con ancla → no aparece en extras ni en groups')
  const refsByUICat = {
    'Economy/Comfort': [{ id: 1, bracket: 'long', point_a: 'A', point_b: 'B' }],
    XL: [],
    TukTuk: [],
  }
  const result = buildRefsByBracket(refsByUICat, CATEGORIES, 'Economy/Comfort')
  const longGroup = result.find((b) => b.bracket === 'long')
  assert(longGroup.groups[0].byCategory.XL === undefined, 'XL sin rutas queda ausente de byCategory')
  assert(longGroup.extras.length === 0, 'no genera extras vacíos')
}

{
  console.log('\n[5] Sin categoría fuente (ciudad sin categorías utilizables) → lista vacía, no crashea')
  assert(JSON.stringify(buildRefsByBracket({}, [], null)) === '[]', 'sourceCategory null → []')
}

console.log(`\nResultado: ${pass} pasados / ${fail} fallidos`)
if (fail > 0) {
  console.log('\nFallidos:')
  failures.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('Todo OK ✓')
