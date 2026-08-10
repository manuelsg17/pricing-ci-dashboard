// ════════════════════════════════════════════════════════════════════════
// lazyConReintento — una pestaña vieja se cura sola cuando un deploy le
// borra el chunk, PERO SIN entrar en loop y sin dejar al hub colgado.
//
// Las cuatro guardas existen cada una por un modo de falla concreto, y las
// tres primeras son las que separan "se cura solo" de "recarga para siempre".
// Ver la cabecera de src/lib/lazyConReintento.js.
// ════════════════════════════════════════════════════════════════════════

import {
  decidirReintento,
  reportarChunkFallido,
  esErrorDeChunk,
} from '../src/lib/lazyConReintento.js'

let pass = 0
let fail = 0
const fallos = []
function ok(cond, label) {
  if (cond) pass++
  else {
    fail++
    fallos.push(label)
    console.error(`  ✗ ${label}`)
  }
}
function eq(a, b, label) {
  const good = JSON.stringify(a) === JSON.stringify(b)
  if (!good) console.error(`     esperado ${JSON.stringify(b)}, obtuve ${JSON.stringify(a)}`)
  ok(good, label)
}

// ── [1] La decisión ───────────────────────────────────────────────────
console.log('[1] decidirReintento: las tres salidas')

eq(
  decidirReintento({ yaReintento: false, puedeMarcar: true }),
  'reintentar',
  'primer fallo con storage disponible → recarga una vez'
)
eq(
  decidirReintento({ yaReintento: true, puedeMarcar: true }),
  'rendirse',
  'segundo fallo de la MISMA ruta → se rinde y el boundary muestra el error'
)
// El modo de falla más caro: sin sessionStorage no hay forma de saber si ya
// se reintentó, así que recargar sería un loop infinito — el hub se queda sin
// app y sin ningún mensaje. Se prefiere el error visible.
eq(
  decidirReintento({ yaReintento: false, puedeMarcar: false }),
  'rendirse',
  'sin sessionStorage NO se recarga (sería un loop infinito)'
)

// ── [2] El loop infinito que evita usar la ruta como clave ────────────
console.log('\n[2] la clave es la RUTA, no el asset hasheado')

// Si la marca se guardara con el nombre del archivo, tras recargar el bundle
// nuevo pediría OTRO hash, la marca vieja no coincidiría, y el segundo fallo
// se leería como "primero": recarga para siempre. Se simula la secuencia real
// de dos builds distintos.
{
  const marcas = new Set()
  const intentar = (clave) => {
    const ya = marcas.has(clave)
    const d = decidirReintento({ yaReintento: ya, puedeMarcar: true })
    if (d === 'reintentar') marcas.add(clave)
    return d
  }
  // CON clave estable (lo implementado)
  eq(intentar('dataentry'), 'reintentar', 'build A falla → recarga')
  eq(intentar('dataentry'), 'rendirse', 'build B también falla → SE RINDE, no hay loop')

  // CON clave hasheada (lo que NO se hizo) — se documenta el contraste
  const m2 = new Set()
  const intentarHash = (asset) => {
    const ya = m2.has(asset)
    const d = decidirReintento({ yaReintento: ya, puedeMarcar: true })
    if (d === 'reintentar') m2.add(asset)
    return d
  }
  eq(intentarHash('DataEntry-AAAA.js'), 'reintentar', 'con hash: build A falla → recarga')
  eq(
    intentarHash('DataEntry-BBBB.js'),
    'reintentar',
    'con hash: el build B es otra clave → recargaría OTRA vez (el loop que se evitó)'
  )
}

// ── [3] La telemetría sobrevive a la recarga ──────────────────────────
console.log('\n[3] reportarChunkFallido: la miga se manda después de recargar')

