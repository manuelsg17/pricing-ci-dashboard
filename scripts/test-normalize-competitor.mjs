#!/usr/bin/env node
// Tests para normalizeCompetitorName — convergencia de variantes de
// competition_name a canónico. Context-aware por city (Corp vs resto).
//
// Run: node scripts/test-normalize-competitor.mjs

import { normalizeCompetitorName } from '../src/lib/normalize.js'

const cases = [
  // [label, input, options, expected]

  // ── Casing universal (aplica en cualquier city) ──────────────────────
  ['casing: uber → Uber',           'uber',     undefined,        'Uber'],
  ['casing: UBER → Uber',           'UBER',     undefined,        'Uber'],
  ['casing: Uber idempotente',      'Uber',     undefined,        'Uber'],
  ['casing: yango → Yango',         'yango',    undefined,        'Yango'],
  ['casing: YANGO → Yango',         'YANGO',    undefined,        'Yango'],
  ['casing: didi → Didi',           'didi',     undefined,        'Didi'],
  ['casing: DiDi → Didi',           'DiDi',     undefined,        'Didi'],
  ['casing: indrive → InDrive',     'indrive',  undefined,        'InDrive'],
  ['casing: cabify → Cabify',       'cabify',   undefined,        'Cabify'],
  ['casing: CABIFY → Cabify',       'CABIFY',   undefined,        'Cabify'],

  // ── Corp: Yango (cada variante × al menos 2 inputs) ──────────────────
  // Output PEGADO sin espacios — convención adoptada 2026-05-19. Acepta
  // input con espacios (legacy de uploads viejos) y los convierte al
  // canónico pegado.
  ['Corp: yangoeconomy',            'yangoeconomy',     { city: 'Corp' }, 'YangoEconomy'],
  ['Corp: YangoEconomy idempotente','YangoEconomy',     { city: 'Corp' }, 'YangoEconomy'],
  ['Corp: yango economy → pegado',  'yango economy',    { city: 'Corp' }, 'YangoEconomy'],
  ['Corp: Yango Economy → pegado',  'Yango Economy',    { city: 'Corp' }, 'YangoEconomy'],

  ['Corp: YangoComfort idempotente','YangoComfort',     { city: 'Corp' }, 'YangoComfort'],
  ['Corp: yangocomfort',            'yangocomfort',     { city: 'Corp' }, 'YangoComfort'],
  ['Corp: Yango Comfort → pegado',  'Yango Comfort',    { city: 'Corp' }, 'YangoComfort'],

  ['Corp: YangoComfort+ idempot.',  'YangoComfort+',    { city: 'Corp' }, 'YangoComfort+'],
  ['Corp: yangocomfort+',           'yangocomfort+',    { city: 'Corp' }, 'YangoComfort+'],
  ['Corp: yangocomfortplus',        'yangocomfortplus', { city: 'Corp' }, 'YangoComfort+'],
  ['Corp: Yango Comfort+ → pegado', 'Yango Comfort+',   { city: 'Corp' }, 'YangoComfort+'],
  ['Corp: YangoPlus (hipótesis)',   'YangoPlus',        { city: 'Corp' }, 'YangoComfort+'],

  ['Corp: yangopremier',            'yangopremier',     { city: 'Corp' }, 'YangoPremier'],
  ['Corp: YangoPremier idempot.',   'YangoPremier',     { city: 'Corp' }, 'YangoPremier'],
  ['Corp: Yango Premier → pegado',  'Yango Premier',    { city: 'Corp' }, 'YangoPremier'],

  ['Corp: yangoxl',                 'yangoxl',          { city: 'Corp' }, 'YangoXL'],
  ['Corp: YangoXL idempotente',     'YangoXL',          { city: 'Corp' }, 'YangoXL'],
  ['Corp: Yango XL → pegado',       'Yango XL',         { city: 'Corp' }, 'YangoXL'],

  // ── Corp: Cabify ────────────────────────────────────────────────────
  ['Corp: cabifylite',              'cabifylite',          { city: 'Corp' }, 'CabifyLite'],
  ['Corp: CabifyLite idempotente',  'CabifyLite',          { city: 'Corp' }, 'CabifyLite'],
  ['Corp: Cabify Lite → pegado',    'Cabify Lite',         { city: 'Corp' }, 'CabifyLite'],

  ['Corp: cabifyextracomfort',      'cabifyextracomfort',  { city: 'Corp' }, 'CabifyExtraComfort'],
  ['Corp: CabifyExtraComfort idem', 'CabifyExtraComfort',  { city: 'Corp' }, 'CabifyExtraComfort'],
  ['Corp: Cabify Extra Comfort→peg','Cabify Extra Comfort',{ city: 'Corp' }, 'CabifyExtraComfort'],

  ['Corp: cabifyxl',                'cabifyxl',            { city: 'Corp' }, 'CabifyXL'],
  ['Corp: CabifyXL idempotente',    'CabifyXL',            { city: 'Corp' }, 'CabifyXL'],
  ['Corp: Cabify XL → pegado',      'Cabify XL',           { city: 'Corp' }, 'CabifyXL'],

  // ── E/C (no-Corp): YangoComfort se queda intacto ─────────────────────
  // Esto es lo crítico: en Lima/Trujillo/Arequipa 'YangoComfort' es el
  // canónico legítimo (sub-variante de Yango en Economy/Comfort).
  ['E/C Lima: YangoComfort intacto',  'YangoComfort', { city: 'Lima' },     'YangoComfort'],
  ['E/C Lima_Airport: YangoComfort',  'YangoComfort', { city: 'Lima_Airport' }, 'YangoComfort'],
  ['E/C sin city: YangoComfort',      'YangoComfort', undefined,            'YangoComfort'],

  // ── Casing universal también aplica EN Corp ──────────────────────────
  // 'uber' en Corp sigue siendo 'Uber' (los aliases Corp son sólo para
  // las sub-variantes; los nombres base no cambian de forma en Corp).
  ['Corp: uber → Uber',             'uber',  { city: 'Corp' }, 'Uber'],
  ['Corp: Yango → Yango',           'Yango', { city: 'Corp' }, 'Yango'],

  // ── Edge cases ───────────────────────────────────────────────────────
  ['edge: null',                    null,         undefined,        null],
  ['edge: undefined',               undefined,    undefined,        undefined],
  ['edge: empty string',            '',           undefined,        ''],
  ['edge: only spaces',             '   ',        undefined,        ''],
  ['edge: unknown name passthrough','Beat',       undefined,        'Beat'],
  ['edge: unknown en Corp passthrough','SomeNewApp', { city: 'Corp' }, 'SomeNewApp'],
  ['edge: trim conserva canónico',  '  uber  ',   undefined,        'Uber'],
  ['edge: Corp trim',               '  YangoComfort  ', { city: 'Corp' }, 'YangoComfort'],
]

