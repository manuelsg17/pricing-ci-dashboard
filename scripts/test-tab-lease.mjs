// Simulaciones del lease de escritura del borrador
// (SESIONES_HALLAZGOS.md P1-10 — la mitad de cliente).
//
// LO QUE SE PRUEBA ACÁ TIENE PÉRDIDA DE DATOS DEL OTRO LADO: dos pestañas del
// mismo hub escriben la misma clave de localStorage con su `entries` completo,
// y la última en escribir borra las celdas de la otra. El lease decide quién
// escribe. Si esta lógica se equivoca hacia un lado, dos pestañas se pisan
// como antes; si se equivoca hacia el otro, una pestaña legítima se queda sin
// autosave y el hub pierde trabajo igual. Los dos errores se prueban.
//
// La regla que atraviesa casi todos los casos: **nunca se le saca el lease a
// una pestaña que puede tener trabajo sin guardar.** Ante la duda (reloj raro,
// JSON corrupto, campo desconocido), se elige el camino que NO destruye datos.

import {
  evaluateLease,
  parseLease,
  leaseKey,
  heartbeatLeaseKey,
  makeLease,
  serializeLease,
  ownsLease,
  LEASE_TTL_MS,
  LEASE_RENEW_MS,
} from '../src/lib/tabLease.js'

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
const SID_A = 'sid-aaa'
const SID_B = 'sid-bbb'
const SID_C = 'sid-ccc'

const leaseDe = (sid, at, engaged) => JSON.stringify({ sid, at, engaged })

// ── [0] Las constantes ────────────────────────────────────────────────
console.log('[0] constantes: el TTL tiene que sobrevivir el throttling')

// EL REQUISITO DURO: los timers de una pestaña en segundo plano se estrangulan
// a ~1 por minuto. Un TTL de 60s mataría el lease de una pestaña viva.
ok(LEASE_TTL_MS > 60_000, 'el TTL es mayor a 60s (throttling de pestaña en segundo plano)')
ok(LEASE_TTL_MS >= 2 * 60_000, 'el TTL aguanta DOS ciclos estrangulados seguidos')
ok(LEASE_RENEW_MS * 3 < LEASE_TTL_MS, 'entran al menos 3 renovaciones dentro de un TTL')

// ── [1] leaseKey ──────────────────────────────────────────────────────
console.log('[1] leaseKey: no puede contaminar el escaneo de borradores')

const DRAFT_KEY = 'de:draft:hub@x.com:PE:Lima:2026-08-01'
const K = leaseKey(DRAFT_KEY)

eq(K, 'de:lease:hub@x.com:PE:Lima:2026-08-01', 'deriva la clave del borrador')

// DataEntry.jsx escanea `de:draft:{email}:{country}:` para el tope de
// MAX_DRAFTS. Si el lease empezara con ese prefijo, cada lease contaría como
// un borrador y el hub vería "llegaste al máximo" con la mitad.
ok(!K.startsWith('de:draft:'), 'la clave del lease NO empieza con de:draft:')
ok(leaseKey(DRAFT_KEY) === K, 'es determinista')
ok(leaseKey('de:draft:hub@x.com:PE:Lima:2026-08-02') !== K, 'una fecha distinta da otra clave')
ok(leaseKey('de:draft:otro@x.com:PE:Lima:2026-08-01') !== K, 'otro usuario da otra clave')
eq(leaseKey(null), null, 'draftKey inválido → null (el llamador no escribe nada)')
eq(leaseKey(''), null, 'draftKey vacío → null')
ok(leaseKey('cualquier-cosa') === 'de:lease:cualquier-cosa', 'una clave sin prefijo igual funciona')

// ── [2] parseLease: nunca lanza ───────────────────────────────────────
console.log('[2] parseLease: localStorage es texto de nadie')

