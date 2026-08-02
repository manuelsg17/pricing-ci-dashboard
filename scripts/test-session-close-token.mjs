// Simulaciones del ciclo de vida de la clave de idempotencia del cierre
// (SESIONES_HALLAZGOS.md P2-11).
//
// LA PREGUNTA QUE RESPONDEN: ¿el token distingue "reintento del mismo cierre"
// de "cierre nuevo"? Las dos respuestas equivocadas son caras y opuestas:
//   · token nuevo en un reintento  → la fila se duplica (el bug de hoy)
//   · token reusado en un cierre legítimo → la revisión del hub no se
//     registra NUNCA, y en silencio, que es peor que el duplicado.
//
// El lado servidor —que la base efectivamente ignore el reintento y acepte el
// cierre nuevo— se prueba aparte, contra Postgres real:
//   npm run simulate:session-idempotency

import {
  VENTANA_REINTENTO_MS,
  claveDeCierre,
  tokenDeCierre,
  confirmarCierre,
  _resetMemoria,
} from '../src/lib/sessionCloseToken.js'

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

// localStorage de mentira, con control explícito de fallas. Nada de esto
// puede depender del entorno real: el test corre en node plano.
function almacen({ fallaEscritura = false, fallaBorrado = false } = {}) {
  const m = new Map()
  return {
    m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => {
      if (fallaEscritura) throw new Error('QuotaExceededError')
      m.set(k, v)
    },
    removeItem: (k) => {
      if (fallaBorrado) throw new Error('SecurityError')
      m.delete(k)
    },
  }
}

const HUB = { userEmail: 'hub@local.test', bucketKey: 'Arequipa_Airport_A', fecha: '2026-08-01' }
const T0 = new Date('2026-08-01T10:00:00Z').getTime()

// ── [1] Reintento: el mismo token ──────────────────────────────────────
// El caso real documentado: 2 filas para Arequipa_Airport_A / raisalopez a
// 47 segundos de distancia, ambas con 324/324.
console.log('[1] Reintento del mismo cierre')
{
  _resetMemoria()
  const storage = almacen()
  const a = tokenDeCierre(HUB, { storage, ahora: T0 })
  const b = tokenDeCierre(HUB, { storage, ahora: T0 + 47_000 })

  eq(a.token, b.token, 'el reintento a los 47s manda el MISMO token')
  ok(a.reintento === false, 'el primer intento no es reintento')
  ok(b.reintento === true, 'el segundo sí, y se puede registrar como tal')
  eq(b.intentos, 2, 'se lleva la cuenta de intentos')
}

// ── [2] Cierre legítimamente nuevo: token distinto ─────────────────────
// Reabrir para corregir una celda es el rastro de revisiones que el user
// quiere conservar. Si esto se rompe, el fix del duplicado se come un dato.
console.log('[2] Cierre nuevo tras confirmar el anterior')
{
  _resetMemoria()
  const storage = almacen()
  const primero = tokenDeCierre(HUB, { storage, ahora: T0 })
  ok(confirmarCierre(HUB, { storage }) === true, 'el cierre confirmado retira el token')

  const segundo = tokenDeCierre(HUB, { storage, ahora: T0 + 5 * 60_000 })
  ok(segundo.token !== primero.token, 'la revisión posterior usa un token NUEVO')
  ok(segundo.reintento === false, 'y no se declara reintento')
  eq(segundo.intentos, 1, 'con la cuenta de intentos en 1')
}

// ── [3] Dos cierres en vuelo a la vez ──────────────────────────────────
// Aeropuerto "Ambos": el hub cierra Punto A y Punto B con segundos de
// diferencia. Son cierres DISTINTOS y no pueden compartir token — si lo
// compartieran, el cierre del Punto B se descartaría como duplicado del A.
// Es el mismo namespace que CLAUDE.md §1 pide no mezclar.
console.log('[3] Punto A y Punto B a la vez')
{
  _resetMemoria()
  const storage = almacen()
  const A = tokenDeCierre({ ...HUB, bucketKey: 'Arequipa_Airport_A' }, { storage, ahora: T0 })
  const B = tokenDeCierre(
    { ...HUB, bucketKey: 'Arequipa_Airport_B' },
    { storage, ahora: T0 + 6_000 }
  )
  ok(A.token !== B.token, 'dos buckets del mismo hub tienen tokens distintos')

  // Otra fecha del mismo bucket tampoco comparte token.
  const otraFecha = tokenDeCierre({ ...HUB, fecha: '2026-07-31' }, { storage, ahora: T0 })
  ok(otraFecha.token !== A.token, 'otra fecha, otro token')

  // Y dos hubs distintos jamás se pisan.
  const otroHub = tokenDeCierre({ ...HUB, userEmail: 'otro@local.test' }, { storage, ahora: T0 })
  ok(otroHub.token !== A.token, 'otro hub, otro token')
  ok(
    claveDeCierre(HUB) !== claveDeCierre({ ...HUB, userEmail: 'otro@local.test' }),
    'las claves de storage no colisionan entre hubs'
  )
}

