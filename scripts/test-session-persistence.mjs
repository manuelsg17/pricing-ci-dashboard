// Simulaciones del estado de persistencia de "Ingresar CI"
// (SESIONES_HALLAZGOS.md P2-13 y P2-14).
//
// LO QUE SE PRUEBA ACÁ NO ES COSMÉTICO: el hub decide si puede cerrar la
// laptop mirando estos carteles. Un falso "todo guardado" es peor que no
// mostrar nada, porque le da permiso para irse con trabajo sin persistir.
//
// La regla que verifican casi todos los casos: **conectividad NO es
// durabilidad**. El latido prueba que el backend responde; no prueba que una
// sola celda haya llegado a la base.

import {
  estadoDeGuardado,
  estadoDeServidor,
  debeReanudarTramo,
  debeHidratarBorrador,
  SERVIDOR_STALE_MS,
} from '../src/lib/sessionPersistence.js'

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

const T0 = 1_800_000_000_000 // instante fijo; nada depende del reloj real

// ── [1] estadoDeGuardado ──────────────────────────────────────────────
console.log('[1] estadoDeGuardado: qué se guarda y qué queda local')

eq(
  estadoDeGuardado({ filledCount: 108, savableCount: 96, editSeq: 5, savedSeq: -1 }).soloLocal,
  12,
  'el caso del reporte: 108 llenas, 96 guardables → 12 quedan solo local'
)

eq(
  estadoDeGuardado({ filledCount: 96, savableCount: 96, editSeq: 3, savedSeq: 3 }).todoAsegurado,
  true,
  'sin filas a medias y sin ediciones nuevas → todo asegurado'
)

eq(
  estadoDeGuardado({ filledCount: 108, savableCount: 96, editSeq: 3, savedSeq: 3 }).todoAsegurado,
  false,
  'con 12 celdas en filas incompletas NO se puede decir "todo guardado"'
)

eq(
  estadoDeGuardado({ filledCount: 50, savableCount: 50, editSeq: 7, savedSeq: 4 })
    .hayCambiosSinGuardar,
  true,
  'editar después de guardar marca cambios pendientes'
)

eq(
  estadoDeGuardado({ filledCount: 50, savableCount: 50, editSeq: 4, savedSeq: 4 })
    .hayCambiosSinGuardar,
  false,
  'guardar deja el contador al día'
)

// El estado inicial no puede reportar "todo asegurado": nunca se guardó.
eq(
  estadoDeGuardado({ filledCount: 0, savableCount: 0, editSeq: 0, savedSeq: -1 }).todoAsegurado,
  false,
  'sesión recién abierta NO es "todo asegurado" (nunca se guardó)'
)

// Defensa: savable no puede superar a filled, pero si pasara no debe dar
// negativo y arruinar el cartel.
eq(
  estadoDeGuardado({ filledCount: 10, savableCount: 99 }).soloLocal,
  0,
  'nunca devuelve un conteo negativo'
)

eq(estadoDeGuardado().soloLocal, 0, 'sin argumentos no rompe')

// ── [2] estadoDeServidor: la mentira original ─────────────────────────
console.log('[2] estadoDeServidor: el latido NO cuenta como guardado')

// EL CASO QUE ORIGINÓ TODO: latido fresco, cero guardados. Antes esto
// mostraba "✓ Confirmado en servidor hace 4s".
eq(
  estadoDeServidor({
    sessionActive: true,
    lastSaveOkAt: null,
    lastHeartbeatOkAt: T0 - 4000,
    now: T0,
  }),
  { kind: 'nada_guardado' },
  'latido fresco sin ningún guardado → "nada guardado", NO "confirmado"'
)

eq(
  estadoDeServidor({
    sessionActive: true,
    lastSaveOkAt: T0 - 10_000,
    lastHeartbeatOkAt: T0 - 2000,
    now: T0,
  }),
  { kind: 'guardado', segundos: 10 },
  'con un guardado real sí dice guardado, y la antigüedad es la del GUARDADO'
)