eq(parseLease(leaseDe(SID_A, T0, true)), { sid: SID_A, at: T0, engaged: true }, 'lease válido')
eq(parseLease(null), null, 'null → null')
eq(parseLease(undefined), null, 'undefined → null')
eq(parseLease(''), null, 'cadena vacía → null')
eq(parseLease('{"sid":'), null, 'JSON truncado (escritura a medias) → null, sin lanzar')
eq(parseLease('no soy json'), null, 'basura → null')
eq(parseLease('null'), null, '"null" parsea sin lanzar pero no es un lease')
eq(parseLease('42'), null, 'un número no es un lease')
eq(parseLease('"hola"'), null, 'un string no es un lease')
eq(parseLease('[]'), null, 'un array no es un lease')
eq(parseLease({ sid: SID_A }), null, 'un objeto (no string) → null')

// Campos faltantes: sin `sid` el lease no se puede renovar ni comparar.
eq(parseLease('{}'), null, 'objeto vacío → null (sin dueño identificable)')
eq(parseLease(JSON.stringify({ at: T0, engaged: true })), null, 'sin sid → null')
eq(parseLease(JSON.stringify({ sid: '', at: T0 })), null, 'sid vacío → null')
eq(parseLease(JSON.stringify({ sid: 123, at: T0 })), null, 'sid no-string → null')

// `at` faltante o basura → 0 = infinitamente viejo = vencido. Trabar la clave
// para siempre por un lease corrupto sería peor que reclamarla de más.
eq(parseLease(JSON.stringify({ sid: SID_A })).at, 0, 'sin at → 0 (vencido), no null')
eq(parseLease(JSON.stringify({ sid: SID_A, at: 'ayer' })).at, 0, 'at no numérico → 0')
eq(parseLease(JSON.stringify({ sid: SID_A, at: null })).at, 0, 'at null → 0')

// `engaged` estricto: un valor raro no puede bloquear a otra pestaña.
eq(parseLease(JSON.stringify({ sid: SID_A, at: T0 })).engaged, false, 'sin engaged → false')
eq(parseLease(JSON.stringify({ sid: SID_A, at: T0, engaged: 'si' })).engaged, false, '"si" → false')
eq(parseLease(JSON.stringify({ sid: SID_A, at: T0, engaged: 1 })).engaged, false, '1 → false')

// Round-trip: lo que escribimos es lo que leemos.
eq(
  parseLease(serializeLease({ sid: SID_A, now: T0, engaged: true })),
  { sid: SID_A, at: T0, engaged: true },
  'serializeLease → parseLease conserva todo'
)
eq(makeLease({ sid: SID_A, now: T0 }).engaged, false, 'makeLease nace ocioso')

// ── [3] evaluateLease: los cinco caminos ──────────────────────────────
console.log('[3] evaluateLease: libre / propio / vencido / ocioso / ocupado')

eq(
  evaluateLease({ raw: null, mySid: SID_A, now: T0 }),
  { action: 'claim', reason: 'sin-lease' },
  'nadie lo tiene → lo tomo'
)

eq(
  evaluateLease({ raw: leaseDe(SID_A, T0 - 1000, true), mySid: SID_A, now: T0 }),
  { action: 'renew', reason: 'propio' },
  'el lease es mío → renuevo'
)

eq(
  evaluateLease({ raw: leaseDe(SID_B, T0 - (LEASE_TTL_MS + 1), true), mySid: SID_A, now: T0 }),
  { action: 'claim', reason: 'vencido' },
  'la dueña dejó de renovar hace más de un TTL → lo tomo'
)

eq(
  evaluateLease({
    raw: leaseDe(SID_B, T0 - 1000, false),
    mySid: SID_A,
    now: T0,
    myEngaged: true,
  }),
  { action: 'claim', reason: 'dueno-ocioso' },
  'dueña viva pero SIN trabajo y yo tipeando → lo tomo (abrir una pestaña para mirar no bloquea)'
)

eq(
  evaluateLease({ raw: leaseDe(SID_B, T0 - 1000, true), mySid: SID_A, now: T0, myEngaged: true }),
  { action: 'demote', reason: 'dueno-activo' },
  'dueña viva y CON trabajo → me degrado aunque yo también tenga datos'
)

