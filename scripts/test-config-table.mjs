#!/usr/bin/env node
// Tests de la lógica pura detrás de useConfigTable (src/lib/configTableEdits.js)
// y del mapeo de errores de BD (src/lib/dbErrorText.js).
//
// POR QUÉ: los editores de Configuración perdían lo tipeado en una fila
// cuando se guardaba OTRA (load() pisaba el estado). El hook separa filas
// del servidor y edits locales; acá se prueba que una recarga no toca los
// edits ni las filas nuevas, y que los errores crudos de Postgres nunca
// llegan al usuario tal cual.
// Run: node scripts/test-config-table.mjs

import {
  isNewId,
  makeTempId,
  mergeRows,
  applyEdit,
  pruneEdits,
} from '../src/lib/configTableEdits.js'
import { dbErrorKind, dbErrorText } from '../src/lib/dbErrorText.js'

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
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

console.log('\n══ useConfigTable — lógica pura ══')

{
  console.log('\n[1] ids temporales')
  const a = makeTempId()
  const b = makeTempId()
  assert(isNewId(a) && isNewId(b), 'makeTempId genera ids new_…')
  assert(a !== b, 'dos ids seguidos son distintos (mismo milisegundo)')
  assert(!isNewId(7) && !isNewId('7'), 'ids de BD no son new')
}

{
  console.log('\n[2] applyEdit: dirty por valor, revertir limpia')
  let e = {}
  e = applyEdit(e, 1, 'max_price', '150', 120)
  assert(eq(e, { 1: { max_price: '150' } }), 'tipear un valor distinto crea el edit')
  e = applyEdit(e, 1, 'max_price', '120', 120)
  assert(eq(e, {}), "volver al valor de BD ('120' vs 120) saca la fila de edits")
  e = applyEdit(e, 2, 'note', '', null)
  assert(eq(e, {}), "'' vs null no cuenta como cambio")
  e = applyEdit(e, 3, 'keywords', ['a', 'b'], ['a', 'b'])
  assert(eq(e, {}), 'arrays iguales por valor no cuentan como cambio')
  e = applyEdit(e, 3, 'keywords', ['a'], ['a', 'b'])
  assert(eq(e, { 3: { keywords: ['a'] } }), 'array distinto sí es edit')
  e = applyEdit(e, 3, 'active', false, true)
  assert(eq(e[3], { keywords: ['a'], active: false }), 'varios campos en la misma fila')
}

{
  console.log('\n[3] LA CARRERA: recargar tras guardar la fila 1 no pisa la fila 2')
  const server0 = [
    { id: 1, city: 'Lima', max_price: 120 },
    { id: 2, city: 'Lima', max_price: 200 },
  ]
  let edits = {}
  edits = applyEdit(edits, 1, 'max_price', '130', 120) // fila 1 lista para guardar
  edits = applyEdit(edits, 2, 'max_price', '250', 200) // fila 2 a medio tipear
  const newRows = [{ id: 'new_x', city: 'Cusco', max_price: 90, _new: true }]

  // "guardar fila 1": se descarta SU edit y llega data fresca del servidor
  delete edits[1]
  const server1 = [
    { id: 1, city: 'Lima', max_price: 130 },
    { id: 2, city: 'Lima', max_price: 200 },
  ]
  edits = pruneEdits(edits, server1, newRows)
  const rows = mergeRows(server1, newRows, edits)

  assert(rows.find((r) => r.id === 1).max_price === 130, 'fila 1 muestra el valor guardado')
  assert(rows.find((r) => r.id === 2).max_price === '250', 'fila 2 CONSERVA lo tipeado')
  assert(rows.find((r) => r.id === 'new_x')?._new === true, 'la fila nueva sin guardar sigue')
  assert(rows.length === 3, 'servidor + nuevas, sin duplicados')
}

{
  console.log('\n[4] pruneEdits: solo descarta edits de filas que desaparecieron')
  const edits = { 1: { a: 1 }, 2: { a: 2 }, new_1: { a: 3 } }
  const pruned = pruneEdits(edits, [{ id: 1 }], [{ id: 'new_1' }])
  assert(eq(pruned, { 1: { a: 1 }, new_1: { a: 3 } }), 'la fila 2 (borrada por otra sesión) se va')
  assert(eq(pruneEdits({ 5: { x: 1 } }, [{ id: 5 }], []), { 5: { x: 1 } }), 'id numérico vs key string')
}

{
  console.log('\n[5] mergeRows aplica edits sin mutar el original')
  const server = [{ id: 1, a: 'x' }]
  const rows = mergeRows(server, [], { 1: { a: 'y' } })
  assert(rows[0].a === 'y' && server[0].a === 'x', 'edit aplicado, servidor intacto')
  assert(eq(mergeRows(null, null, {}), []), 'tolera null')
}

console.log('\n══ dbErrorText ══')
{
  const t = (k) => `<${k}>`
  console.log('\n[6] códigos de Postgres / PostgREST')
  assert(dbErrorKind({ code: '23505', message: 'duplicate key value violates unique constraint "x"' }) === 'duplicate', '23505 → duplicate')
  assert(dbErrorKind({ code: '23503' }) === 'reference', '23503 → reference')
  assert(dbErrorKind({ code: '42501', message: 'new row violates row-level security policy for table "roles"' }) === 'permission', '42501 → permission')
  assert(dbErrorKind({ code: '23514' }) === 'check', '23514 → check')
  assert(dbErrorKind({ code: '23502' }) === 'not_null', '23502 → not_null')
  assert(dbErrorKind({ code: '22P02' }) === 'invalid_format', '22P02 → invalid_format')
  assert(dbErrorKind({ code: 'PGRST301', message: 'JWT expired' }) === 'session_expired', 'PGRST301 → session_expired')
  assert(dbErrorKind({ code: 'PGRST203', message: 'Could not choose the best candidate function' }) === 'postgrest', 'PGRST203 → postgrest')
  assert(dbErrorKind({ code: 23505 }) === 'duplicate', 'código numérico también')

  console.log('\n[7] sin código: por mensaje')
  assert(dbErrorKind(new TypeError('Failed to fetch')) === 'network', 'Failed to fetch → network')
  assert(dbErrorKind('Load failed') === 'network', 'Safari "Load failed" → network')
  assert(dbErrorKind({ message: 'canceling statement due to statement timeout' }) === 'timeout', 'timeout')
  assert(dbErrorKind({ message: 'permission denied for table foo' }) === 'permission', 'permission denied')
  assert(dbErrorKind({ message: 'algo raro' }) === 'generic', 'desconocido → generic')
  assert(dbErrorKind(null) === 'generic', 'null → generic')

  console.log('\n[8] dbErrorText devuelve la clave i18n, nunca el mensaje crudo')
  const raw = 'new row violates row-level security policy for table "section_write_grants"'
  const out = dbErrorText(t, { code: '42501', message: raw })
  assert(out === '<errors.db.permission>', 'clave errors.db.permission')
  assert(!out.includes('section_write_grants'), 'no filtra el nombre de la tabla/política')
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) {
  console.log('Failures:\n  - ' + failures.join('\n  - '))
  process.exit(1)
}
