#!/usr/bin/env node
// Run with: node scripts/test-bot-mapping.mjs
//
// Verifica que mapBotRows aplica correctamente las botRules de cada país.
// Catch principal: el bug histórico donde una regla con vc='premier' no
// matcheaba filas del bot que llegan con vc='premium'.

import { mapBotRows } from '../src/lib/botMapping.js'
import { COUNTRY_CONFIG } from '../src/lib/constants.js'

let passed = 0
let failed = 0
const failures = []

function assert(cond, label) {
  if (cond) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    failures.push(label)
    console.log(`  ✗ ${label}`)
  }
}

function makeRow(overrides = {}) {
  return {
    timestamp_local:           '2026-04-15T10:30:00-05:00',
    country:                   'Peru',
    city:                      'lima',
    app:                       'yango',
    vehicle_category:          'economy',
    observed_vehicle_category: 'economy',
    distance_bracket:          'short',
    price_regular_value:       '15.50',
    price_discounted_value:    '12.50',
    surge:                     'FALSE',
    eta_mins:                  '5',
    status:                    'ok',
    start_address:             'Plaza Mayor',
    end_address:               'Aeropuerto',
    ...overrides,
  }
}

console.log('\n══ Bot mapping tests — Perú ══')

// ── Test 1: cada botRule de Perú produce al menos una fila ok ─────────
{
  console.log('\n[1] Cada botRule de Perú resuelve correctamente')
  const rules = COUNTRY_CONFIG.Peru.botRules
  for (const rule of rules) {
    const city = rule.cities ? rule.cities[0].toLowerCase().replace('_', '_') : 'lima'
    const cityLower = rule.cities ? rule.cities[0].replace('_Airport', '_airport').toLowerCase() : 'lima'
    const ovc = rule.ovc === '*' ? 'anything' : rule.ovc
    const row = makeRow({
      city: cityLower,
      app:  rule.app,
      vehicle_category: rule.vc,
      observed_vehicle_category: ovc,
    })
    const { ok, skipped } = mapBotRows([row], 'Peru')
    const matched = ok[0]
    assert(
      matched && matched.competition_name === rule.name && matched.category === rule.category,
      `${rule.app}/${rule.vc}/${rule.ovc} → ${rule.name}/${rule.category}` +
        (matched ? ` got ${matched.competition_name}/${matched.category}` :
          ` (skipped: ${skipped[0]?.reason || 'unknown'})`)
    )
  }
}

// ── Test 2: regresión del bug vc='premier' vs vc='premium' ────────────
{
  console.log('\n[2] Regresión: el bot envía vc=premium para Premier (no premier)')
  const row = makeRow({
    city: 'lima',
    app:  'yango',
    vehicle_category: 'premium',     // bot envía premium
    observed_vehicle_category: 'premier',
  })
  const { ok } = mapBotRows([row], 'Peru')
  assert(
    ok.length === 1 && ok[0].competition_name === 'Yango' && ok[0].category === 'Premier',
    'Yango Premier (vc=premium, ovc=premier) → Yango/Premier'
  )
}

// ── Test 3: filas de país equivocado son descartadas ──────────────────
{
  console.log('\n[3] Filas de país no activo se descartan')
  const peruRow = makeRow({ country: 'Peru' })
  const colRow  = makeRow({ country: 'colombia', city: 'bogota' })
  const { ok: okPeru }   = mapBotRows([peruRow, colRow], 'Peru')
  const { ok: okCol }    = mapBotRows([peruRow, colRow], 'Colombia')
  assert(okPeru.length === 1, 'Filtra solo Perú al activar Perú')
  assert(okCol.length === 1, 'Filtra solo Colombia al activar Colombia')
}

// ── Test 4: status != 'ok' descartado ─────────────────────────────────
{
  console.log('\n[4] status != "ok" descartado')
  const row = makeRow({ status: 'error' })
  const { ok, skipped } = mapBotRows([row], 'Peru')
  assert(ok.length === 0, 'Status error → 0 filas ok')
  assert(skipped.length === 1, 'Status error → 1 skipped')
}