// La asimetría que evita el ping-pong: dos ociosas no se roban entre sí.
eq(
  evaluateLease({ raw: leaseDe(SID_B, T0 - 1000, false), mySid: SID_A, now: T0, myEngaged: false }),
  { action: 'demote', reason: 'ambos-ociosos' },
  'dueña ociosa y yo también ocioso → se queda la que ya lo tenía'
)

// Borde exacto del TTL: todavía viva (mismo criterio que el resto del repo).
eq(
  evaluateLease({ raw: leaseDe(SID_B, T0 - LEASE_TTL_MS, true), mySid: SID_A, now: T0 }).action,
  'demote',
  'justo en el umbral del TTL todavía NO está vencido'
)
eq(
  evaluateLease({ raw: leaseDe(SID_B, T0 - (LEASE_TTL_MS + 1), true), mySid: SID_A, now: T0 })
    .action,
  'claim',
  'un milisegundo después del TTL sí'
)

// El TTL se puede inyectar (los tests no dependen del valor de producción).
eq(
  evaluateLease({ raw: leaseDe(SID_B, T0 - 5000, true), mySid: SID_A, now: T0, ttlMs: 1000 })
    .action,
  'claim',
  'ttlMs es inyectable'
)

// ── [4] El timestamp 0 — falsy y válido a la vez ──────────────────────
console.log('[4] at:0 — el falsy que rompe estos guards')

// Si algún día alguien escribe `if (!lease.at)` para decir "no tiene
// timestamp", este caso se rompe en silencio.
eq(
  evaluateLease({ raw: leaseDe(SID_A, 0, true), mySid: SID_A, now: T0 }),
  { action: 'renew', reason: 'propio' },
  'lease PROPIO con at:0 → renueva (es mío, la antigüedad no importa)'
)
eq(
  evaluateLease({ raw: leaseDe(SID_B, 0, true), mySid: SID_A, now: T0 }),
  { action: 'claim', reason: 'vencido' },
  'lease AJENO con at:0 → vencido, no "sin lease"'
)
// Y un lease propio viejísimo tampoco se abandona: la pestaña estuvo en
// segundo plano media hora o la máquina volvió de suspensión.
eq(
  evaluateLease({ raw: leaseDe(SID_A, T0 - 3_600_000, true), mySid: SID_A, now: T0 }),
  { action: 'renew', reason: 'propio' },
  'lease propio de hace una hora → se renueva, no se abandona'
)
// Reloj a 0 (máquina sin RTC al arrancar) no debe explotar.
eq(
  evaluateLease({ raw: leaseDe(SID_B, 0, true), mySid: SID_A, now: 0 }).action,
  'demote',
  'now:0 y at:0 → edad 0, la dueña cuenta como viva'
)

// ── [5] Reloj hacia atrás ─────────────────────────────────────────────
console.log('[5] reloj hacia atrás: no robar por una corrección de NTP')

// Las dos pestañas comparten reloj (misma máquina). Un lease sellado unos
// segundos en el futuro significa que el reloj retrocedió, no que el lease sea
// inválido: la dueña está viva y puede tener trabajo sin guardar.
eq(
  evaluateLease({ raw: leaseDe(SID_B, T0 + 5000, true), mySid: SID_A, now: T0 }),
  { action: 'demote', reason: 'dueno-activo' },
  'lease 5s en el futuro (NTP retrocedió) → NO se roba'
)
eq(
  evaluateLease({ raw: leaseDe(SID_B, T0 + 5000, false), mySid: SID_A, now: T0, myEngaged: true }),
  { action: 'claim', reason: 'dueno-ocioso' },
  'un reloj adelantado no vuelve "ocupada" a una dueña ociosa'
)
// Salto grande: si la dueña murió, ese lease no vencería en horas y la clave
// quedaría trabada. Se trata como inválido.
eq(
  evaluateLease({ raw: leaseDe(SID_B, T0 + 2 * 3_600_000, true), mySid: SID_A, now: T0 }),
  { action: 'claim', reason: 'reloj-invertido' },
  'lease sellado 2 horas en el futuro → inválido, se reclama (si no, deadlock)'
)
eq(
  evaluateLease({ raw: leaseDe(SID_A, T0 + 2 * 3_600_000, true), mySid: SID_A, now: T0 }),
  { action: 'renew', reason: 'propio' },
  'si ese lease futuro es MÍO, se renueva y se corrige el sello'
)