// `location.reload()` cancela cualquier fetch en vuelo, así que reportar antes
// de recargar pierde el dato justo en el caso que interesa medir.
{
  const store = new Map()
  globalThis.sessionStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  }

  const enviados = []
  const reportar = (a) => enviados.push(a)

  eq(reportarChunkFallido(reportar), false, 'sin miga no se reporta nada')

  store.set(
    'de:chunk-retry:pendiente',
    JSON.stringify({ clave: 'dataentry', mensaje: 'Failed to fetch dynamically imported module' })
  )
  eq(reportarChunkFallido(reportar), true, 'con miga sí reporta')
  eq(enviados.length, 1, 'y manda exactamente un error')
  ok(
    enviados[0].label === 'chunk:dataentry',
    'etiquetado con la ruta, para poder agrupar en client_errors'
  )
  ok(
    /Failed to fetch dynamically imported module/.test(enviados[0].error.message),
    'conserva el mensaje original del navegador'
  )

  // La miga se consume: si no, cada arranque volvería a reportar lo mismo.
  eq(reportarChunkFallido(reportar), false, 'la miga se consume — no se reporta dos veces')
  eq(enviados.length, 1, 'sigue habiendo un solo envío')

  // Basura en sessionStorage (otra versión de la app, una extensión) no puede
  // romper el arranque: es lo primero que corre.
  store.set('de:chunk-retry:pendiente', '{roto')
  eq(reportarChunkFallido(reportar), false, 'una miga corrupta no rompe el arranque')

  delete globalThis.sessionStorage
}

// ─────────────────────────────────────────────────────────────────────
// [4] esErrorDeChunk — separar "tenés la pestaña vieja" de "se rompió algo"
//
// La distinción no es cosmética: decide qué le decimos al hub. Un chunk
// viejo se arregla recargando y no es culpa suya; un bug de verdad no se
// arregla recargando, y mandarlo a recargar lo hace dar vueltas sin salir.
// Los mensajes de abajo son los TEXTOS REALES que quedaron registrados en
// `client_errors` de producción entre el 3 y el 8 de agosto de 2026.
// ─────────────────────────────────────────────────────────────────────
{
  console.log('\n[4] esErrorDeChunk')

  const deChunk = [
    'Failed to fetch dynamically imported module: https://x/assets/Dashboard-CQqO53v0.js',
    'Unable to preload CSS for https://x/assets/data-entry-CAssG2ox.css',
    'error loading dynamically imported module',            // Firefox
    'Importing a module script failed.',                    // Safari
    'Failed to load module script: expected a JavaScript module',
  ]
  for (const m of deChunk) {
    ok(esErrorDeChunk(new Error(m)), `reconoce: ${m.slice(0, 42)}…`)
  }

  // Mayúsculas/minúsculas no pueden cambiar la respuesta: cada motor redacta
  // distinto y no hay ningún código de error con el que razonar.
  ok(esErrorDeChunk(new Error('FAILED TO FETCH DYNAMICALLY IMPORTED MODULE')), 'no distingue mayúsculas')
  ok(esErrorDeChunk('Unable to preload CSS for /a.css'), 'acepta un string suelto, no solo un Error')

  // Y sobre todo: NO puede tragarse errores de verdad. Un falso positivo acá
  // le muestra al hub "la app se actualizó, recargá" ante un bug real, y el
  // bug se vuelve invisible porque el mensaje suena a trámite.
  const deVerdad = [
    "Cannot read properties of undefined (reading 'map')",
    'TypeError: x is not a function',
    'Network request failed',
    'Failed to fetch',                       // ojo: parecido pero NO es de chunk
    'save_ci_batch: country, city y date son obligatorios',
  ]
  for (const m of deVerdad) {
    ok(!esErrorDeChunk(new Error(m)), `NO se traga: ${m.slice(0, 42)}`)
  }

  ok(!esErrorDeChunk(null), 'null no rompe')
  ok(!esErrorDeChunk(undefined), 'undefined tampoco')
  ok(!esErrorDeChunk(new Error('')), 'mensaje vacío no es de chunk')
}

console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} pasaron, ${fail} fallaron`)
if (fail) console.error('Fallaron:\n  - ' + fallos.join('\n  - '))
process.exit(fail === 0 ? 0 : 1)
