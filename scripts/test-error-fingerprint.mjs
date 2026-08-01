// Tests de la lógica pura del reporte de errores (mig 185).
//
// Por qué merece test propio: los dos modos de falla son silenciosos y
// opuestos. Si la huella es INESTABLE, el servidor no agrupa y cada
// repetición crea una fila — la bitácora se vuelve ilegible justo cuando más
// se la necesita. Si el limitador NO corta, un componente que crashea en loop
// de render escribe miles de filas en segundos. Ninguno de los dos da error.

import {
  hash,
  firstFrameOf,
  fingerprintOf,
  canSend,
  THROTTLE_MS,
  MAX_PER_LOAD,
} from '../src/lib/errorFingerprint.js'

let pass = 0
let fail = 0

function ok(cond, label) {
  if (cond) {
    pass++
  } else {
    fail++
    console.error(`  ✗ ${label}`)
  }
}

function eq(a, b, label) {
  const good = a === b
  if (!good) console.error(`     esperado ${JSON.stringify(b)}, obtuve ${JSON.stringify(a)}`)
  ok(good, label)
}

// ── [1] hash ──────────────────────────────────────────────────────────
console.log('[1] hash')
eq(hash('abc'), hash('abc'), 'es determinista')
ok(hash('abc') !== hash('abd'), 'distingue entradas parecidas')
ok(/^[a-z0-9]+$/.test(hash('cualquier cosa')), 'sale alfanumérico (cabe en text)')
eq(hash(''), hash(''), 'string vacío no rompe')

// ── [2] firstFrameOf ──────────────────────────────────────────────────
console.log('[2] firstFrameOf')
const stackV8 = `TypeError: x is not a function
    at DataEntry (http://localhost:5173/src/pages/DataEntry.jsx:120:5)
    at renderWithHooks (http://localhost:5173/node_modules/react-dom.js:1:1)`
ok(firstFrameOf(stackV8).includes('DataEntry.jsx:120'), 'toma el primer frame de V8')

const stackFirefox = `foo@http://localhost:5173/src/lib/a.js:10:3
bar@http://localhost:5173/src/lib/b.js:20:4`
ok(firstFrameOf(stackFirefox).includes('a.js:10'), 'entiende el formato de Firefox')

eq(firstFrameOf(null), '', 'stack nulo devuelve vacío, no rompe')
eq(firstFrameOf(''), '', 'stack vacío devuelve vacío')
eq(firstFrameOf('sin frames aquí'), '', 'texto sin frames devuelve vacío')

// ── [3] fingerprintOf — estabilidad ───────────────────────────────────
console.log('[3] fingerprintOf: mismo error → misma huella')
const base = { source: 'boundary', label: 'Dashboard', message: 'x is undefined', stack: stackV8 }
eq(fingerprintOf(base), fingerprintOf({ ...base }), 'dos llamadas iguales dan la misma huella')

// El caso que importa de verdad: el MISMO bug en dos sesiones distintas debe
// agruparse. Si la huella dependiera de algo variable (hora, id de sesión),
// cada carga de página crearía una fila nueva.
eq(
  fingerprintOf(base),
  fingerprintOf({ ...base, stack: stackV8 }),
  'se agrupa entre sesiones distintas'
)

// ── [4] fingerprintOf — discriminación ────────────────────────────────
console.log('[4] fingerprintOf: errores distintos → huellas distintas')
ok(fingerprintOf(base) !== fingerprintOf({ ...base, message: 'otro error' }), 'distingue mensaje')
ok(fingerprintOf(base) !== fingerprintOf({ ...base, source: 'section' }), 'distingue origen')
ok(fingerprintOf(base) !== fingerprintOf({ ...base, label: 'Market' }), 'distingue sección')

// El más importante: el mismo mensaje genérico desde DOS lugares distintos NO
// puede agruparse. "Cannot read properties of undefined" sale de veinte
// lugares y agruparlos todos haría el reporte inservible.
const generico = { source: 'boundary', label: null, message: 'Cannot read properties of undefined' }
ok(
  fingerprintOf({ ...generico, stack: 'at Market (Market.jsx:10:1)' }) !==
    fingerprintOf({ ...generico, stack: 'at Coverage (Coverage.jsx:88:1)' }),
  'el mismo mensaje genérico desde distinto origen NO se agrupa'
)