// ── Test 5: app desconocida descartada ────────────────────────────────
{
  console.log('\n[5] App desconocida descartada')
  const row = makeRow({ app: 'lyft' })
  const { ok, skipped } = mapBotRows([row], 'Peru')
  assert(ok.length === 0, 'App lyft → skipped')
  assert(skipped[0]?.reason?.includes('App desconocida'), 'Razón: app desconocida')
}

// ── Test 6: TukTuk solo en Lima ────────────────────────────────────────
{
  console.log('\n[6] TukTuk solo matchea Lima')
  const limaRow = makeRow({
    city: 'lima', app: 'yango',
    vehicle_category: 'tuktuk', observed_vehicle_category: '*',
  })
  const trujilloRow = makeRow({
    city: 'trujillo', app: 'yango',
    vehicle_category: 'tuktuk', observed_vehicle_category: '*',
  })
  const { ok: okLima }     = mapBotRows([limaRow], 'Peru')
  const { ok: okTrujillo } = mapBotRows([trujilloRow], 'Peru')
  assert(okLima.length === 1 && okLima[0].category === 'TukTuk', 'TukTuk en Lima → ok')
  assert(okTrujillo.length === 0, 'TukTuk en Trujillo → skipped (no aplica regla)')
}

// ── Test 7: precios fuera de rango se descartan a null ────────────────
{
  console.log('\n[7] Precio > maxPrice se descarta')
  const row = makeRow({ price_regular_value: '99999' })   // > 300 (maxPrice de Perú)
  const { ok } = mapBotRows([row], 'Peru')
  assert(ok.length === 1, 'Fila se acepta (matchea regla)')
  assert(ok[0].price_without_discount === null, 'Pero price_without_discount queda en null')
}

// ── Test 8: ovc null/empty se trata como '*' (matchea wildcard) ───────
{
  console.log('\n[8] observed_vehicle_category vacío → wildcard match')
  const row = makeRow({
    city: 'lima', app: 'yango',
    vehicle_category: 'tuktuk',
    observed_vehicle_category: '',
  })
  const { ok } = mapBotRows([row], 'Peru')
  assert(ok.length === 1 && ok[0].category === 'TukTuk', 'ovc vacío matchea regla con ovc=*')
}

// ── Test 9: city desconocida se descarta ──────────────────────────────
{
  console.log('\n[9] City fuera de botCityMap se descarta')
  const row = makeRow({ city: 'cusco' })
  const { ok, skipped } = mapBotRows([row], 'Peru')
  assert(ok.length === 0, 'Cusco → skipped')
  assert(skipped[0]?.reason?.includes('Ciudad'), 'Razón: ciudad desconocida')
}

// ── Test 10: InDrive usa minimal_bid en lugar de price_without_discount ─
{
  console.log('\n[10] InDrive: price_regular → recommended_price, price_discounted → minimal_bid')
  const row = makeRow({
    app: 'indrive',
    vehicle_category: 'economy',
    observed_vehicle_category: 'viaje',
    price_regular_value: '14.00',
    price_discounted_value: '10.00',
  })
  const { ok } = mapBotRows([row], 'Peru')
  assert(ok.length === 1, 'InDrive row mapeado')
  assert(ok[0].recommended_price === 14, 'recommended_price = price_regular')
  assert(ok[0].minimal_bid === 10, 'minimal_bid = price_discounted')
  assert(ok[0].price_without_discount === null, 'price_without_discount es null para InDrive')
}

// ── Resumen ───────────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════════')
console.log(`Resultado: ${passed} pasados · ${failed} fallidos`)
if (failed > 0) {
  console.log('\nFallidos:')
  failures.forEach(f => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('Todo OK ✓')
