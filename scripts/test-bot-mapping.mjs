#!/usr/bin/env node
// Run with: node scripts/test-bot-mapping.mjs
//
// Verifica que mapBotRows aplica correctamente las botRules de cada país.
// Catch principal: el bug histórico donde una regla con vc='premier' no
// matcheaba filas del bot que llegan con vc='premium'.

import { mapBotRows, botRulesRowsToInternal } from '../src/lib/botMapping.js'
import { COUNTRY_CONFIG, dbConfigToInternal } from '../src/lib/constants.js'

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

// ── Path en vivo: botRulesRowsToInternal (CountryContext.fetchAllConfigs) ──
// Hasta acá todos los tests corren contra COUNTRY_CONFIG.Peru.botRules, el
// array hardcodeado — pero en producción, para prácticamente todos los
// países (incluido Peru/Colombia salvo que falle el fetch), el path real
// es CountryContext trayendo bot_rules de la tabla SQL y pisando botRules
// vía botRulesRowsToInternal() (Fase 1.3c, commit a88998e). Esa función y
// el path que la usa no tenían ningún test — se cubre acá.
console.log('\n══ Bot mapping tests — path en vivo (botRulesRowsToInternal) ══')

// ── Test 11: botRulesRowsToInternal — shape transform SQL → interno ───
{
  console.log('\n[11] botRulesRowsToInternal: shape transform SQL→interno')
  const internalRules = botRulesRowsToInternal([
    {
      country: 'Bolivia', app: 'yango_api', vc: 'economy', ovc: '*',
      competition_name: 'Yango', category: 'Economy', cities: [],
    },
    {
      country: 'Bolivia', app: 'uber', vc: 'economy', ovc: '*',
      competition_name: 'Uber', category: 'Economy', cities: ['La_Paz'],
    },
  ])
  assert(internalRules[0].app === 'yango', 'app "yango_api" → "yango" (alias vía APP_KEY_MAP)')
  assert(internalRules[0].name === 'Yango', 'competition_name (columna SQL) → name (campo que lee resolveByRules)')
  assert(internalRules[0].cities === undefined, 'cities=[] (convención SQL "sin restricción") → undefined (convención JS)')
  assert(
    Array.isArray(internalRules[1].cities) && internalRules[1].cities.includes('La_Paz'),
    'cities no vacío se preserva tal cual'
  )
  assert(
    botRulesRowsToInternal([]).length === 0 && botRulesRowsToInternal(null).length === 0,
    'input vacío/null no rompe, devuelve []'
  )
}

// ── Test 12: end-to-end — país DB-only, exactamente el path de CountryContext ──
{
  console.log('\n[12] Simula CountryContext.fetchAllConfigs(): dbConfigToInternal + overlay de botRulesRowsToInternal, para un país que vive SOLO en DB (Bolivia)')

  // country_config row tal como vendría de Supabase (bot_rules JSONB vacío
  // a propósito — el path en vivo no debe depender de ese snapshot)
  const boliviaRow = {
    label: 'Bolivia',
    currency: 'BOB',
    locale: 'es-BO',
    status: 'active',
    outlier_threshold: 100,
    max_price: 500,
    cities: [
      {
        uiName: 'La Paz', dbName: 'La_Paz', botKey: 'la_paz',
        categories: [{ name: 'Economy', dbName: 'Economy', competitors: ['Yango', 'Uber'] }],
      },
      {
        uiName: 'Santa Cruz', dbName: 'Santa_Cruz', botKey: 'santa_cruz',
        categories: [{ name: 'Economy', dbName: 'Economy', competitors: ['Yango', 'Uber'] }],
      },
    ],
    bot_rules: [],
  }
  // Filas de la tabla SQL bot_rules tal como las trae CountryContext en paralelo
  const rawBotRulesRows = [
    {
      country: 'Bolivia', app: 'yango_api', vc: 'economy', ovc: '*',
      competition_name: 'Yango', category: 'Economy', cities: [],
    },
    {
      country: 'Bolivia', app: 'uber', vc: 'economy', ovc: '*',
      competition_name: 'Uber', category: 'Economy', cities: ['La_Paz'],
    },
  ]

  const internal = dbConfigToInternal(boliviaRow)
  internal.botRules = botRulesRowsToInternal(rawBotRulesRows) // mismo overlay que CountryContext.fetchAllConfigs()
  const dbConfigs = { Bolivia: internal }

  const yangoLaPaz = makeRow({
    country: 'Bolivia', city: 'la_paz', app: 'yango',
    vehicle_category: 'economy', observed_vehicle_category: 'economy',
  })
  const yangoSantaCruz = makeRow({
    country: 'Bolivia', city: 'santa_cruz', app: 'yango',
    vehicle_category: 'economy', observed_vehicle_category: 'economy',
  })
  const uberLaPaz = makeRow({
    country: 'Bolivia', city: 'la_paz', app: 'uber',
    vehicle_category: 'economy', observed_vehicle_category: 'economy',
  })
  const uberSantaCruz = makeRow({
    country: 'Bolivia', city: 'santa_cruz', app: 'uber',
    vehicle_category: 'economy', observed_vehicle_category: 'economy',
  })

  const r1 = mapBotRows([yangoLaPaz], 'Bolivia', dbConfigs)
  assert(
    r1.ok.length === 1 && r1.ok[0].competition_name === 'Yango',
    'regla wildcard (cities=[] → undefined) matchea La Paz'
  )

  const r2 = mapBotRows([yangoSantaCruz], 'Bolivia', dbConfigs)
  assert(
    r2.ok.length === 1 && r2.ok[0].competition_name === 'Yango',
    'regla wildcard matchea también Santa Cruz (sin restricción de ciudad)'
  )

  const r3 = mapBotRows([uberLaPaz], 'Bolivia', dbConfigs)
  assert(
    r3.ok.length === 1 && r3.ok[0].competition_name === 'Uber',
    'regla con cities=[La_Paz] matchea La Paz'
  )

  const r4 = mapBotRows([uberSantaCruz], 'Bolivia', dbConfigs)
  assert(
    r4.ok.length === 0 && r4.skipped.length === 1,
    'regla con cities=[La_Paz] NO matchea Santa Cruz — filtro de ciudad real del path en vivo'
  )
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
