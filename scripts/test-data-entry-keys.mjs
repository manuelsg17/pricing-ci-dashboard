// ════════════════════════════════════════════════════════════════════════
// Claves de Ingresar CI (src/lib/dataEntry/keys.js).
//
// Los tres namespaces (uiCity / bucketKey / viewId) NO son intercambiables
// (CLAUDE.md §1). Estos tests fijan los FORMATOS exactos: cambiar uno de estos
// strings invalida borradores en localStorage de todos los hubs (de:draft:…),
// el guard "recién terminado" (de:finished:…) o la marca de agua (de:seq:…).
// Run: node scripts/test-data-entry-keys.mjs
// ════════════════════════════════════════════════════════════════════════

import {
  priceKey,
  indKey,
  bucketKeyFor,
  viewIdFor,
  draftKeyFor,
  legacyDraftKeyFor,
  draftKeyPrefixFor,
  bucketFinishedLsKeyFor,
  syncSeqKeyFor,
} from '../src/lib/dataEntry/keys.js'

let pass = 0
let fail = 0
const fallos = []
function ok(cond, label) {
  if (cond) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    fallos.push(label)
    console.log(`  ✗ ${label}`)
  }
}

console.log('\nclaves de celda')
ok(
  priceKey('Economy', 42, 'Mañana', 'Uber') === 'Economy|42|Mañana|Uber',
  'priceKey uiCat|refId|ts|comp'
)
ok(indKey('Economy', 42, 'Mañana') === 'Economy|42|Mañana', 'indKey uiCat|refId|ts')
ok(
  `${indKey('E', 1, 'T')}|InDrive` === priceKey('E', 1, 'T', 'InDrive'),
  'indKey + "|InDrive" = priceKey de InDrive (lo asume countAllFilled)'
)
ok(
  priceKey('E', 1, 'Mañana', 'Uber').split('|')[2] === 'Mañana',
  'el 3er segmento es la franja (lo asume countFilledByTimeslot)'
)

console.log('\nbucketKey / viewId')
ok(bucketKeyFor('Lima', null, false) === 'Lima', 'vista normal: bucketKey = dbCity')
ok(bucketKeyFor('Lima', 'Comas', true) === 'TT~Lima~Comas', 'TukTuk: clave sintética por distrito')
ok(
  bucketKeyFor('Lima', 'Comas', true) !== bucketKeyFor('Lima', 'SJL', true),
  'dos distritos no comparten rebanada'
)
ok(
  bucketKeyFor('Lima_Airport_A', null, false) === 'Lima_Airport_A',
  'aeropuerto: su propia ciudad de BD'
)
ok(
  viewIdFor('Bogotá', 'Bogota', null, false) === 'Bogotá',
  'vista normal: viewId = uiCity (NO dbCity)'
)
ok(viewIdFor('Lima', 'Lima', 'Comas', true) === 'TT~Lima~Comas', 'TukTuk: viewId lleva el distrito')
ok(
  viewIdFor('Lima', 'Lima', 'Comas', true) === bucketKeyFor('Lima', 'Comas', true),
  'en TukTuk viewId y bucketKey coinciden (lo asume el escaneo de borradores)'
)

console.log('\nborrador en localStorage')
ok(
  draftKeyFor('ana@x.com', 'Peru', 'Lima', '2026-09-04') ===
    'de:draft:ana@x.com:Peru:Lima:2026-09-04',
  'formato de:draft:<email>:<país>:<vista>:<fecha>'
)
ok(
  legacyDraftKeyFor('Peru', 'Lima', '2026-09-04') === 'de:draft:Peru:Lima:2026-09-04',
  'clave legacy sin email'
)
ok(
  draftKeyFor('ana@x.com', 'Peru', 'Lima', '2026-09-04').startsWith(
    draftKeyPrefixFor('ana@x.com', 'Peru')
  ),
  'el prefijo de escaneo matchea la clave completa'
)
ok(
  !draftKeyFor('bob@x.com', 'Peru', 'Lima', '2026-09-04').startsWith(
    draftKeyPrefixFor('ana@x.com', 'Peru')
  ),
  'otro hub NO entra en el escaneo (laptop compartida)'
)
ok(
  !draftKeyFor('ana@x.com', 'Colombia', 'Bogotá', '2026-09-04').startsWith(
    draftKeyPrefixFor('ana@x.com', 'Peru')
  ),
  'otro país NO entra en el escaneo'
)
{
  const k = draftKeyFor('ana@x.com', 'Peru', 'TT~Lima~Comas', '2026-09-04')
  const rest = k.slice(draftKeyPrefixFor('ana@x.com', 'Peru').length)
  const sep = rest.lastIndexOf(':')
  ok(
    rest.slice(0, sep) === 'TT~Lima~Comas' && rest.slice(sep + 1) === '2026-09-04',
    'el escaneo recupera viewId y fecha con lastIndexOf(":")'
  )
}

console.log('\nguard "recién terminado" y marca de agua')
ok(
  bucketFinishedLsKeyFor('ana@x.com', 'TT~Lima~Comas', '2026-09-04') ===
    'de:finished:ana@x.com:TT~Lima~Comas:2026-09-04',
  'formato de:finished:<email>:<bucket>:<fecha>'
)
ok(
  syncSeqKeyFor('Peru', 'Lima', null, '2026-09-04') === 'de:seq:Peru|Lima||2026-09-04',
  'zone null → segmento vacío'
)
ok(
  syncSeqKeyFor('Peru', 'Lima', 'Comas', '2026-09-04') === 'de:seq:Peru|Lima|Comas|2026-09-04',
  'zone con distrito'
)
ok(
  syncSeqKeyFor('Peru', 'Lima', null, '2026-09-04') ===
    syncSeqKeyFor('Peru', 'Lima', undefined, '2026-09-04'),
  'null y undefined dan la misma clave'
)

console.log(`\n${pass} ok, ${fail} fallos`)
if (fail) {
  console.log(fallos.map((f) => `  - ${f}`).join('\n'))
  process.exit(1)
}
