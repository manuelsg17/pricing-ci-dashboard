#!/usr/bin/env node
// toISODate: una fecha de CALENDARIO, no un instante.
//
// POR QUÉ EXISTE: la versión vieja era `d.toISOString().slice(0, 10)`. Todas las
// Date que llegan a esta función se construyen en hora LOCAL (`new Date(y, m, d)`,
// `getMondayWeeksAgo`, `Date.now() - n días`), y `toISOString()` las pasa a UTC
// primero: en cualquier huso al ESTE de Greenwich la medianoche local es el día
// ANTERIOR en UTC.
//
// No es hipotético para este proyecto: `country_config` tiene países en UTC+2 y
// UTC+5:45. El rango del dashboard se corría un día entero para esos usuarios.
//
// El test se corre a sí mismo en varios husos: relanza el proceso con TZ puesto,
// porque Node fija la zona al arrancar.
//
// Run: node scripts/test-date-iso.mjs

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { toISODate } from '../src/lib/dateUtils.js'

const ZONAS = ['UTC', 'Asia/Kathmandu', 'Africa/Johannesburg', 'Europe/Moscow', 'America/Lima']

if (!process.env.__TZ_CHILD) {
  const self = fileURLToPath(import.meta.url)
  let fallo = 0
  for (const tz of ZONAS) {
    const r = spawnSync(process.execPath, [self], {
      env: { ...process.env, TZ: tz, __TZ_CHILD: '1' },
      encoding: 'utf8',
    })
    process.stdout.write(r.stdout)
    if (r.status !== 0) {
      process.stderr.write(r.stderr)
      fallo++
    }
  }
  if (fallo) {
    console.log(`\nResultado: ${fallo} husos fallaron`)
    process.exit(1)
  }
  console.log('\nTodos los husos OK ✓')
  process.exit(0)
}

const tz = process.env.TZ
let pass = 0
const fails = []
const check = (label, actual, esperado) => {
  if (actual === esperado) pass++
  else fails.push(`  ✗ [${tz}] ${label}: esperaba ${esperado}, obtuvo ${actual}`)
}

// El caso que rompía: medianoche local del 1 de enero.
check('1 ene medianoche local', toISODate(new Date(2026, 0, 1)), '2026-01-01')
check('4 ene (ancla ISO de la semana 1)', toISODate(new Date(2026, 0, 4)), '2026-01-04')
check('último día del año', toISODate(new Date(2026, 11, 31)), '2026-12-31')
check('29 de febrero bisiesto', toISODate(new Date(2024, 1, 29)), '2024-02-29')
check('un lunes cualquiera', toISODate(new Date(2026, 7, 3)), '2026-08-03')
// Con hora, la fecha de calendario no cambia.
check('23:59 local sigue siendo el mismo día', toISODate(new Date(2026, 7, 3, 23, 59)), '2026-08-03')
check('00:01 local sigue siendo el mismo día', toISODate(new Date(2026, 7, 3, 0, 1)), '2026-08-03')

if (fails.length) {
  fails.forEach((f) => console.log(f))
  process.exit(1)
}
console.log(`  ok  ${tz.padEnd(22)} ${pass} casos`)
