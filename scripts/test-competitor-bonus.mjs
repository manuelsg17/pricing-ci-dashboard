#!/usr/bin/env node
// Tests para src/lib/competitorBonus.js — motor único de bonos de
// competidor (Rentabilidad + DriverEarnings). Es dinero real: sin tests
// automatizados, un cambio sin querer acá corrompe silenciosamente los
// escenarios de rentabilidad y las ganancias mostradas a los hubs.
//
// Run: node scripts/test-competitor-bonus.mjs

import {
  tieredReward,
  gmvTieredReward,
  rowWeeklyCash,
  resolveBonusWeekly,
  effectiveCommission,
} from '../src/lib/competitorBonus.js'

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

console.log('\n══ competitorBonus tests ══')

{
  console.log('\n[1] tieredReward: toma el peldaño MÁS ALTO alcanzado, no la suma')
  const tiers = [
    { threshold: 10, reward: 20 },
    { threshold: 20, reward: 50 },
    { threshold: 30, reward: 90 },
  ]
  assert(tieredReward(tiers, 25, 0) === 50, '25 viajes → peldaño de 20 (reward=50), NO suma 20+50')
  assert(tieredReward(tiers, 30, 0) === 90, '30 viajes → peldaño máximo (90)')
  assert(tieredReward(tiers, 35, 0) === 90, '35 viajes (sobrepasa todos) → último peldaño (90)')
  assert(tieredReward(tiers, 5, 0) === 0, '5 viajes (bajo el primer umbral) → 0')
}

{
  console.log('\n[2] tieredReward: cap topea, cap=0/vacío = SIN tope')
  const tiers = [{ threshold: 10, reward: 100 }]
  assert(tieredReward(tiers, 10, 50) === 50, 'cap=50 topea un reward de 100 → 50')
  assert(tieredReward(tiers, 10, 0) === 100, 'cap=0 → sin tope, reward completo (100)')
  assert(tieredReward(tiers, 10, null) === 100, 'cap=null → sin tope')
  assert(tieredReward(tiers, 10, undefined) === 100, 'cap=undefined → sin tope')
}

{
  console.log('\n[3] tieredReward: robustez ante entradas vacías')
  assert(tieredReward([], 10, 0) === 0, 'tiers=[] → 0, no crashea')
  assert(tieredReward(null, 10, 0) === 0, 'tiers=null → 0, no crashea')
}

{
  console.log('\n[4] gmvTieredReward (Yango % GMV): elige la meta de MAYOR pago entre las alcanzadas')
  const tiers = [
    { threshold: 10, pct: 5, cap: 0 },
    { threshold: 30, pct: 10, cap: 0 },
  ]
  const fare = 10
  // meta 10: 5% * 10 * 10 = 5 ; meta 30: 10% * 10 * 30 = 30 → elige la de 30
  assert(gmvTieredReward(tiers, 35, fare) === 30, '35 viajes alcanza ambas metas → toma la de mayor pago (30)')
  assert(gmvTieredReward(tiers, 10, fare) === 5, '10 viajes → solo la primera meta (5)')
  assert(gmvTieredReward(tiers, 5, fare) === 0, 'bajo el primer umbral → 0')
}

{
  console.log('\n[5] gmvTieredReward: el % aplica SOLO sobre el GMV de los primeros N viajes de la meta')
  // meta 10 viajes, driver hizo 50 → el % SOLO se calcula sobre fare*10, no fare*50
  const tiers = [{ threshold: 10, pct: 10, cap: 0 }]
  const fare = 20
  assert(
    gmvTieredReward(tiers, 50, fare) === 20,
    '10% * 20 * 10(meta, NO 50 viajes reales) = 20'
  )
}

{
  console.log('\n[6] gmvTieredReward: cap topea por peldaño, cap=0 = sin tope')
  const tiers = [{ threshold: 10, pct: 50, cap: 5 }]
  assert(gmvTieredReward(tiers, 10, 100) === 5, 'cap=5 topea 50%*100*10=500 → 5')
  const tiersNoCap = [{ threshold: 10, pct: 50, cap: 0 }]
  assert(gmvTieredReward(tiersNoCap, 10, 100) === 500, 'cap=0 → sin tope (500)')
}

{
  console.log('\n[7] rowWeeklyCash: mechanism=flat, tipo viajes')
  const b = { mechanism: 'flat', bonus_type: 'viajes', threshold: 20, bonus_amount: 30 }
  assert(rowWeeklyCash(b, { trips: 20 }) === 30, '20 viajes (== threshold) → bono completo')
  assert(rowWeeklyCash(b, { trips: 19 }) === 0, '19 viajes (< threshold) → 0')
}

{
  console.log('\n[8] rowWeeklyCash: mechanism=flat, tipo horas')
  const b = { mechanism: 'flat', bonus_type: 'horas', threshold: 40, bonus_amount: 15 }
  assert(rowWeeklyCash(b, { hours: 45 }) === 15, '45h (>= threshold) → bono')
  assert(rowWeeklyCash(b, { hours: 10 }) === 0, '10h (< threshold) → 0')
}