// Sutil pero importante: el latido es más nuevo que el guardado. La
// antigüedad mostrada tiene que seguir siendo la del guardado, no la del
// latido — si no, el cartel rejuvenece solo sin que nada se haya guardado.
const conLatidoNuevo = estadoDeServidor({
  sessionActive: true,
  lastSaveOkAt: T0 - 120_000,
  lastHeartbeatOkAt: T0 - 1000,
  now: T0,
})
eq(conLatidoNuevo.segundos, 120, 'el latido nuevo NO rejuvenece la antigüedad del guardado')

// ── [3] estadoDeServidor: cambios sin guardar ─────────────────────────
console.log('[3] estadoDeServidor: cambios pendientes')

eq(
  estadoDeServidor({
    sessionActive: true,
    lastSaveOkAt: T0 - 30_000,
    lastHeartbeatOkAt: T0 - 1000,
    hayCambiosSinGuardar: true,
    soloLocal: 0,
    now: T0,
  }),
  { kind: 'sin_guardar', segundos: 30, soloLocal: 0 },
  'editar tras guardar → avisa que hay cambios sin guardar'
)

eq(
  estadoDeServidor({
    sessionActive: true,
    lastSaveOkAt: T0 - 5000,
    lastHeartbeatOkAt: T0 - 1000,
    hayCambiosSinGuardar: false,
    soloLocal: 12,
    now: T0,
  }),
  { kind: 'guardado_parcial', segundos: 5, soloLocal: 12 },
  'guardado pero con 12 celdas en filas a medias → guardado PARCIAL'
)

// ── [4] estadoDeServidor: sin conexión gana sobre todo ────────────────
console.log('[4] estadoDeServidor: la conexión tiene prioridad')

eq(
  estadoDeServidor({
    sessionActive: true,
    lastSaveOkAt: T0 - 1000,
    lastHeartbeatOkAt: T0 - (SERVIDOR_STALE_MS + 60_000),
    now: T0,
  }).kind,
  'sin_conexion',
  'aunque acabe de guardar, si el latido venció avisa de conexión'
)

// Es lo correcto: si no hay contacto con el servidor, decir "todo guardado"
// sería un dato viejo presentado como fresco.
eq(
  estadoDeServidor({
    sessionActive: true,
    lastSaveOkAt: T0 - 1000,
    lastHeartbeatOkAt: null,
    now: T0,
  }).kind,
  'sin_conexion',
  'sin ningún latido todavía → sin conexión'
)

const justoEnElBorde = estadoDeServidor({
  sessionActive: true,
  lastSaveOkAt: T0 - 1000,
  lastHeartbeatOkAt: T0 - SERVIDOR_STALE_MS,
  now: T0,
})
eq(justoEnElBorde.kind, 'guardado', 'justo en el umbral todavía NO es "sin conexión"')

eq(
  estadoDeServidor({
    sessionActive: true,
    lastSaveOkAt: null,
    lastHeartbeatOkAt: T0 - (SERVIDOR_STALE_MS + 1),
    now: T0,
  }).minutos,
  3,
  'informa hace cuántos minutos se perdió el contacto'
)

// ── [5] Sin sesión ────────────────────────────────────────────────────
console.log('[5] sin sesión activa no se muestra nada')
eq(estadoDeServidor({ sessionActive: false, lastSaveOkAt: T0, now: T0 }), null, 'sin sesión → null')
eq(estadoDeServidor(), null, 'sin argumentos → null')

// ── [6] Simulación: el día completo de un hub ─────────────────────────
console.log('[6] simulación: jornada completa de un hub')

let editSeq = 0
let savedSeq = -1
let lastSaveOkAt = null
let lastHeartbeatOkAt = T0
let t = T0

const paso = (label, esperado, { filled, savable }) => {
  const g = estadoDeGuardado({ filledCount: filled, savableCount: savable, editSeq, savedSeq })
  const s = estadoDeServidor({
    sessionActive: true,
    lastSaveOkAt,
    lastHeartbeatOkAt,
    hayCambiosSinGuardar: g.hayCambiosSinGuardar,
    soloLocal: g.soloLocal,
    now: t,
  })
  eq(s.kind, esperado, label)
}