console.log('[5] fingerprintOf: entradas degeneradas')
ok(typeof fingerprintOf({}) === 'string', 'objeto vacío no rompe')
ok(typeof fingerprintOf() === 'string', 'sin argumentos no rompe')
eq(
  fingerprintOf({ source: 'window', message: 'a'.repeat(500) }),
  fingerprintOf({ source: 'window', message: 'a'.repeat(500) + 'DISTINTO' }),
  'mensajes larguísimos se truncan igual a 200 (siguen agrupando)'
)

// ── [6] canSend — throttle ────────────────────────────────────────────
console.log('[6] canSend: throttle por huella')
const fresco = () => ({ sentCount: 0, lastSentAt: new Map(), sending: false })

let st = fresco()
eq(canSend(st, 'fp1', 1000).ok, true, 'la primera vez pasa')

st = fresco()
st.lastSentAt.set('fp1', 1000)
eq(canSend(st, 'fp1', 1000 + THROTTLE_MS - 1).reason, 'throttled', 'dentro de la ventana, corta')
eq(canSend(st, 'fp1', 1000 + THROTTLE_MS).ok, true, 'justo al vencer, pasa')
eq(canSend(st, 'fp2', 1001).ok, true, 'otra huella NO queda bloqueada por la primera')

// Un timestamp 0 es falsy: con `if (prev && ...)` en vez de un chequeo de
// undefined, el throttle se saltearía en ese borde.
st = fresco()
st.lastSentAt.set('fp1', 0)
eq(canSend(st, 'fp1', 1).reason, 'throttled', 'timestamp 0 igual cuenta (no es "sin registro")')

// ── [7] canSend — tope duro y recursión ───────────────────────────────
console.log('[7] canSend: tope duro y guard de recursión')
st = fresco()
st.sentCount = MAX_PER_LOAD - 1
eq(canSend(st, 'nueva', 1).ok, true, 'justo debajo del tope, pasa')
st.sentCount = MAX_PER_LOAD
eq(canSend(st, 'nueva', 1).reason, 'cap', 'en el tope, corta')
st.sentCount = MAX_PER_LOAD + 5
eq(canSend(st, 'nueva', 1).reason, 'cap', 'pasado el tope, sigue cortando')

st = fresco()
st.sending = true
eq(canSend(st, 'nueva', 1).reason, 'recursion', 'si ya está enviando, corta')

// La recursión gana sobre todo lo demás: es la regla que evita el loop
// infinito de "el reporte falla → se reporta el fallo → falla → ...".
st = { sentCount: 0, lastSentAt: new Map(), sending: true }
eq(canSend(st, 'nueva', 1).reason, 'recursion', 'la recursión tiene prioridad')

// ── [8] simulación: tormenta de errores ───────────────────────────────
console.log('[8] simulación: 5.000 errores idénticos en 1 segundo')
st = fresco()
let enviados = 0
for (let i = 0; i < 5000; i++) {
  const t = i // 5000 iteraciones dentro del mismo segundo
  if (canSend(st, 'loop-de-render', t).ok) {
    enviados++
    st.sentCount++
    st.lastSentAt.set('loop-de-render', t)
  }
}
eq(enviados, 1, 'una tormenta de 5.000 errores idénticos manda 1 solo reporte')

console.log('[9] simulación: 100 errores DISTINTOS')
st = fresco()
enviados = 0
for (let i = 0; i < 100; i++) {
  if (canSend(st, `fp-${i}`, i).ok) {
    enviados++
    st.sentCount++
    st.lastSentAt.set(`fp-${i}`, i)
  }
}
eq(enviados, MAX_PER_LOAD, `100 errores distintos se cortan en el tope (${MAX_PER_LOAD})`)

// ── Resultado ─────────────────────────────────────────────────────────
console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} pasaron, ${fail} fallaron`)
process.exit(fail === 0 ? 0 : 1)
