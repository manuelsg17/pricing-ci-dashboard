#!/usr/bin/env node
// Tests para src/lib/catalogs.js — normalización de typos comunes
// observados en producción.
//
// Run: node scripts/test-catalogs.mjs

import {
  CATALOG_CATEGORIES, CATALOG_COMPETITORS,
  normalizeCategory, normalizeCompetitor, getCompetitorColor,
  BOT_RULES_TEMPLATES, getBotRulesTemplate,
} from '../src/lib/catalogs.js'

let pass = 0, fail = 0, failures = []
function assert(cond, label) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}`) }
}

console.log('\n══ Catalog tests ══')

// — Normalización de categorías
{
  console.log('\n[1] normalizeCategory: variantes → canónico')
  assert(normalizeCategory('Economy')     === 'Economy',  'Economy → Economy')
  assert(normalizeCategory('economy')     === 'Economy',  'economy → Economy')
  assert(normalizeCategory('ECONOMY')     === 'Economy',  'ECONOMY → Economy')
  assert(normalizeCategory('economi')     === 'Economy',  'economi (typo) → Economy')
  assert(normalizeCategory('standard')    === 'Economy',  'standard → Economy')
  assert(normalizeCategory('comfort')     === 'Comfort',  'comfort → Comfort')
  assert(normalizeCategory('confort')     === 'Comfort',  'confort (sin h) → Comfort')
  assert(normalizeCategory('Comfort+')    === 'Comfort+', 'Comfort+ → Comfort+')
  assert(normalizeCategory('comfort_plus')=== 'Comfort+', 'comfort_plus → Comfort+')
  assert(normalizeCategory('comfortplus') === 'Comfort+', 'comfortplus → Comfort+')
  assert(normalizeCategory('premier')     === 'Premier',  'premier → Premier')
  assert(normalizeCategory('premium')     === 'Premier',  'premium → Premier')
  assert(normalizeCategory('lujo')        === 'Premier',  'lujo → Premier')
  assert(normalizeCategory('moto')        === 'Bike',     'moto → Bike')
  assert(normalizeCategory('motorbike')   === 'Bike',     'motorbike → Bike')
  assert(normalizeCategory('bike')        === 'Bike',     'bike → Bike')
  assert(normalizeCategory('tuktuk')      === 'TukTuk',   'tuktuk → TukTuk')
  assert(normalizeCategory('tuc_tuc')     === 'TukTuk',   'tuc_tuc → TukTuk')
  assert(normalizeCategory('XL')          === 'XL',       'XL → XL')
  assert(normalizeCategory('extra_large') === 'XL',       'extra_large → XL')
  assert(normalizeCategory('  Economy  ') === 'Economy',  'trim funciona')
  assert(normalizeCategory(null)          === null,        'null → null')
  assert(normalizeCategory('foo')         === null,        'desconocido → null')
}

// — Normalización de competidores
{
  console.log('\n[2] normalizeCompetitor: variantes → canónico')
  assert(normalizeCompetitor('Yango')    === 'Yango',   'Yango → Yango')
  assert(normalizeCompetitor('yango')    === 'Yango',   'yango → Yango')
  assert(normalizeCompetitor('YANGO')    === 'Yango',   'YANGO → Yango')
  assert(normalizeCompetitor('yango_api')=== 'Yango',   'yango_api → Yango (mismo competidor)')
  assert(normalizeCompetitor('Indrive')  === 'InDrive', 'Indrive → InDrive')
  assert(normalizeCompetitor('indrive')  === 'InDrive', 'indrive → InDrive')
  assert(normalizeCompetitor('indriver') === 'InDrive', 'indriver → InDrive')
  assert(normalizeCompetitor('IN_DRIVE') === 'InDrive', 'IN_DRIVE → InDrive')
  assert(normalizeCompetitor('DiDi')     === 'Didi',    'DiDi → Didi')
  assert(normalizeCompetitor('didi')     === 'Didi',    'didi → Didi')
  assert(normalizeCompetitor('Uber')     === 'Uber',    'Uber → Uber')
  assert(normalizeCompetitor('UBER')     === 'Uber',    'UBER → Uber')
  assert(normalizeCompetitor('Picap')    === 'Picap',   'Picap → Picap')
  assert(normalizeCompetitor('cabify')   === 'Cabify',  'cabify → Cabify')
  assert(normalizeCompetitor('Beat')     === 'Beat',    'Beat → Beat')
  assert(normalizeCompetitor(null)       === null,      'null → null')
  assert(normalizeCompetitor('foo')      === null,      'desconocido → null')
}

// — Colores
{
  console.log('\n[3] getCompetitorColor: tiene fallback determinista')
  assert(getCompetitorColor('Yango')    === '#E53935',  'Yango → color canónico')
  assert(getCompetitorColor('yango')    === '#E53935',  'yango (lowercase) → color canónico')
  assert(getCompetitorColor('Indrive')  === '#00C853',  'Indrive (typo) → color canónico InDrive')
  // Color determinista para no-catalogados
  const c1 = getCompetitorColor('NuevoCompetidor')
  const c2 = getCompetitorColor('NuevoCompetidor')
  assert(c1 === c2, 'No-catalogado: mismo input → mismo color (determinista)')
  assert(c1?.startsWith('hsl('), 'No-catalogado devuelve hsl(...)')
  assert(getCompetitorColor(null) === '#94a3b8', 'null → gris fallback')
}

// — Catálogos tienen las entries esperadas
{
  console.log('\n[4] Catálogo cubre los competidores históricos')
  const competitorValues = CATALOG_COMPETITORS.map(c => c.value)
  for (const expected of ['Yango','Uber','Didi','InDrive','Cabify','Picap','Beat','Bolt']) {
    assert(competitorValues.includes(expected), `Catalog incluye ${expected}`)
  }
  const categoryValues = CATALOG_CATEGORIES.map(c => c.value)
  for (const expected of ['Economy','Comfort','Comfort+','Premier','Bike','TukTuk','XL','Corp']) {
    assert(categoryValues.includes(expected), `Catalog incluye categoría ${expected}`)
  }
}

// — Bot rules templates
{
  console.log('\n[5] BOT_RULES_TEMPLATES disponibles')
  const cop = getBotRulesTemplate('COP')
  assert(cop.length >= 5, 'COP tiene al menos 5 reglas')
  assert(cop.some(r => r.competition_name === 'Yango'), 'COP incluye Yango')
  assert(cop.some(r => r.competition_name === 'Didi'),  'COP incluye Didi')

  const pen = getBotRulesTemplate('PEN')
  assert(pen.length >= 4, 'PEN tiene al menos 4 reglas')

  // BOB es alias de PEN
  const bob = getBotRulesTemplate('BOB')
  assert(bob.length === pen.length, 'BOB hereda de PEN via alias')

  const xyz = getBotRulesTemplate('XYZ')
  assert(Array.isArray(xyz) && xyz.length === 0, 'Currency desconocida devuelve [] (no crashea)')
}

console.log(`\nResultado: ${pass} pasados / ${fail} fallidos`)
if (fail > 0) {
  console.log('\nFallidos:')
  failures.forEach(f => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('Todo OK ✓')
