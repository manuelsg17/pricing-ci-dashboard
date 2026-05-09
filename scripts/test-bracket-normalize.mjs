#!/usr/bin/env node
// Tests para normalize_distance_bracket — implementación JS espejo de
// la función SQL (mig 47) y de bot_sync_push.py. Si querés agregar
// nuevas reglas, agregá tests acá primero.
//
// Run: node scripts/test-bracket-normalize.mjs

const CANONICAL = new Set(['very_short', 'short', 'median', 'average', 'long', 'very_long'])

function normalize(raw) {
  if (!raw) return null
  let s = String(raw).toLowerCase().replace(/[\s-]+/g, '_')
  s = s.replace(/^airport_/, '')
  s = s.replace(/_(madrid|funza|mosquera|cota|chia|soacha|cajica|tenjo|sopo|sibate)$/, '')
  s = s.replace(/_(zona_sur|zona_norte|zona_centro|zona_este|zona_oeste|sur|norte|centro|este|oeste)$/, '')
  s = s.replace(/_(a|b)$/, '')
  if (s === 'medium')     s = 'median'
  if (s === 'very short') s = 'very_short'
  if (s === 'very long')  s = 'very_long'
  return CANONICAL.has(s) ? s : null
}

const cases = [
  // [input, expected]
  // Canónicos pasan tal cual
  ['short',       'short'],
  ['median',      'median'],
  ['very_short',  'very_short'],
  ['very_long',   'very_long'],
  ['VERY LONG',   'very_long'],

  // Variantes A/B
  ['long_a',      'long'],
  ['long_b',      'long'],
  ['short_a',     'short'],

  // Sufijos de zona
  ['median_zona_sur',    'median'],
  ['short_zona_sur',     'short'],
  ['long_zona_sur',      'long'],
  ['long_norte',         'long'],

  // Sufijos de municipio satélite
  ['short_madrid',       'short'],
  ['median_funza',       'median'],
  ['long_mosquera',      'long'],
  ['long_b_madrid',      'long'],
  ['long_a_funza',       'long'],

  // Prefijo airport
  ['airport_short_a',    'short'],
  ['airport_median_b',   'median'],
  ['airport_very_long_a','very_long'],
  ['airport_long_b',     'long'],

  // Typos comunes del bot
  ['medium',             'median'],

  // Edge cases
  [null,                 null],
  ['',                   null],
  ['  ',                 null],   // trim implícito por regex
  ['unknown_thing',      null],
  ['foo_bar',            null],
  ['Long',               'long'],
  ['Median',             'median'],
]

let pass = 0, fail = 0, failures = []
for (const [input, expected] of cases) {
  const actual = normalize(input)
  if (actual === expected) {
    pass++
  } else {
    fail++
    failures.push(`  ✗ normalize(${JSON.stringify(input)}) → ${JSON.stringify(actual)} (esperado ${JSON.stringify(expected)})`)
  }
}

console.log(`\nResultado: ${pass} pasados / ${fail} fallidos`)
if (fail > 0) {
  console.log('\nFallidos:')
  failures.forEach(f => console.log(f))
  process.exit(1)
}
console.log('Todo OK ✓')