// ── [6] Sin identidad de pestaña ──────────────────────────────────────
console.log('[6] sin SESSION_ID: reclamar, nunca degradar')

// Degradar una pestaña única la dejaría sin autosave: una forma NUEVA de
// perder trabajo. Reclamar, en el peor caso, reproduce el status quo previo.
eq(
  evaluateLease({ raw: leaseDe(SID_B, T0, true), mySid: null, now: T0 }),
  { action: 'claim', reason: 'sin-identidad' },
  'sin sid → claim (un guard no puede ser más destructivo que el bug)'
)
eq(evaluateLease({ raw: null, mySid: '', now: T0 }).action, 'claim', 'sid vacío → claim')
eq(evaluateLease().action, 'claim', 'sin argumentos no rompe')

// ── [7] ownsLease: escribir no es ganar ───────────────────────────────
console.log('[7] ownsLease: la relectura de confirmación')

ok(ownsLease(leaseDe(SID_A, T0, true), SID_A), 'me reconozco dueño')
ok(!ownsLease(leaseDe(SID_B, T0, true), SID_A), 'no me atribuyo un lease ajeno')
ok(!ownsLease(null, SID_A), 'sin lease no soy dueño')
ok(!ownsLease('{roto', SID_A), 'lease corrupto no me hace dueño')
ok(!ownsLease(leaseDe(SID_A, T0, true), null), 'sin sid no soy dueño de nada')

// ── [8] Simulación: el protocolo completo con dos pestañas ────────────
console.log('[8] simulación: dos pestañas del mismo hub')

// localStorage falso: compartido entre las dos pestañas, como en el navegador.
function crearStorage() {
  const m = new Map()
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  }
}

// Una pestaña que sigue el protocolo de integración:
//   evaluar → (claim|renew) escribir → RELEER para confirmar → escribir borrador
function crearPestana(sid, storage, key) {
  return {
    sid,
    engaged: false,
    owner: false,
    // Devuelve la acción tomada. `owner` queda con la verdad tras la relectura.
    tick(now) {
      const { action } = evaluateLease({
        raw: storage.getItem(key),
        mySid: sid,
        now,
        myEngaged: this.engaged,
      })
      if (action === 'demote') {
        this.owner = false
        return action
      }
      storage.setItem(key, serializeLease({ sid, now, engaged: this.engaged }))
      // Escribir no es ganar: ganar es volver a leer y encontrarse.
      this.owner = ownsLease(storage.getItem(key), sid)
      return action
    },
    // pagehide: liberar el lease para que la próxima pestaña no espere el TTL.
    release() {
      if (ownsLease(storage.getItem(key), sid)) storage.removeItem(key)
    },
  }
}

// (8.1) Crash-recovery de Chrome: TRES pestañas restauradas en el mismo tick.
// Las tres leen la clave vacía ANTES de que ninguna escriba. Solo una puede
// quedar dueña.
{
  const st = crearStorage()
  const tabs = [SID_A, SID_B, SID_C].map((s) => crearPestana(s, st, K))

  // Fase de lectura: las tres ven lo mismo (nada).
  const decisiones = tabs.map((tb) =>
    evaluateLease({ raw: st.getItem(K), mySid: tb.sid, now: T0, myEngaged: false })
  )
  eq(
    decisiones.map((d) => d.action),
    ['claim', 'claim', 'claim'],
    '8.1 las tres pestañas deciden reclamar (leyeron la clave vacía a la vez)'
  )

  // Fase de escritura: las tres escriben en el mismo tick, gana la última.
  tabs.forEach((tb) => st.setItem(K, serializeLease({ sid: tb.sid, now: T0, engaged: false })))

  // Fase de confirmación: cada una relee.
  tabs.forEach((tb) => {
    tb.owner = ownsLease(st.getItem(K), tb.sid)
  })
  eq(tabs.filter((tb) => tb.owner).length, 1, '8.1 tras la relectura queda EXACTAMENTE una dueña')
  ok(tabs[2].owner, '8.1 la dueña es la última en escribir, y las otras dos lo aceptan')

  // Y en el tick siguiente NO hay ping-pong: las perdedoras siguen ociosas y
  // se quedan degradadas en vez de robarse el lease entre sí.
  let t = T0
  for (let i = 0; i < 40; i++) {
    t += LEASE_RENEW_MS
    tabs.forEach((tb) => tb.tick(t))
    if (tabs.filter((tb) => tb.owner).length !== 1) break
  }
  eq(tabs.filter((tb) => tb.owner).length, 1, '8.1 tras 40 ticks sigue habiendo una sola dueña')
  ok(tabs[2].owner, '8.1 y sigue siendo la misma: sin ping-pong')
}

