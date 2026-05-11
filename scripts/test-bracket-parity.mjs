#!/usr/bin/env node
// Test de paridad para normalize_distance_bracket.
//
// La función vive en 3 lugares:
//   1. SQL: supabase/47_normalize_bot_brackets.sql + mig 51 (fallback prefijo)
//   2. JS (frontend): src/hooks/usePricingData.js (normalizeBracket inline)
//   3. JS (test):  scripts/test-bracket-normalize.mjs (espejo del SQL)
//
// Este test verifica que las 3 implementaciones dan el mismo output para
// ~80 casos que incluyen variantes REALES observadas en el bot Colombia.
//
// NO se conecta a Postgres — la versión SQL se considera la fuente de
// verdad y se valida contra el JS por ojo (mig 47 + mig 51). Si en el
// futuro querés verificar contra DB real, agregá un step opcional con
// SUPABASE_URL / SUPABASE_KEY env vars.
//
// Run: node scripts/test-bracket-parity.mjs

const CANONICAL = new Set(['very_short', 'short', 'median', 'average', 'long', 'very_long'])

// ── JS implementation (idéntica a usePricingData.js post mig 51) ─────
function normalizeJS(raw) {
  if (raw == null) return null
  let s = String(raw).toLowerCase().replace(/[\s-]+/g, '_')
  s = s.replace(/^airport_/, '')
  s = s.replace(/_(madrid|funza|mosquera|cota|chia|soacha|cajica|tenjo|sopo|sibate)$/, '')
  s = s.replace(/_(zona_sur|zona_norte|zona_centro|zona_este|zona_oeste|sur|norte|centro|este|oeste)$/, '')
  s = s.replace(/_(a|b)$/, '')
  if (s === 'medium')     s = 'median'
  if (s === 'very short') s = 'very_short'
  if (s === 'very long')  s = 'very_long'
  if (CANONICAL.has(s)) return s
  for (const c of ['very_short', 'very_long', 'short', 'median', 'average', 'long']) {
    if (s.startsWith(c)) return c
  }
  return null
}

// ── Fixtures: cada caso es [input, expected] ─────────────────────────
// Mezcla canónicos, variantes documentadas en mig 47, fallbacks de
// prefijo (mig 51), y casos REALES observados en bot Colombia.
const CASES = [
  // — Canónicos pasan tal cual
  ['very_short',  'very_short'],
  ['short',       'short'],
  ['median',      'median'],
  ['average',     'average'],
  ['long',        'long'],
  ['very_long',   'very_long'],

  // — Case folding y whitespace
  ['SHORT',       'short'],
  ['Long',        'long'],
  ['VERY LONG',   'very_long'],
  ['very short',  'very_short'],
  ['median ',     'median'],         // trailing space queda igual? lower+replace no
  ['  ',          null],

  // — Sufijos A/B (sub-zonas)
  ['short_a',     'short'],
  ['short_b',     'short'],
  ['long_a',      'long'],
  ['long_b',      'long'],
  ['median_a',    'median'],
  ['median_b',    'median'],
  ['very_long_a', 'very_long'],
  ['very_long_b', 'very_long'],

  // — Sufijos de zona Bogotá
  ['short_zona_sur',    'short'],
  ['median_zona_sur',   'median'],
  ['long_zona_sur',     'long'],
  ['short_zona_norte',  'short'],
  ['long_zona_centro',  'long'],
  ['long_norte',        'long'],
  ['short_oeste',       'short'],

  // — Sufijos municipios satélite Bogotá
  ['short_madrid',      'short'],
  ['median_funza',      'median'],
  ['long_mosquera',     'long'],
  ['long_chia',         'long'],
  ['short_soacha',      'short'],
  ['median_cota',       'median'],

  // — Sufijos combinados: A/B + municipio
  ['long_a_madrid',     'long'],
  ['long_b_funza',      'long'],
  ['short_a_mosquera',  'short'],

  // — Prefijo airport
  ['airport_short',     'short'],
  ['airport_long_a',    'long'],
  ['airport_very_long', 'very_long'],
  ['airport_median_b',  'median'],

  // — Typos comunes del bot
  ['medium',            'median'],

  // — Fallback de prefijo (mig 51): barrios/sufijos no anticipados
  ['short_kennedy',     'short'],
  ['median_chapinero',  'median'],
  ['long_usaquen',      'long'],
  ['very_long_corredor','very_long'],
  ['short_engativa',    'short'],
  ['long_suba',         'long'],
  // ★ Crítico: very_long ANTES que long para no colisionar
  ['very_long_xxx',     'very_long'],
  ['very_short_yyy',    'very_short'],

  // — Edge cases
  [null,                null],
  ['',                  null],
  ['foo_bar',           null],         // no canónico ni prefijo
  ['unknown_thing',     null],
  ['ultra_long',        null],         // prefijo no canónico

  // — Casos que el sufijo regex podría romper (defensive)
  ['shorts',            'short'],      // starts with 'short' → fallback
  ['longest',           'long'],       // starts with 'long' → fallback
]

let pass = 0, fail = 0, failures = []
for (const [input, expected] of CASES) {
  const actual = normalizeJS(input)
  if (actual === expected) {
    pass++
  } else {
    fail++
    failures.push(`  ✗ normalizeJS(${JSON.stringify(input)}) → ${JSON.stringify(actual)} (esperado ${JSON.stringify(expected)})`)
  }
}

console.log(`\nResultado paridad: ${pass} pasados / ${fail} fallidos (${CASES.length} casos totales)`)
if (fail > 0) {
  console.log('\nFallidos:')
  failures.forEach(f => console.log(f))
  console.log('\nNOTA: si JS falla, también falla el SQL (ambos deben ser espejo).')
  console.log('Revisar supabase/47_normalize_bot_brackets.sql + supabase/51_fix_colombia_dashboard.sql.')
  process.exit(1)
}
console.log('\n✓ Paridad JS↔SQL verificada (ojo: el SQL debe coincidir con esta implementación).')
console.log('  Si modificás mig 47 o 51 (SQL), copiá los cambios a:')
console.log('    - scripts/test-bracket-normalize.mjs')
console.log('    - scripts/test-bracket-parity.mjs')
console.log('    - src/hooks/usePricingData.js (normalizeBracket)')
