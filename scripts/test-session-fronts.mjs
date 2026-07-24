// Tests de src/lib/sessionFronts.js — la lista de frentes abiertos que viaja
// en el latido (mig 161) para que Monitoreo y la presencia vean TODO lo que un
// hub tiene a medias, no solo la pestaña donde está parado.
//
// Varios casos de acá son regresiones de bugs REALES encontrados el 2026-07-24
// al liberar la navegación entre pestañas — están marcados con [BUG REAL].
import { buildFronts, parseBucketKey, frontLabel, MAX_FRONTS } from '../src/lib/sessionFronts.js'

let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name}${extra ? ` → ${extra}` : ''}`)
  }
}
const eq = (name, actual, expected) =>
  check(
    name,
    JSON.stringify(actual) === JSON.stringify(expected),
    `esperado ${JSON.stringify(expected)}, fue ${JSON.stringify(actual)}`
  )

console.log('\n══ sessionFronts tests ══\n')

console.log('[1] parseBucketKey: las 2 formas reales de bucket')
eq('ciudad normal', parseBucketKey('Lima'), { city: 'Lima', zone: null })
eq('Corp', parseBucketKey('Corp'), { city: 'Corp', zone: null })
eq('punto de aeropuerto', parseBucketKey('Lima_Airport_A'), {
  city: 'Lima_Airport_A',
  zone: null,
})
eq('TukTuk por distrito', parseBucketKey('TT~Lima~Comas'), { city: 'Lima', zone: 'Comas' })

console.log('\n[2] parseBucketKey: entradas corruptas NO deben viajar al servidor')
// Estas filas se expanden a presencia y las ven OTROS hubs — un bucket
// malformado generaría un puntito verde en un lugar que no existe.
check('null → null', parseBucketKey(null) === null)
check('string vacío → null', parseBucketKey('') === null)
check('no-string → null', parseBucketKey(42) === null)
check('TT~ sin distrito → null', parseBucketKey('TT~Lima') === null)
check('TT~ con distrito vacío → null', parseBucketKey('TT~Lima~') === null)
check('TT~ con ciudad vacía → null', parseBucketKey('TT~~Comas') === null)
check('TT~ con separadores de más → null', parseBucketKey('TT~Lima~Comas~x') === null)

console.log('\n[3] frontLabel: legible para el hub y para el admin')
eq('aeropuerto muestra el punto', frontLabel('Lima_Airport_B'), 'Lima Aeropuerto · Punto B')
eq('TukTuk muestra el distrito', frontLabel('TT~Lima~Comas'), 'Lima TukTuk · Comas')
eq('ciudad normal', frontLabel('Lima'), 'Lima')
check('bucket corrupto no crashea', typeof frontLabel('TT~roto') === 'string')

console.log('\n[4] buildFronts: caso base — solo la vista actual')
{
  const f = buildFronts({
    scopeMembers: ['Lima'],
    currentBucket: 'Lima',
    filledByBucket: { Lima: 5 },
    totalByBucket: { Lima: 306 },
  })
  eq('un solo frente', f.length, 1)
  eq('marcado como actual', f[0].current, true)
  eq('lleva filled/total', [f[0].filled, f[0].total], [5, 306])
}

console.log('\n[5] buildFronts: el hub está en Corp con Aeropuerto A+B a medias')
// El caso que motivó la mig 161: antes Monitoreo solo veía Corp.
{
  const f = buildFronts({
    scopeMembers: ['Lima_Airport_A', 'Lima_Airport_B'],
    extraFronts: ['Corp'],
    currentBucket: 'Corp',
    filledByBucket: { Lima_Airport_A: 324, Lima_Airport_B: 100, Corp: 5 },
    totalByBucket: { Lima_Airport_A: 324, Lima_Airport_B: 324, Corp: 162 },
  })
  eq('los 3 frentes viajan', f.map((x) => x.bucket), [
    'Lima_Airport_A',
    'Lima_Airport_B',
    'Corp',
  ])
  eq('solo Corp es el actual', f.filter((x) => x.current).map((x) => x.bucket), ['Corp'])
  eq('conserva el progreso de los no-actuales', [f[0].filled, f[1].filled], [324, 100])
}

console.log('\n[6] [BUG REAL] la vista actual SIEMPRE viaja, aunque no haya escrito nada')
// El user pidió explícitamente "debería mostrarme siempre en dónde está ahora
// mismo avanzando". Si el hub acaba de llegar a una pestaña, no está en
// scopeMembers ni en extraFronts todavía.
{
  const f = buildFronts({
    scopeMembers: ['Lima_Airport_A'],
    extraFronts: [],
    // DataEntry SIEMPRE conoce el llenado de la vista actual, así que lo pasa
    // explícito aunque el hub recién haya llegado (0 real, no desconocido).
    currentBucket: 'TT~Lima~SJL',
    filledByBucket: { Lima_Airport_A: 10, 'TT~Lima~SJL': 0 },
    totalByBucket: {},
  })
  eq('incluye la vista recién abierta', f.map((x) => x.bucket), [
    'Lima_Airport_A',
    'TT~Lima~SJL',
  ])
  eq('y la marca como actual', f.find((x) => x.bucket === 'TT~Lima~SJL').current, true)
  eq('con 0 real, no undefined', f.find((x) => x.bucket === 'TT~Lima~SJL').filled, 0)
  // Y la contracara: un bucket SIN entrada es desconocido, no cero.
  check(
    'bucket ausente del mapa = null (desconocido)',
    buildFronts({ scopeMembers: ['X'], currentBucket: 'X' })[0].filled === null
  )
}

console.log('\n[7] [BUG REAL] total desconocido viaja como null, NUNCA como 0')
// Monitoreo muestra "N/M": si un total desconocido llegara como 0, el admin
// vería "10/0" (o un 100% falso) para un frente que el hub no visitó todavía.
{
  const f = buildFronts({
    scopeMembers: ['Lima_Airport_A', 'Lima_Airport_B'],
    currentBucket: 'Lima_Airport_A',
    filledByBucket: { Lima_Airport_A: 10, Lima_Airport_B: 3 },
    totalByBucket: { Lima_Airport_A: 324 }, // B nunca visitado
  })
  eq('total conocido', f[0].total, 324)
  check('total desconocido = null', f[1].total === null, `fue ${f[1].total}`)
  check('nunca 0', f.every((x) => x.total !== 0))
}
{
  const f = buildFronts({
    scopeMembers: ['Lima'],
    currentBucket: 'Lima',
    totalByBucket: { Lima: 0 },
  })
  check('total 0 explícito también se normaliza a null', f[0].total === null)
}

console.log('\n[8] [BUG REAL] sin duplicados aunque el bucket esté en varias listas')
// `pendingScopeMembers` y `pendingExtraFronts` son listas separadas; un bucket
// puede aparecer en ambas por una condición de carrera. Duplicar un frente
// duplicaría también su fila de presencia para los otros hubs.
{
  const f = buildFronts({
    scopeMembers: ['Corp', 'Lima'],
    extraFronts: ['Corp', 'Lima'],
    currentBucket: 'Corp',
    filledByBucket: { Corp: 1, Lima: 2 },
  })
  eq('deduplicado', f.map((x) => x.bucket), ['Corp', 'Lima'])
  eq('un solo actual', f.filter((x) => x.current).length, 1)
}

console.log('\n[9] [BUG REAL] buckets corruptos se descartan, no se propagan')
{
  const f = buildFronts({
    scopeMembers: ['Lima', '', null, 'TT~roto', undefined],
    currentBucket: 'Lima',
    filledByBucket: { Lima: 1 },
  })
  eq('solo sobrevive el válido', f.map((x) => x.bucket), ['Lima'])
}

console.log('\n[9b] [BUG REAL] bucket TukTuk con distrito sin resolver no viaja')
// `bucketKey` se arma interpolando: con zone null da la STRING 'TT~Lima~null'.
// Pasa al abrir la pestaña TukTuk de una ciudad sin distritos habilitados.
check("TT~Lima~null → null", parseBucketKey('TT~Lima~null') === null)
check("TT~Lima~undefined → null", parseBucketKey('TT~Lima~undefined') === null)
{
  const f = buildFronts({
    scopeMembers: ['Lima', 'TT~Lima~null'],
    currentBucket: 'Lima',
    filledByBucket: { Lima: 3 },
  })
  eq('el bucket corrupto no llega al servidor', f.map((x) => x.bucket), ['Lima'])
}

console.log('\n[9c] [BUG REAL] filled desconocido viaja como null, NUNCA como 0')
// La grilla se hidrata por bucket visitado: tras un refresh, un frente que el
// hub no volvió a abrir no tiene datos en memoria. Un 0 afirmativo haría que
// el admin creyera que ese frente no arrancó y decidiera reasignarlo.
{
  const f = buildFronts({
    scopeMembers: ['Lima_Airport_A', 'Lima_Airport_B'],
    currentBucket: 'Lima_Airport_A',
    filledByBucket: { Lima_Airport_A: 10, Lima_Airport_B: null },
    totalByBucket: { Lima_Airport_A: 324, Lima_Airport_B: 324 },
  })
  eq('el visitado lleva su número', f[0].filled, 10)
  check('el no hidratado = null', f[1].filled === null, `fue ${f[1].filled}`)
}
{
  const f = buildFronts({
    scopeMembers: ['Lima'],
    currentBucket: 'Lima',
    filledByBucket: { Lima: 0 },
  })
  check('un 0 REAL sigue siendo 0, no null', f[0].filled === 0)
}

console.log('\n[10] buildFronts: tope defensivo, sin perder "dónde está ahora"')
{
  const many = Array.from({ length: MAX_FRONTS + 5 }, (_, i) => `Ciudad${i}`)
  const f = buildFronts({
    scopeMembers: many,
    currentBucket: 'CiudadActual',
    filledByBucket: {},
  })
  check(`no supera el tope (${MAX_FRONTS})`, f.length <= MAX_FRONTS, `fue ${f.length}`)
  check(
    'el frente actual entra igual aunque el tope lo recortara',
    f.some((x) => x.bucket === 'CiudadActual' && x.current),
    JSON.stringify(f.map((x) => x.bucket))
  )
}

console.log('\n[11] buildFronts: entradas vacías no crashean')
{
  eq('sin argumentos', buildFronts(), [])
  eq('todo vacío', buildFronts({ scopeMembers: [], extraFronts: [], currentBucket: null }), [])
}

console.log('\n[12] forma exacta del elemento (contrato con la mig 161 y Monitoreo)')
{
  const f = buildFronts({
    scopeMembers: ['TT~Lima~Comas'],
    currentBucket: 'TT~Lima~Comas',
    filledByBucket: { 'TT~Lima~Comas': 4 },
    totalByBucket: { 'TT~Lima~Comas': 24 },
  })
  eq('claves y valores', f[0], {
    bucket: 'TT~Lima~Comas',
    city: 'Lima',
    zone: 'Comas',
    filled: 4,
    total: 24,
    current: true,
  })
  check(
    'city/zone coinciden con las columnas de pricing_observations',
    f[0].city === 'Lima' && f[0].zone === 'Comas'
  )
}

console.log(`\nResultado: ${pass} pasados / ${fail} fallidos`)
if (fail > 0) process.exit(1)
console.log('Todo OK ✓')
