#!/usr/bin/env node
// Tests para computeEffectivePrice — el espejo en JS de la vista SQL
// `v_effective_price`.
//
// POR QUÉ IMPORTA: el dashboard agrega con la vista (v_bracket_weekly_avg_mv
// promedia `effective_price`) y el cliente muestra con esta función — el
// drill-down, la preview del Upload. Si las dos no coinciden, el detalle que
// dice explicar una celda muestra otro número, y no hay forma de saber cuál de
// los dos está mal mirando la pantalla.
//
// LOS VALORES ESPERADOS NO ESTÁN INVENTADOS: salen de correr la expresión CASE
// real de la vista contra Postgres local, sobre estas mismas filas. Además hay
// un diferencial más amplio (391 combinaciones de competidor × pwd × rec ×
// bids) que se corrió a mano el 2026-08-03 con 391/391 de coincidencia; acá
// quedan fijados los bordes que separan las dos implementaciones.
//
// Run: node scripts/test-effective-price.mjs

import { computeEffectivePrice } from '../src/algorithms/indrive.js'

let pass = 0
let fail = 0
const failures = []

function check(label, row, esperado) {
  const actual = computeEffectivePrice(row)
  const a = actual == null ? null : Math.round(actual * 1e6) / 1e6
  if (a === esperado) {
    pass++
  } else {
    fail++
    failures.push(`  ✗ ${label}\n      esperaba ${esperado}\n      obtuvo   ${a}`)
  }
}

const r = (competition_name, price_without_discount, recommended_price, ...bids) => ({
  competition_name,
  price_without_discount,
  recommended_price,
  bid_1: bids[0] ?? null,
  bid_2: bids[1] ?? null,
  bid_3: bids[2] ?? null,
  bid_4: bids[3] ?? null,
  bid_5: bids[4] ?? null,
})

// ── InDrive: promedio de bids no-cero cuando hay bids ───────────────────
check('InDrive 3 bids → promedio', r('InDrive', null, null, 10, 20, 30), 20)
check('InDrive 5 bids → promedio', r('InDrive', null, null, 1, 2, 3, 4, 5), 3)
check('InDrive un bid en 0 no cuenta', r('InDrive', null, null, 10, 0, 20), 15)
check('InDrive los bids ganan al pwd', r('InDrive', 99, null, 10), 10)

// ── InDrive SIN bids: la divergencia que tenía esta función ─────────────
// La versión vieja caía a `recommended_price` a secas y devolvía null acá.
// El SQL cae al COALESCE completo, así que el precio cargado a mano cuenta.
check('InDrive sin bids usa price_without_discount', r('InDrive', 7, null, 0, 0), 7)
check('InDrive sin bids ni pwd usa recommended', r('InDrive', null, 9), 9)
check('InDrive sin nada', r('InDrive', null, null, 0, 0, 0, 0, 0), null)

// ── COALESCE ≠ OR de falsy: el 0 se queda en 0 ─────────────────────────
// La versión vieja usaba `Number(pwd) || Number(rec)`, así que un precio de
// exactamente 0 se saltaba al campo siguiente e inventaba un precio.
check('pwd 0 NO cae a recommended', r('Uber', 0, 9), 0)
check('InDrive pwd 0 NO cae a recommended', r('InDrive', 0, 9, 0, 0, 0, 0, 0), 0)

// ── Competidores estándar ──────────────────────────────────────────────
check('Uber con los dos → pwd', r('Uber', 12.5, 9), 12.5)
check('Uber solo recommended', r('Uber', null, 9), 9)
check('Uber sin precio', r('Uber', null, null), null)
check('Uber ignora los bids', r('Uber', null, null, 10, 20), null)

// ── Celda vacía de Excel: '' es NULL, no 0 ─────────────────────────────
// La preview del Upload alimenta esta función con filas parseadas, no con
// filas de Postgres: ahí un campo vacío llega como '' y `Number('')` es 0.
check("'' se trata como NULL, no como 0", r('Uber', '', 9), 9)
check("bids en '' no abren la rama de InDrive", r('InDrive', 8, null, '', ''), 8)
check('texto no numérico se trata como NULL', r('Uber', 'n/a', 9), 9)

// ── Bids negativos (patológicos, pero la regla tiene que ser una sola) ──
// El SQL abre la rama con la SUMA de los bids y divide por cuántos son > 0.
check('bids -5 y 10 → suma 5 sobre 1 bid positivo', r('InDrive', null, null, -5, 10), 5)
// Suma no positiva → no abre la rama, cae al COALESCE.
check('bids 10 y -20 → cae al COALESCE', r('InDrive', 3, null, 10, -20), 3)

console.log(`\nResultado: ${pass} pasados / ${fail} fallidos`)
if (fail > 0) {
  console.log('\nFallidos:')
  failures.forEach((f) => console.log(f))
  process.exit(1)
}
console.log('Todo OK ✓')
