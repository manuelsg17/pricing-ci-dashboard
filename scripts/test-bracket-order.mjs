#!/usr/bin/env node
// Test para el orden fijo very_short → very_long en useDistanceRefs.js —
// Supabase ordena `bracket` alfabéticamente, que NO es el orden real.
//
// Run: node scripts/test-bracket-order.mjs

import { BRACKETS } from '../src/lib/constants.js'

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

// Misma lógica que sortByBracketOrder() en src/hooks/useDistanceRefs.js —
// duplicada acá a propósito (esa función no está exportada, es un helper
// interno chico) para poder testear el criterio sin instanciar el hook.
function sortByBracketOrder(rows) {
  const rank = (b) => {
    const i = BRACKETS.indexOf(b)
    return i === -1 ? BRACKETS.length : i
  }
  return [...rows].sort((a, b) => {
    if (a.category !== b.category) return a.category < b.category ? -1 : 1
    return rank(a.bracket) - rank(b.bracket)
  })
}

console.log('\n══ Bracket order tests ══')

{
  console.log('\n[1] Orden alfabético desordenado → very_short..very_long')
  const shuffled = [
    { category: 'Economy/Comfort', bracket: 'very_long' },
    { category: 'Economy/Comfort', bracket: 'average' },
    { category: 'Economy/Comfort', bracket: 'very_short' },
    { category: 'Economy/Comfort', bracket: 'median' },
    { category: 'Economy/Comfort', bracket: 'long' },
    { category: 'Economy/Comfort', bracket: 'short' },
  ]
  const sorted = sortByBracketOrder(shuffled).map((r) => r.bracket)
  assert(
    JSON.stringify(sorted) === JSON.stringify(BRACKETS),
    `orden correcto: ${sorted.join(', ')}`
  )
}

{
  console.log('\n[2] Agrupa por categoría antes de ordenar por bracket')
  const rows = [
    { category: 'XL', bracket: 'short' },
    { category: 'Economy/Comfort', bracket: 'long' },
    { category: 'Economy/Comfort', bracket: 'short' },
    { category: 'XL', bracket: 'very_short' },
  ]
  const sorted = sortByBracketOrder(rows)
  assert(sorted[0].category === 'Economy/Comfort', 'Economy/Comfort primero (orden alfabético de categoría)')
  assert(sorted[0].bracket === 'short' && sorted[1].bracket === 'long', 'dentro de Economy/Comfort: short antes que long')
  assert(sorted[2].category === 'XL' && sorted[2].bracket === 'very_short', 'XL very_short antes que XL short')
}

{
  console.log('\n[3] Bracket desconocido/vacío no rompe el sort — queda al final')
  const rows = [
    { category: 'Economy/Comfort', bracket: 'very_long' },
    { category: 'Economy/Comfort', bracket: '' },
    { category: 'Economy/Comfort', bracket: 'very_short' },
    { category: 'Economy/Comfort', bracket: 'zzz_desconocido' },
  ]
  const sorted = sortByBracketOrder(rows).map((r) => r.bracket)
  assert(sorted[0] === 'very_short', 'very_short sigue primero')
  assert(sorted[1] === 'very_long', 'very_long sigue en su lugar')
  assert(sorted.slice(2).sort().join(',') === ['', 'zzz_desconocido'].sort().join(','), 'desconocidos quedan al final sin crashear')
}

console.log(`\nResultado: ${pass} pasados / ${fail} fallidos`)
if (fail > 0) {
  console.log('\nFallidos:')
  failures.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('Todo OK ✓')