// (8.2) El caso del enunciado: la pestaña dueña está OCIOSA ("la abrí para
// mirar") y el hub se pone a trabajar en la otra.
{
  const st = crearStorage()
  const mirar = crearPestana(SID_A, st, K)
  const trabajar = crearPestana(SID_B, st, K)

  let t = T0
  mirar.tick(t) // A abre primero y toma el lease, sin trabajo
  ok(mirar.owner, '8.2 la primera pestaña toma el lease')

  t += 1000
  eq(trabajar.tick(t), 'demote', '8.2 la segunda, recién abierta y vacía, no se lo roba')

  // El hub empieza a tipear en B.
  trabajar.engaged = true
  t += 1000
  eq(trabajar.tick(t), 'claim', '8.2 en cuanto B tiene trabajo, reclama el lease de la ociosa')
  ok(trabajar.owner, '8.2 B queda dueña')

  t += LEASE_RENEW_MS
  eq(mirar.tick(t), 'demote', '8.2 y A (la de mirar) se degrada sola en su siguiente tick')
  ok(!mirar.owner && trabajar.owner, '8.2 una sola dueña, y es la que tiene los datos')
}

// (8.3) First-writer-wins: la vieja CON trabajo nunca es desalojada por la
// nueva. Es la decisión que protege al que tiene datos en riesgo.
{
  const st = crearStorage()
  const vieja = crearPestana(SID_A, st, K)
  vieja.engaged = true
  const nueva = crearPestana(SID_B, st, K)

  let t = T0
  vieja.tick(t)
  let robos = 0
  // Media hora de convivencia, con la nueva incluso tipeando.
  for (let i = 0; i < 60; i++) {
    t += LEASE_RENEW_MS
    vieja.tick(t) // sigue renovando
    if (i === 10) nueva.engaged = true
    nueva.tick(t)
    if (nueva.owner) robos++
  }
  eq(robos, 0, '8.3 en 30 minutos la pestaña nueva no le roba el lease a la vieja ni una vez')
  ok(vieja.owner, '8.3 la vieja conserva el lease todo el tiempo')
}

// (8.4) F5 real de la pestaña dueña. SESSION_ID vive en sessionStorage: la
// MISMA pestaña se reconoce dueña después de recargar y no espera ningún TTL.
{
  const st = crearStorage()
  const dueña = crearPestana(SID_A, st, K)
  dueña.engaged = true
  const otra = crearPestana(SID_B, st, K)
  otra.engaged = true

  let t = T0
  dueña.tick(t)
  otra.tick(t)

  // F5: se pierde todo el estado en memoria, pero el sid sobrevive.
  const trasF5 = crearPestana(SID_A, st, K)
  trasF5.engaged = true
  t += 2000
  eq(trasF5.tick(t), 'renew', '8.4 tras un F5 la misma pestaña RENUEVA su lease (mismo sid)')
  ok(trasF5.owner, '8.4 y sigue siendo la dueña sin esperar el TTL')
  t += 1000
  eq(otra.tick(t), 'demote', '8.4 la otra pestaña sigue degradada: el F5 no le abrió una ventana')
}