{
  console.log('\n[9] rowWeeklyCash: mechanism=guarantee (piso)')
  const b = { mechanism: 'guarantee', threshold: 10, bonus_amount: 200 }
  // 10 viajes * fare 15 * (1 - comm 0.10) = 135 < 200 → completa a 200 (garantía - neto)
  assert(
    rowWeeklyCash(b, { trips: 10, fare: 15, commPct: 10 }) === 65,
    'garantía 200, neto real 135 → paga la diferencia (65)'
  )
  // neto ya supera la garantía → no debe pagar bono negativo
  assert(
    rowWeeklyCash(b, { trips: 10, fare: 30, commPct: 0 }) === 0,
    'neto (300) ya supera la garantía (200) → 0, nunca negativo'
  )
  assert(rowWeeklyCash(b, { trips: 5, fare: 15, commPct: 10 }) === 0, 'bajo el umbral de viajes → 0')
}

{
  console.log('\n[10] rowWeeklyCash: mechanism=surge, share se clampea 0..1')
  const b = { mechanism: 'surge', mult_pct: 20, cap_amount: 0 }
  const normal = rowWeeklyCash(b, { trips: 10, fare: 10, sharePeak: 0.5 })
  assert(normal === 10, '20% * 10 fare * 10 viajes * 0.5 share = 10')
  // share guardado como % (25) por error en vez de fracción (0.25) — el
  // clamp01 defensivo documentado en el código debe evitar que esto
  // multiplique el cash x25.
  const b2 = { mechanism: 'surge', mult_pct: 20, cap_amount: 0, share_in_window: 25 }
  const corrupted = rowWeeklyCash(b2, { trips: 10, fare: 10 })
  assert(
    corrupted === rowWeeklyCash({ ...b2, share_in_window: 1 }, { trips: 10, fare: 10 }),
    'share_in_window=25 (corrupto) se clampea igual que share=1, no dispara el cash x25'
  )
}

{
  console.log('\n[11] rowWeeklyCash: mechanism=comm_credit y comm_discount')
  assert(
    rowWeeklyCash({ mechanism: 'comm_credit', bonus_amount: 40 }, {}) === 40,
    'comm_credit → cash directo, no depende de ctx'
  )
  assert(
    rowWeeklyCash({ mechanism: 'comm_discount', comm_pct: 5 }, {}) === 0,
    'comm_discount → 0 cash (se modela como comisión reducida, no como cash directo)'
  )
}

{
  console.log('\n[12] resolveBonusWeekly: filas one-off van a oneOff, no a total; is_active=false se ignora')
  const rows = [
    { mechanism: 'comm_credit', bonus_amount: 10, recurring: true },
    { mechanism: 'comm_credit', bonus_amount: 5, recurring: false },
    { mechanism: 'comm_credit', bonus_amount: 999, is_active: false },
  ]
  const { total, oneOff, applied } = resolveBonusWeekly(rows, {})
  assert(total === 10, 'solo la fila recurrente entra al total (10)')
  assert(oneOff === 5, 'la fila one-off (recurring:false) va a oneOff (5)')
  assert(applied.length === 1, 'applied solo lista las filas recurrentes con valor > 0')
}

{
  console.log('\n[13] resolveBonusWeekly: category/segment/group_key filtran filas')
  const rows = [
    { mechanism: 'comm_credit', bonus_amount: 10, category: 'Premier' },
    { mechanism: 'comm_credit', bonus_amount: 20, segment: 'nuevo' },
    { mechanism: 'comm_credit', bonus_amount: 30, group_key: 'g1', is_chosen: false },
  ]
  const { total } = resolveBonusWeekly(rows, { dbCategory: 'Economy', segment: 'activo' })
  assert(total === 0, 'categoría/segmento no matchean y group no elegido → ninguna suma')
}

{
  console.log('\n[14] effectiveCommission: comm_discount reduce la comisión efectiva según share')
  const rows = [{ mechanism: 'comm_discount', comm_pct: 1, is_active: true }]
  // comisión base 20%, ventana descontada a 1%, share 0.3 del tiempo en esa ventana
  const eff = effectiveCommission(20, rows, 0.3)
  assert(Math.abs(eff - 14.3) < 0.001, '20 - (20-1)*0.3 = 14.3')
}

{
  console.log('\n[15] effectiveCommission: sin filas de comm_discount devuelve la comisión base')
  assert(effectiveCommission(20, [], 0.5) === 20, 'sin bonos comm_discount → comisión sin cambios')
  assert(effectiveCommission(20, null, 0.5) === 20, 'rows=null → no crashea, comisión sin cambios')
}

console.log(`\nResultado: ${pass} pasados / ${fail} fallidos`)
if (fail > 0) {
  console.log('\nFallidos:')
  failures.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('Todo OK ✓')