// ── [4] Sobrevivir al F5 ───────────────────────────────────────────────
// El escenario más probable del reintento: el hub ve "no se pudo cerrar",
// recarga la página y vuelve a apretar Terminar. Un token en un `useRef` no
// llegaría vivo hasta acá — es el bug histórico de este proyecto.
console.log('[4] F5 en el medio del reintento')
{
  _resetMemoria()
  const storage = almacen()
  const antes = tokenDeCierre(HUB, { storage, ahora: T0 })

  // Un F5 real: se pierde TODO lo que estaba en memoria del tab.
  _resetMemoria()

  const despues = tokenDeCierre(HUB, { storage, ahora: T0 + 90_000 })
  eq(despues.token, antes.token, 'el token sobrevive al F5 (vive en localStorage)')
  ok(despues.reintento === true, 'y se sigue reconociendo como reintento')
}

// ── [5] La ventana: techo del daño, no mecanismo principal ─────────────
console.log('[5] Ventana de reintento')
{
  _resetMemoria()
  const storage = almacen()
  const a = tokenDeCierre(HUB, { storage, ahora: T0 })

  const justo = tokenDeCierre(HUB, { storage, ahora: T0 + VENTANA_REINTENTO_MS })
  eq(justo.token, a.token, 'dentro de la ventana sigue siendo el mismo cierre')

  const pasado = tokenDeCierre(HUB, { storage, ahora: T0 + VENTANA_REINTENTO_MS + 1 })
  ok(pasado.token !== a.token, 'pasada la ventana, un token zombi deja de bloquear')

  // Reloj corregido hacia atrás: un token "del futuro" no se reusa.
  _resetMemoria()
  const s2 = almacen()
  const futuro = tokenDeCierre(HUB, { storage: s2, ahora: T0 })
  const atras = tokenDeCierre(HUB, { storage: s2, ahora: T0 - 60_000 })
  ok(atras.token !== futuro.token, 'un creadoEn futuro no se toma por reintento')
}

// ── [6] localStorage roto ──────────────────────────────────────────────
// Safari en modo privado, cuota llena, storage deshabilitado por política.
// Debe degradar de forma honesta: proteger el reintento dentro del tab y
// AVISAR que no persistió, en vez de fingir que está todo bien.
console.log('[6] localStorage no disponible')
{
  _resetMemoria()
  const storage = almacen({ fallaEscritura: true })
  const a = tokenDeCierre(HUB, { storage, ahora: T0 })
  ok(a.persistido === false, 'avisa que el token no se pudo persistir')

  const b = tokenDeCierre(HUB, { storage, ahora: T0 + 20_000 })
  eq(b.token, a.token, 'el respaldo en memoria protege el reintento del mismo tab')

  // Sin storage en absoluto (SSR, entorno raro): no rompe.
  _resetMemoria()
  const c = tokenDeCierre(HUB, { storage: null, ahora: T0 })
  ok(typeof c.token === 'string' && c.token.length >= 32, 'sin storage igual devuelve un token')

  // Borrado que falla: se informa, no se traga.
  _resetMemoria()
  const s3 = almacen({ fallaBorrado: true })
  tokenDeCierre(HUB, { storage: s3, ahora: T0 })
  ok(confirmarCierre(HUB, { storage: s3 }) === false, 'un borrado fallido se informa')
}

// ── [7] Registro corrupto ──────────────────────────────────────────────
// Un token ilegible no identifica ningún cierre: es peor que no tener token.
console.log('[7] Registro corrupto en localStorage')
{
  for (const basura of ['{no es json', '{}', '{"token":""}', 'null', '[]']) {
    _resetMemoria()
    const storage = almacen()
    storage.m.set(claveDeCierre(HUB), basura)
    const r = tokenDeCierre(HUB, { storage, ahora: T0 })
    ok(
      typeof r.token === 'string' && r.token.length >= 32,
      `basura (${basura}) → token nuevo válido`
    )
    ok(r.reintento === false, `basura (${basura}) no se toma por reintento`)
  }
}

// ── [8] Los tokens son únicos ──────────────────────────────────────────
// Si dos cierres distintos generaran el mismo token, el segundo se
// descartaría como duplicado: pérdida de datos silenciosa.
console.log('[8] Unicidad')
{
  _resetMemoria()
  const vistos = new Set()
  for (let i = 0; i < 5000; i++) {
    const storage = almacen()
    vistos.add(tokenDeCierre({ ...HUB, fecha: `d${i}` }, { storage, ahora: T0 }).token)
  }
  eq(vistos.size, 5000, '5000 cierres distintos → 5000 tokens distintos')

  // Formato uuid: es lo que la columna `close_token uuid` de la mig 197
  // acepta. Un token con otro formato haría fallar el INSERT entero.
  const uno = [...vistos][0]
  ok(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uno),
    'el token es un uuid válido para la columna de la mig 197'
  )
}

// ── Resultado ─────────────────────────────────────────────────────────
console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} pasaron, ${fail} fallaron`)
if (fail) console.error('Fallaron:\n  - ' + fallos.join('\n  - '))
process.exit(fail === 0 ? 0 : 1)