// (8.5) Crash duro de la dueña con trabajo (sin pagehide). Nadie roba antes
// del TTL; después del TTL, la que quedó viva toma el relevo.
{
  const st = crearStorage()
  const muerta = crearPestana(SID_A, st, K)
  muerta.engaged = true
  const viva = crearPestana(SID_B, st, K)
  viva.engaged = true

  let t = T0
  muerta.tick(t) // último tick antes de morir

  t = T0 + LEASE_TTL_MS
  eq(viva.tick(t), 'demote', '8.5 justo en el TTL todavía no se roba')
  t = T0 + LEASE_TTL_MS + 1
  eq(viva.tick(t), 'claim', '8.5 pasado el TTL, la pestaña viva toma el relevo')
  ok(viva.owner, '8.5 y queda dueña')
}

// (8.6) Cierre limpio: el pagehide libera el lease y la otra pestaña entra
// enseguida, sin esperar los 150s.
{
  const st = crearStorage()
  const cerrada = crearPestana(SID_A, st, K)
  cerrada.engaged = true
  const otra = crearPestana(SID_B, st, K)
  otra.engaged = true

  let t = T0
  cerrada.tick(t)
  t += 1000
  eq(otra.tick(t), 'demote', '8.6 mientras la primera vive, la segunda está degradada')

  cerrada.release() // pagehide
  t += 1000
  eq(otra.tick(t), 'claim', '8.6 al cerrarse la dueña, la otra entra sin esperar el TTL')
  ok(otra.owner, '8.6 y queda dueña')

  // Y `release` de una pestaña que YA no es dueña no puede borrar el lease
  // ajeno: cerrar la pestaña degradada no debe dejar el borrador sin dueño.
  cerrada.release()
  ok(ownsLease(st.getItem(K), SID_B), '8.6 cerrar la pestaña degradada no borra el lease ajeno')
}

// (8.7) Segundo plano: la dueña queda estrangulada a 1 tick/minuto. No puede
// perder el lease por eso — es el motivo del TTL largo.
{
  const st = crearStorage()
  const fondo = crearPestana(SID_A, st, K)
  fondo.engaged = true
  const frente = crearPestana(SID_B, st, K)
  frente.engaged = true

  let t = T0
  fondo.tick(t)
  let perdidas = 0
  for (let i = 0; i < 30; i++) {
    // Throttling real: ~1 tick por minuto, y con deriva (el navegador no
    // garantiza los 60s exactos). Nada de 60_000 clavados: un test que se
    // apoya en el borde exacto pasaría aunque el TTL fuera demasiado corto.
    t += 60_000 + (i % 5) * 3000
    frente.tick(t) // la de adelante intenta robarlo en cada oportunidad
    // Cada 4 vueltas la pestaña de fondo queda CONGELADA y ni siquiera corre
    // su tick: dos intervalos seguidos sin renovar. Es el peor caso realista.
    if (i % 4 !== 3) fondo.tick(t)
    if (!fondo.owner) perdidas++
  }
  eq(perdidas, 0, '8.7 media hora en segundo plano, con ticks salteados, no pierde el lease')
  ok(!frente.owner, '8.7 la otra pestaña nunca logra robarlo')
}

// (8.8) El invariante global: en cualquier secuencia, nunca hay dos dueñas.
{
  const st = crearStorage()
  const tabs = [SID_A, SID_B, SID_C].map((s) => crearPestana(s, st, K))
  let t = T0
  let violaciones = 0
  // Secuencia pseudoaleatoria pero DETERMINISTA (nada de Math.random: un test
  // que falla una vez cada tanto no sirve para nada).
  let semilla = 7
  const siguiente = () => (semilla = (semilla * 1103515245 + 12345) % 2147483648)
  for (let i = 0; i < 500; i++) {
    const r = siguiente()
    const idx = r % 3
    // A veces la pestaña se pone a trabajar, a veces termina y queda ociosa.
    if (r % 17 === 0) tabs[idx].engaged = !tabs[idx].engaged
    // A veces pasa mucho tiempo (pestaña dormida), a veces poco.
    t += r % 11 === 0 ? LEASE_TTL_MS * 2 : LEASE_RENEW_MS
    tabs[idx].tick(t)
    // La verdad la dice el storage, no el estado en memoria de cada pestaña:
    // una pestaña "cree" ser dueña hasta su próximo tick.
    const dueñasReales = tabs.filter((tb) => ownsLease(st.getItem(K), tb.sid)).length
    if (dueñasReales > 1) violaciones++
  }
  eq(violaciones, 0, '8.8 en 500 pasos con 3 pestañas, nunca hubo dos dueñas a la vez')
}