// 09:00 — abre la sesión, todavía no tipeó nada.
paso('09:00 recién abierta → nada guardado', 'nada_guardado', { filled: 0, savable: 0 })

// 09:20 — tipeó 40 celdas, todas en filas completas. NO guardó.
t += 20 * 60_000
lastHeartbeatOkAt = t
editSeq = 40
paso('09:20 tipeó sin guardar → sigue sin nada guardado', 'nada_guardado', {
  filled: 40,
  savable: 40,
})

// 09:21 — guarda.
t += 60_000
lastHeartbeatOkAt = t
lastSaveOkAt = t
savedSeq = editSeq
paso('09:21 guardó → guardado', 'guardado', { filled: 40, savable: 40 })

// 09:40 — sigue tipeando; quedan 8 celdas en filas a medias.
t += 19 * 60_000
lastHeartbeatOkAt = t
editSeq = 60
paso('09:40 editó de nuevo → sin guardar', 'sin_guardar', { filled: 60, savable: 52 })

// 09:41 — guarda: las filas completas van, las 8 a medias NO.
t += 60_000
lastHeartbeatOkAt = t
lastSaveOkAt = t
savedSeq = editSeq
paso('09:41 guardó con 8 a medias → guardado PARCIAL, no "todo guardado"', 'guardado_parcial', {
  filled: 60,
  savable: 52,
})

// 09:45 — se corta internet. El último guardado sigue siendo válido, pero el
// cartel no puede seguir diciendo "guardado" como si nada.
t += 4 * 60_000
paso('09:45 se cortó internet → sin conexión', 'sin_conexion', { filled: 60, savable: 52 })

// 09:50 — vuelve, completa las filas y guarda todo.
t += 5 * 60_000
lastHeartbeatOkAt = t
editSeq = 68
lastSaveOkAt = t
savedSeq = editSeq
paso('09:50 completó y guardó todo → guardado limpio', 'guardado', { filled: 68, savable: 68 })

const finalG = estadoDeGuardado({ filledCount: 68, savableCount: 68, editSeq, savedSeq })
eq(finalG.todoAsegurado, true, '09:50 recién acá se puede decir "todo asegurado"')

// ── [7] La regresión que NO puede volver ──────────────────────────────
console.log('[7] guard de regresión: el latido nunca marca durabilidad')
let latidos = 0
let estadoFinal = null
for (let i = 0; i < 100; i++) {
  latidos++
  estadoFinal = estadoDeServidor({
    sessionActive: true,
    lastSaveOkAt: null, // nunca guardó
    lastHeartbeatOkAt: T0 + latidos * 25_000,
    now: T0 + latidos * 25_000,
  })
}
eq(
  estadoFinal.kind,
  'nada_guardado',
  '100 latidos exitosos seguidos NO convierten "nada guardado" en "guardado"'
)


// ── [8] debeReanudarTramo — el bug que introdujo el fix de P1-7 ───────
console.log('[8] debeReanudarTramo: reanudar vs. arrancar un tramo nuevo')

const HOY = '2026-08-01'
const abierto = { Morning: { startedAt: '2026-08-01T09:00:00Z' } }
const cerrado = {
  Morning: { startedAt: '2026-08-01T09:00:00Z', endedAt: '2026-08-01T11:00:00Z' },
}

eq(
  debeReanudarTramo({ loadDate: HOY, today: HOY, timings: abierto }),
  true,
  'jornada de HOY sin cerrar → reanuda (F5 a mitad de trabajo)'
)

// EL CASO H1: mirar una fecha pasada no puede arrancar un cronómetro desde
// la mañana de ese día — marcaba 30:00:00.
eq(
  debeReanudarTramo({ loadDate: '2026-07-28', today: HOY, timings: abierto }),
  false,
  'fecha PASADA → tramo nuevo, nunca hereda el inicio de ese día'
)

