// ════════════════════════════════════════════════════════════════════════
// Derivados de Ingresar CI (src/lib/dataEntry/derived.js): pestañas por
// ciudad (buildCityClusters) y rastro de revisiones (computeRevisionInfo).
// Run: node scripts/test-data-entry-derived.mjs
// ════════════════════════════════════════════════════════════════════════

import { buildCityClusters, computeRevisionInfo } from '../src/lib/dataEntry/derived.js'

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

console.log('\nbuildCityClusters')
{
  const clusters = buildCityClusters(
    ['Lima', 'Corp', 'Lima_Airport_B', 'Lima_Airport_A', 'Trujillo', 'Arequipa_Airport_A'],
    { Lima: ['Economy', 'TukTuk'], Trujillo: ['Economy'] }
  )
  const lima = clusters.find((c) => c.base === 'Lima')
  ok(
    clusters.map((c) => c.base).join(',') === 'Lima,Trujillo,Arequipa',
    'una entrada por ciudad base, en orden de aparición'
  )
  ok(
    lima.tabs.map((t) => t.type).join(',') === 'normal,corp,airport,tuktuk',
    'Lima: Normal → Corp → Aeropuerto → TukTuk'
  )
  const ap = lima.tabs.find((t) => t.type === 'airport')
  ok(ap.members.map((m) => m.side).join('') === 'AB', 'Punto A antes que B aunque lleguen al revés')
  ok(ap.members[0].uiCity === 'Lima_Airport_A', 'el miembro conserva su uiCity completo')
  ok(
    lima.tabs.find((t) => t.type === 'tuktuk').baseUiCity === 'Lima',
    'TukTuk solo en la ciudad con esa categoría'
  )
  const tru = clusters.find((c) => c.base === 'Trujillo')
  ok(tru.tabs.length === 1 && tru.tabs[0].type === 'normal', 'Trujillo: solo Normal')
  const aqp = clusters.find((c) => c.base === 'Arequipa')
  ok(
    aqp.tabs.length === 1 && aqp.tabs[0].type === 'airport',
    'aeropuerto sin ciudad normal crea el cluster igual'
  )
}
{
  const clusters = buildCityClusters(['Corp', 'Quito'], { Quito: ['Economy'] })
  ok(
    clusters.some((c) => c.base === 'Corp'),
    'Corp sin Lima en el país queda como cluster propio (sin "Lima" fantasma)'
  )
  ok(!clusters.some((c) => c.base === 'Lima'), 'no aparece un cluster Lima inventado')
}
ok(buildCityClusters([], {}).length === 0, 'sin ciudades → sin clusters')

console.log('\ncomputeRevisionInfo')
{
  const hist = [
    {
      id: 1,
      city: 'Lima',
      zone: null,
      observed_date: '2026-09-01',
      started_at: '2026-09-01T09:00:00Z',
      user_email: 'a@x',
    },
    {
      id: 2,
      city: 'Lima',
      zone: null,
      observed_date: '2026-09-01',
      started_at: '2026-09-01T15:00:00Z',
      user_email: 'b@x',
    },
    {
      id: 3,
      city: 'Lima',
      zone: 'Comas',
      observed_date: '2026-09-01',
      started_at: '2026-09-01T10:00:00Z',
      user_email: 'c@x',
    },
    {
      id: 4,
      city: 'Lima',
      zone: null,
      observed_date: '2026-09-02',
      started_at: '2026-09-02T10:00:00Z',
      user_email: 'a@x',
    },
  ]
  const info = computeRevisionInfo(hist)
  ok(Object.keys(info).length === 1, 'solo el grupo con 2+ filas genera resumen')
  ok(
    info[2] && info[2].count === 2 && info[2].lastEditor === 'b@x',
    'el resumen cuelga de la fila MÁS RECIENTE del grupo, con el último editor'
  )
  ok(!info[1] && !info[3] && !info[4], 'las demás filas no llevan resumen')
  ok(!info[3], 'un distrito TukTuk es su propio grupo (zone distingue)')
}
ok(Object.keys(computeRevisionInfo([])).length === 0, 'historial vacío → {}')
{
  const info = computeRevisionInfo([
    {
      id: 1,
      city: 'Lima',
      zone: '',
      observed_date: '2026-09-01',
      started_at: '2026-09-01T09:00:00Z',
      user_email: 'a@x',
    },
    {
      id: 2,
      city: 'Lima',
      zone: null,
      observed_date: '2026-09-01',
      started_at: '2026-09-01T10:00:00Z',
      user_email: 'a@x',
    },
  ])
  ok(info[2]?.count === 2, "zone '' y null son el mismo grupo")
}

console.log(`\n${pass} ok, ${fail} fallos`)
if (fail) {
  console.log(fallos.map((f) => `  - ${f}`).join('\n'))
  process.exit(1)
}