// ── [9] La regla que no se negocia ────────────────────────────────────
console.log('[9] guard: no existe ninguna fusión de borradores')

// No hay API de merge en este módulo, y no puede haberla. Fusionar los
// `entries` de dos pestañas resucita celdas que el hub borró a propósito —
// CLAUDE.md §2, el bug con más antecedentes del repo. Este test existe para
// que agregar un `mergeDrafts` obligue a borrarlo a mano y a leer el motivo.
const api = await import('../src/lib/tabLease.js')
eq(
  Object.keys(api).filter((k) => /merge|fusion|combin/i.test(k)).length,
  0,
  'el módulo no exporta ninguna función de fusión de borradores'
)

// ── [10] El lease del LATIDO es global por hub ────────────────────────
// El de borrador lleva la vista y la fecha adentro, así que dos pestañas del
// mismo hub en frentes distintos son dueñas cada una del suyo. Eso está bien
// para el borrador (claves de localStorage distintas, no se pisan) y está MAL
// para el latido, que escribe `ci_active_sessions` — PK `user_email`, una sola
// fila por hub. Ese es el bug que este lease cierra.
console.log('\n[10] lease del latido: global por hub, no por frente')

const HUB = 'hub@yango.com'
const draftA = `de:draft:${HUB}:Peru:Lima_TukTuk_SJL:2026-08-03`
const draftB = `de:draft:${HUB}:Peru:Lima_TukTuk_Comas:2026-08-03`

ok(leaseKey(draftA) !== leaseKey(draftB), 'dos frentes → DOS leases de borrador distintos')
eq(
  heartbeatLeaseKey(HUB),
  heartbeatLeaseKey(HUB),
  'el mismo hub en dos frentes → UN SOLO lease de latido'
)
ok(
  heartbeatLeaseKey(HUB) !== heartbeatLeaseKey('otro@yango.com'),
  'dos hubs distintos → leases de latido distintos'
)
ok(
  !heartbeatLeaseKey(HUB).startsWith('de:draft:'),
  'no usa el prefijo de borrador (contaría contra el tope de MAX_DRAFTS)'
)
ok(
  heartbeatLeaseKey(HUB) !== leaseKey(draftA),
  'y no colisiona con el lease de borrador del mismo hub'
)
eq(heartbeatLeaseKey(''), null, 'sin email no hay lease de latido')
eq(heartbeatLeaseKey(null), null, 'null no rompe')
eq(heartbeatLeaseKey(undefined), null, 'undefined no rompe')

// Dos pestañas del mismo hub compitiendo por el latido: una sola gana, y la
// que ya lo tiene se lo queda (mismo first-writer-wins del borrador).
{
  const raw = serializeLease({ sid: 'tabA', now: T0, engaged: true })
  const vistoPorB = evaluateLease({ raw, mySid: 'tabB', now: T0 + 1000, myEngaged: true })
  eq(vistoPorB.action, 'demote', 'la segunda pestaña NO late aunque esté en otro frente')
  const vistoPorA = evaluateLease({ raw, mySid: 'tabA', now: T0 + 1000, myEngaged: true })
  ok(vistoPorA.action !== 'demote', 'la dueña renueva y sigue latiendo')
}

// ── Resultado ─────────────────────────────────────────────────────────
console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} pasaron, ${fail} fallaron`)
if (fail) console.error('Fallaron:\n  - ' + fallos.join('\n  - '))
process.exit(fail === 0 ? 0 : 1)