// EL CASO H3: terminar a las 11:00 y volver a las 15:00 marcaba 06:00:00.
eq(
  debeReanudarTramo({ loadDate: HOY, today: HOY, timings: cerrado }),
  false,
  'jornada de hoy YA CERRADA → es una corrección, no una continuación'
)

// Un turno cerrado y otro abierto: sigue habiendo trabajo en curso.
eq(
  debeReanudarTramo({
    loadDate: HOY,
    today: HOY,
    timings: { ...cerrado, Evening: { startedAt: '2026-08-01T18:00:00Z' } },
  }),
  true,
  'con un turno todavía abierto → reanuda'
)

eq(debeReanudarTramo({ loadDate: HOY, today: HOY, timings: {} }), false, 'sin timings → tramo nuevo')
eq(debeReanudarTramo({ loadDate: HOY, today: HOY, timings: null }), false, 'timings null no rompe')
eq(debeReanudarTramo(), false, 'sin argumentos no rompe')
eq(
  debeReanudarTramo({ loadDate: HOY, today: HOY, timings: { Morning: {} } }),
  false,
  'un turno sin startedAt no cuenta como jornada en curso'
)


// ── debeHidratarBorrador — la pérdida de datos del F5 (2026-08-02) ────────
//
// El bug: la clave del borrador lleva el email adentro y `userEmail` llega
// asíncrono. Hidratar antes de saber quién es el usuario buscaba una clave
// con el segmento vacío, no encontraba nada, marcaba el bucket como hecho
// —bloqueando el reintento bueno— y dejaba que el auto-load del servidor
// pisara el borrador. Reproducido en navegador: 7 celdas → 4 tras un F5.
console.log('\n[F5] debeHidratarBorrador — sin identidad no se toca nada')

ok(
  debeHidratarBorrador({ userEmail: 'hub@yango.com', yaHidratado: false }) === true,
  'con email y sin hidratar todavía → SÍ hidrata'
)
ok(
  debeHidratarBorrador({ userEmail: 'hub@yango.com', yaHidratado: true }) === false,
  'con email pero ya hidratado → no re-hidrata (la memoria manda)'
)
// EL CASO DEL BUG. Antes esto devolvía "sí" y marcaba el bucket para siempre.
ok(
  debeHidratarBorrador({ userEmail: '', yaHidratado: false }) === false,
  'email vacío → NO hidrata (la clave saldría con el segmento en blanco)'
)
ok(
  debeHidratarBorrador({ userEmail: undefined, yaHidratado: false }) === false,
  'email undefined → tampoco'
)
ok(
  debeHidratarBorrador({ userEmail: null, yaHidratado: false }) === false,
  'email null → tampoco'
)
ok(debeHidratarBorrador({}) === false, 'sin argumentos útiles → no hidrata')
ok(debeHidratarBorrador() === false, 'llamada sin objeto → no explota y no hidrata')
// Un email no-string (bug de tipos aguas arriba) no puede colarse: construiría
// una clave inválida igual que el vacío.
ok(
  debeHidratarBorrador({ userEmail: 42, yaHidratado: false }) === false,
  'email que no es string → no hidrata'
)
// La secuencia real del F5: primer render sin email, segundo con email.
{
  const yaHidratados = new Set()
  const paso1 = debeHidratarBorrador({ userEmail: '', yaHidratado: yaHidratados.has('Lima') })
  if (paso1) yaHidratados.add('Lima')
  const paso2 = debeHidratarBorrador({
    userEmail: 'hub@yango.com',
    yaHidratado: yaHidratados.has('Lima'),
  })
  ok(paso1 === false, 'secuencia F5 · render 1 (sin email) no hidrata')
  ok(paso2 === true, 'secuencia F5 · render 2 (con email) SÍ hidrata — el borrador se recupera')
}



// ── Resultado ─────────────────────────────────────────────────────────
console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} pasaron, ${fail} fallaron`)
if (fail) console.error('Fallaron:\n  - ' + fallos.join('\n  - '))
process.exit(fail === 0 ? 0 : 1)