let pass = 0, fail = 0
const failures = []

function eq(a, b) {
  // null y undefined preservan su identidad (no son lo mismo entre sí)
  if (a === null && b === null) return true
  if (a === undefined && b === undefined) return true
  return a === b
}

for (const [label, input, opts, expected] of cases) {
  const actual = normalizeCompetitorName(input, opts)
  if (eq(actual, expected)) {
    pass++
  } else {
    fail++
    failures.push(`  ✗ ${label}: input=${JSON.stringify(input)} opts=${JSON.stringify(opts)} → ${JSON.stringify(actual)} (esperado ${JSON.stringify(expected)})`)
  }
}

// ── Idempotencia: normalize(normalize(x)) === normalize(x) ──────────────
// Sólo para casos donde el primer pase produce un canónico definido.
const idempotencyCases = [
  ['uber',          undefined],
  ['UBER',          undefined],
  ['yango',         undefined],
  ['YangoComfort',  { city: 'Corp' }],
  ['CabifyXL',      { city: 'Corp' }],
  ['YangoPlus',     { city: 'Corp' }],
  ['YangoComfort',  { city: 'Lima' }],
  ['Uber',          { city: 'Corp' }],
]
for (const [input, opts] of idempotencyCases) {
  const once  = normalizeCompetitorName(input, opts)
  const twice = normalizeCompetitorName(once, opts)
  if (eq(once, twice)) {
    pass++
  } else {
    fail++
    failures.push(`  ✗ idempotencia: ${JSON.stringify(input)} opts=${JSON.stringify(opts)} → "${once}" → "${twice}" (esperaba "${once}")`)
  }
}

console.log(`\nResultado: ${pass} pasados / ${fail} fallidos`)
if (fail > 0) {
  console.log('\nFallidos:')
  failures.forEach(f => console.log(f))
  process.exit(1)
}
console.log('Todo OK ✓')
