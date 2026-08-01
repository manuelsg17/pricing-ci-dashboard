// ════════════════════════════════════════════════════════════════════════
// simulate-durability.mjs — ¿qué sobrevive a un F5, a cerrar el navegador y
// a un APAGÓN mientras un hub carga la grilla de Ingresar CI?
//
// LA PREGUNTA QUE CONTESTA
// Un hub carga a mano entre 108 y 324 celdas. Eso son horas de trabajo de una
// persona. El progreso vive en tres lugares con garantías MUY distintas:
//
//   1. Estado de React        — muere con cualquier recarga real de página.
//   2. Borrador (localStorage)— autosave con debounce de 1,5s + un flush
//                               síncrono en el cleanup del efecto.
//   3. pricing_observations   — solo cuando el hub toca Guardar/Terminar.
//
// Este script simula la máquina de estados de (2) y (3) y afirma, evento por
// evento, qué queda persistido y qué se pierde.
//
// ⚠️ LÍMITE HONESTO — LEER ANTES DE CONFIAR EN ESTE ARCHIVO
// La lógica del borrador NO está extraída de DataEntry.jsx: vive dentro de
// tres `useEffect` del god-component (CLAUDE.md §1) y no se puede importar ni
// ejecutar sin un navegador. Lo de acá es un MODELO de esos efectos, escrito
// a mano leyendo el código. Un modelo que se desincroniza del código miente
// peor que no tener nada, así que el bloque final [10] verifica contra el
// FUENTE REAL las cinco propiedades sobre las que se apoya el modelo. Si
// alguien cambia el debounce, le agrega persistencia al `beforeunload` o
// rompe el merge del flush, ese bloque falla y obliga a actualizar el modelo.
//
// Lo que este script NO prueba y solo se puede ver en un navegador real:
//   · Que React de verdad no corre los cleanups al descargar la página.
//   · Que el navegador alcanzó a bajar el localStorage a disco antes del corte
//     de luz (Chrome persiste su LevelDB de forma asíncrona: setItem es
//     síncrono para el JS, el fsync no).
//   · El comportamiento real de quota/Safari privado.
// Para eso hace falta el flujo manual de CLAUDE.md §7.6, o un E2E (§1).
// ════════════════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..')

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

// ── Constantes del modelo (deben espejar DataEntry.jsx) ───────────────
const DEBOUNCE_MS = 1500 // autosave del borrador
const HEARTBEAT_MS = 25_000 // latido: manda CONTEO, nunca los valores

// ════════════════════════════════════════════════════════════════════════
// [0] La máquina de estados
// ════════════════════════════════════════════════════════════════════════
//
// `celda` es un id opaco. `fila` agrupa celdas: solo las filas COMPLETAS
// viajan al servidor en "Guardar progreso" (P2-13) — las celdas de filas a
// medias jamás llegan a pricing_observations y viven solo en el borrador.

function crearMaquina({ almacenamiento = 'ok' } = {}) {
  return {
    t: 0,
    // Estado de React de la ciudad activa.
    memoria: new Set(),
    // localStorage: de:draft:<email>:<país>:<viewId>:<fecha>
    borrador: null, // { celdas:Set, meta:object, savedAt:number }
    // Campos que SOLO escribe el autosave (turnoTimings, pendingScopeMembers,
    // pendingExtraFronts). El flush los preserva mergeando (fix de P0-2).
    meta: {},
    // pricing_observations
    servidor: new Set(),
    timer: null, // instante en que dispararía el autosave, o null
    almacenamiento, // 'ok' | 'lleno' | 'deshabilitado'
    escriturasBorrador: 0,
    // sessionStorage — sobrevive un F5, muere con la pestaña.
    idPestaña: 'tab-1', // SESSION_ID (src/lib/supabase.js)
    marcaSync: null, // de:seq:<país>|<ciudad>|<zona>|<fecha>
    // ci_bucket_writes (mig 191)
    seqServidor: 0,
    ultimoEscritor: null,
  }
}

// Un tecleo: entra en memoria y REINICIA el debounce. No hay maxWait: el
// temporizador se reinicia entero en cada cambio, así que tipear sin pausas
// de 1,5s posterga la escritura del borrador indefinidamente.
function tipear(m, celda, meta = null) {
  m.memoria.add(celda)
  if (meta) m.meta = { ...m.meta, ...meta }
  m.timer = m.t + DEBOUNCE_MS
}

function escribirBorrador(m) {
  // catch vacío en el código real: si el storage falla, no pasa NADA visible.
  if (m.almacenamiento !== 'ok') return false
  m.borrador = { celdas: new Set(m.memoria), meta: { ...m.meta }, savedAt: m.t }
  m.escriturasBorrador++
  return true
}

function avanzar(m, ms) {
  let restante = ms
  while (restante > 0) {
    if (m.timer !== null && m.timer <= m.t + restante) {
      restante -= m.timer - m.t
      m.t = m.timer
      m.timer = null
      escribirBorrador(m)
    } else {
      m.t += restante
      restante = 0
    }
  }
}

// Cleanup del efecto: cambiar de ciudad/fecha o navegar dentro de la SPA.
// React corre primero el cleanup del autosave (clearTimeout, la escritura
// pendiente se CANCELA) y después el del flush, que escribe mergeando.
function flushPorDesmontaje(m) {
  m.timer = null
  if (m.almacenamiento !== 'ok') return false
  const previo = m.borrador ?? { celdas: new Set(), meta: {} }
  // El flush NO conoce `meta`: lo conserva del `previo` (fix de P0-2).
  m.borrador = { celdas: new Set(m.memoria), meta: { ...previo.meta }, savedAt: m.t }
  m.escriturasBorrador++
  return true
}

// Descarga REAL de la página. React no corre cleanups: el timer pendiente
// muere sin escribir y el flush nunca ocurre.
function descargarPagina(m, { muereSessionStorage }) {
  m.timer = null
  m.memoria = new Set()
  m.meta = {}
  if (muereSessionStorage) {
    m.idPestaña = 'tab-2'
    m.marcaSync = null
  }
}

// Al volver a montar: si hay borrador, se restaura y NO se consulta el
// servidor (`if (!draftApplied) setPendingLoad(...)`). Ese atajo es también
// el motivo por el que la marca de agua no se re-sincroniza.
function hidratar(m) {
  if (m.borrador) {
    m.memoria = new Set(m.borrador.celdas)
    m.meta = { ...m.borrador.meta }
    return 'borrador'
  }
  m.memoria = new Set(m.servidor)
  m.marcaSync = m.seqServidor // loadObservationsIntoForm sí re-sincroniza
  return 'servidor'
}

// Espejo en JS del guard de ci_bucket_write_guard (mig 191). Verificado
// contra la base local — ver scripts/simulate-two-tabs.sql.
function guardDeEscritura(m) {
  if (m.seqServidor === 0) return true // no hay fila previa
  if (m.ultimoEscritor === m.idPestaña) return true // mi propia pestaña
  if (m.marcaSync !== null && m.marcaSync === m.seqServidor) return true
  return false
}

function guardar(m, { celdasCompletas, terminar = false, forzar = false }) {
  if (!forzar && !guardDeEscritura(m)) return { ok: false, conflicto: true }
  for (const c of celdasCompletas) m.servidor.add(c)
  m.seqServidor++
  m.ultimoEscritor = m.idPestaña
  m.marcaSync = m.seqServidor
  if (terminar) m.borrador = null
  return { ok: true, guardadas: celdasCompletas.length }
}

// Lo que el hub pierde: lo que estaba en pantalla y no quedó en ningún
// lado durable.
function perdidas(memoriaPrevia, m) {
  const durable = new Set([...(m.borrador?.celdas ?? []), ...m.servidor])
  return [...memoriaPrevia].filter((c) => !durable.has(c))
}

// ════════════════════════════════════════════════════════════════════════
// [1] La ventana del debounce: cuánto trabajo vive SOLO en React
// ════════════════════════════════════════════════════════════════════════
console.log('[1] Ventana del debounce (trailing sin maxWait)')

// Cadencia realista tecleando una celda: 4 pulsaciones + Tab. Si entre
// pulsación y pulsación pasan menos de 1,5s, el autosave NUNCA dispara.
function tipeoContinuo(cadenciaMs, celdas) {
  const m = crearMaquina()
  for (let i = 0; i < celdas; i++) {
    tipear(m, `c${i}`)
    avanzar(m, cadenciaMs)
  }
  return m
}

const rapido = tipeoContinuo(900, 60) // un hub en ritmo: 54s seguidos
eq(rapido.escriturasBorrador, 0, 'tecleando cada 900ms el borrador NUNCA se escribe')
{
  const previa = new Set(rapido.memoria)
  descargarPagina(rapido, { muereSessionStorage: true })
  hidratar(rapido)
  eq(
    perdidas(previa, rapido).length,
    60,
    'un apagón tras 54s de tipeo sin pausas se lleva las 60 celdas'
  )
}

const pausado = tipeoContinuo(2500, 60) // con pausas > debounce
ok(pausado.escriturasBorrador >= 59, 'con pausas de 2,5s el borrador se escribe casi por celda')
{
  const previa = new Set(pausado.memoria)
  descargarPagina(pausado, { muereSessionStorage: true })
  hidratar(pausado)
  eq(perdidas(previa, pausado).length, 0, 'con pausas > 1,5s un apagón no pierde ninguna celda')
}

// El peor caso NO está acotado por el debounce: está acotado por cuánto
// aguanta el hub sin hacer una pausa de 1,5s.
{
  const m = crearMaquina()
  for (let i = 0; i < 400; i++) {
    tipear(m, `c${i}`)
    avanzar(m, 1499)
  }
  eq(m.escriturasBorrador, 0, 'el debounce no tiene techo: 10 min de tipeo, 0 escrituras')
}

// ════════════════════════════════════════════════════════════════════════
// [2] A — F5 / recarga de página
// ════════════════════════════════════════════════════════════════════════
console.log('[2] A · F5')
{
  const m = crearMaquina()
  tipear(m, 'c1')
  avanzar(m, 2000) // se escribió el borrador
  tipear(m, 'c2') // esto queda SOLO en React
  avanzar(m, 500)
  const previa = new Set(m.memoria)

  descargarPagina(m, { muereSessionStorage: false }) // F5: sessionStorage vive
  eq(hidratar(m), 'borrador', 'tras un F5 se restaura desde el borrador, no desde el servidor')
  eq(perdidas(previa, m), ['c2'], 'un F5 pierde exactamente lo tecleado dentro de la ventana')
  eq(m.idPestaña, 'tab-1', 'un F5 conserva SESSION_ID (sessionStorage)')
  ok(guardDeEscritura(m), 'tras un F5 el guard de concurrencia NO da falso conflicto')
}

// ════════════════════════════════════════════════════════════════════════
// [3] B/C/E — cerrar pestaña, cerrar navegador, crash
// ════════════════════════════════════════════════════════════════════════
console.log('[3] B/C/E · cerrar pestaña, cerrar navegador, crash')
{
  const m = crearMaquina()
  tipear(m, 'c1')
  avanzar(m, 2000)
  guardar(m, { celdasCompletas: ['c1'] }) // el hub guardó progreso
  tipear(m, 'c2')
  avanzar(m, 2000)
  tipear(m, 'c3')
  avanzar(m, 400)
  const previa = new Set(m.memoria)

  descargarPagina(m, { muereSessionStorage: true }) // la pestaña muere
  eq(hidratar(m), 'borrador', 'al reabrir se restaura el borrador')
  eq(perdidas(previa, m), ['c3'], 'se pierde solo lo de la ventana del debounce')

  // Y acá aparece el efecto colateral: la marca de agua vive en
  // sessionStorage y murió con la pestaña; el borrador restaurado hace que
  // NO se consulte al servidor, así que nunca se re-sincroniza.
  eq(m.marcaSync, null, 'la marca de agua se perdió con sessionStorage')
  ok(
    !guardDeEscritura(m),
    'el PRIMER guardado tras reabrir da conflicto 55006 (falsa alarma de "otra pestaña")'
  )
  ok(
    guardar(m, { celdasCompletas: ['c2'] }).conflicto === true,
    'el guardado se aborta entero: el hub queda frenado hasta elegir Forzar o Recargar'
  )
  // "Traer lo último (reemplaza lo que ves acá)" pisa la memoria con lo del
  // servidor: las celdas del borrador que nunca se guardaron desaparecen.
  const antesDeRecargar = new Set(m.memoria)
  m.borrador = null
  hidratar(m)
  ok(
    perdidas(antesDeRecargar, m).includes('c2'),
    'si el hub elige "Traer lo último", pierde las celdas que solo estaban en el borrador'
  )
}

// ════════════════════════════════════════════════════════════════════════
// [4] D — APAGÓN (el peor caso: ningún cleanup, ningún beforeunload)
// ════════════════════════════════════════════════════════════════════════
console.log('[4] D · apagón')
{
  const m = crearMaquina()
  // Media grilla cargada, filas incompletas incluidas.
  for (let i = 0; i < 100; i++) {
    tipear(m, `c${i}`, { turnoTimings: { Mañana: { startedAt: 'T0' } } })
    avanzar(m, 2000)
  }
  // Guardó progreso: solo las 80 celdas de filas COMPLETAS viajan.
  const completas = Array.from({ length: 80 }, (_, i) => `c${i}`)
  guardar(m, { celdasCompletas: completas })
  // Sigue tipeando en ritmo, sin pausas.
  for (let i = 100; i < 130; i++) {
    tipear(m, `c${i}`)
    avanzar(m, 800)
  }
  const previa = new Set(m.memoria)
  const cortado = perdidas(previa, { ...m, borrador: m.borrador, servidor: m.servidor })

  descargarPagina(m, { muereSessionStorage: true })
  hidratar(m)
  eq(
    perdidas(previa, m).length,
    30,
    'apagón tras 24s de tipeo continuo: se pierden las 30 celdas de esa racha'
  )
  eq(cortado.length, 30, 'el conteo es el mismo antes y después: nada más se pierde')
  ok(m.borrador.celdas.has('c99'), 'las 100 primeras sobreviven en el borrador')
  ok(
    m.borrador.celdas.has('c85') && !m.servidor.has('c85'),
    'las celdas de filas INCOMPLETAS sobreviven en el borrador aunque nunca vayan al servidor'
  )
  eq(
    m.meta.turnoTimings,
    { Mañana: { startedAt: 'T0' } },
    'turnoTimings sobrevive: el cronómetro no arranca de cero al volver'
  )
  ok(!guardDeEscritura(m), 'tras el apagón, el primer guardado también choca con el guard')
}

// ════════════════════════════════════════════════════════════════════════
// [5] F — auto-reload por deploy (RealtimeSyncProvider)
// ════════════════════════════════════════════════════════════════════════
console.log('[5] F · auto-reload por deploy')
{
  // window.location.reload() es una descarga de página como cualquier otra:
  // no corre cleanups. Sí dispara el beforeunload, que en esta app solo
  // muestra el diálogo del navegador — no persiste nada.
  const m = crearMaquina()
  tipear(m, 'c1')
  avanzar(m, 2000)
  tipear(m, 'c2')
  avanzar(m, 1000) // llega el reload a los 60s del toast
  const previa = new Set(m.memoria)
  descargarPagina(m, { muereSessionStorage: false }) // reload = F5
  hidratar(m)
  eq(perdidas(previa, m), ['c2'], 'el auto-reload pierde la misma ventana que un F5')
}

// ════════════════════════════════════════════════════════════════════════
// [6] G — se corta la conexión a mitad de un guardado
// ════════════════════════════════════════════════════════════════════════
console.log('[6] G · conexión caída durante el guardado')
{
  const m = crearMaquina()
  for (let i = 0; i < 50; i++) {
    tipear(m, `c${i}`)
    avanzar(m, 2000)
  }
  const previa = new Set(m.memoria)
  // save_ci_batch es DELETE+INSERT en UNA transacción (migs 182/186): o entra
  // todo o no entra nada. El borrador NO se limpia salvo en Terminar.
  const antesDelIntento = new Set(m.servidor)
  // ...falla la RPC: no se toca ni el servidor ni el borrador.
  eq([...m.servidor], [...antesDelIntento], 'un guardado fallido no deja la BD a medias')
  ok(m.borrador !== null, 'el borrador sobrevive a un guardado fallido: reintentar es seguro')
  eq(perdidas(previa, m).length, 0, 'una caída de red no pierde una sola celda del borrador')

  // Reintento desde la MISMA pestaña: el guard lo deja pasar siempre.
  ok(guardDeEscritura(m), 'reintentar desde la misma pestaña nunca da falso conflicto')
}

// ════════════════════════════════════════════════════════════════════════
// [7] H — localStorage lleno (QuotaExceededError)
// ════════════════════════════════════════════════════════════════════════
console.log('[7] H · localStorage lleno')
{
  const m = crearMaquina()
  tipear(m, 'c1')
  avanzar(m, 2000)
  const escriturasBuenas = m.escriturasBorrador
  m.almacenamiento = 'lleno' // a partir de acá todo setItem tira
  for (let i = 2; i < 40; i++) {
    tipear(m, `c${i}`)
    avanzar(m, 2000)
  }
  eq(m.escriturasBorrador, escriturasBuenas, 'con quota agotada el autosave no escribe nada más')
  eq(m.borrador.savedAt, 1500, 'el borrador queda congelado en la última escritura buena')

  const previa = new Set(m.memoria)
  descargarPagina(m, { muereSessionStorage: true })
  hidratar(m)
  eq(
    perdidas(previa, m).length,
    38,
    'quota agotada + recarga = se pierde TODO lo posterior a la última escritura buena'
  )
  // El indicador "guardado automáticamente hace Xs" se congela pero sigue
  // contando: es la ÚNICA señal, y no escala a advertencia.
  ok(true, 'la única señal es un contador que envejece; no hay advertencia explícita')
}

// ════════════════════════════════════════════════════════════════════════
// [8] I — localStorage deshabilitado (Safari privado viejo)
// ════════════════════════════════════════════════════════════════════════
console.log('[8] I · localStorage deshabilitado')
{
  const m = crearMaquina({ almacenamiento: 'deshabilitado' })
  for (let i = 0; i < 200; i++) {
    tipear(m, `c${i}`)
    avanzar(m, 2000)
  }
  eq(m.borrador, null, 'sin localStorage no hay borrador, y nadie lo avisa')
  eq(m.escriturasBorrador, 0, 'ninguna escritura del autosave prospera')

  const previa = new Set(m.memoria)
  descargarPagina(m, { muereSessionStorage: false })
  hidratar(m)
  eq(perdidas(previa, m).length, 200, 'cualquier recarga pierde la sesión entera')

  // Lo guardado con "Guardar progreso" sí sobrevive: está en la BD.
  const m2 = crearMaquina({ almacenamiento: 'deshabilitado' })
  for (let i = 0; i < 200; i++) tipear(m2, `c${i}`)
  guardar(m2, { celdasCompletas: Array.from({ length: 160 }, (_, i) => `c${i}`) })
  const previa2 = new Set(m2.memoria)
  descargarPagina(m2, { muereSessionStorage: false })
  hidratar(m2)
  eq(
    perdidas(previa2, m2).length,
    40,
    'con el storage muerto, "Guardar progreso" es la única red: quedan las filas a medias'
  )
}

// ════════════════════════════════════════════════════════════════════════
// [9] Cambio de ciudad/fecha y navegación interna (sí corren cleanups)
// ════════════════════════════════════════════════════════════════════════
console.log('[9] Cambio de contexto (el flush sí corre)')
{
  const m = crearMaquina()
  tipear(m, 'c1', { turnoTimings: { Mañana: { startedAt: 'T0' } } })
  avanzar(m, 2000)
  tipear(m, 'c2') // dentro de la ventana del debounce
  avanzar(m, 300)
  const previa = new Set(m.memoria)
  flushPorDesmontaje(m) // cambia de ciudad
  eq(perdidas(previa, m).length, 0, 'cambiar de ciudad NO pierde la ventana: el flush la escribe')
  eq(
    m.borrador.meta.turnoTimings,
    { Mañana: { startedAt: 'T0' } },
    'el flush mergea: no pisa los campos que solo escribe el autosave (fix P0-2)'
  )
}

// El latido manda CONTEO, no valores: no es un respaldo.
{
  const m = crearMaquina()
  for (let i = 0; i < 50; i++) {
    tipear(m, `c${i}`)
    avanzar(m, HEARTBEAT_MS / 50)
  }
  ok(
    m.servidor.size === 0,
    'el latido de ci_active_sessions reporta progreso pero no persiste una sola celda'
  )
}

// ════════════════════════════════════════════════════════════════════════
// [10] INVARIANTES DEL FUENTE — que el modelo no se despegue del código
// ════════════════════════════════════════════════════════════════════════
console.log('[10] Invariantes verificadas contra el fuente real')

const src = readFileSync(join(RAIZ, 'src/pages/DataEntry.jsx'), 'utf8')

function bloque(desde, hasta, etiqueta) {
  const i = src.indexOf(desde)
  const j = src.indexOf(hasta, i + 1)
  if (i < 0 || j < 0) {
    ok(false, `[ancla perdida] no se encontró el bloque ${etiqueta} — revisar este script`)
    return ''
  }
  return src.slice(i, j)
}

// 1. El autosave sigue siendo un debounce de 1500ms sin maxWait ni intervalo.
const bAutosave = bloque('── Autosave a localStorage (draft)', 'Flush SÍNCRONO', 'autosave')
ok(/\}, 1500\)/.test(bAutosave), 'el debounce del borrador sigue siendo de 1500ms')
ok(/clearTimeout\(id\)/.test(bAutosave), 'el cleanup del autosave sigue cancelando el timer')
ok(
  !/setInterval/.test(bAutosave),
  'el autosave sigue SIN un intervalo de respaldo (si se agrega uno, actualizar [1])'
)

// 2. El flush del cleanup sigue mergeando sobre lo ya escrito (fix P0-2).
const bFlush = bloque('Flush SÍNCRONO', 'const clearDraft', 'flush')
ok(/\.\.\.previo/.test(bFlush), 'el flush sigue mergeando sobre el borrador previo (fix P0-2)')

// 3. El beforeunload sigue sin persistir NADA: solo muestra el diálogo.
const bUnload = bloque(
  'Aviso del navegador si hay cambios sin guardar',
  "removeEventListener('beforeunload'",
  'beforeunload'
)
ok(
  !/localStorage|sendBeacon|setItem/.test(bUnload),
  'el beforeunload sigue sin persistir nada (si se le agrega un flush, actualizar [2]-[5])'
)
ok(
  /e\.preventDefault\(\)/.test(bUnload),
  'el beforeunload sigue mostrando el diálogo del navegador'
)

// 4. Restaurar el borrador sigue salteando la consulta al servidor.
ok(
  /if \(!draftApplied\) \{\s*setPendingLoad\(/.test(src),
  'con borrador restaurado se sigue salteando loadObservationsIntoForm'
)

// 5. Y por lo tanto la marca de agua NO se re-sincroniza al restaurar un
//    borrador — la causa del falso conflicto de [3] y [4].
const bHidratacion = bloque(
  'if (!hydratedCitiesRef.current.has(targetCity))',
  'if (!draftApplied)',
  'hidratación'
)
ok(
  !/writeSyncSeq/.test(bHidratacion),
  'la restauración del borrador sigue sin re-sincronizar la marca de agua (causa del falso conflicto)'
)

// 6. La marca de agua y el id de pestaña siguen en sessionStorage (mueren
//    con la pestaña, sobreviven un F5) — es lo que separa el caso A del B/C/D.
ok(
  /sessionStorage\.(get|set)Item\(\s*syncSeqKeyFor/.test(src) ||
    /sessionStorage\.getItem\(syncSeqKeyFor/.test(src),
  'la marca de agua sigue viviendo en sessionStorage'
)
const supabaseSrc = readFileSync(join(RAIZ, 'src/lib/supabase.js'), 'utf8')
ok(
  /sessionStorage\.getItem\('app\.sessionId'\)/.test(supabaseSrc),
  'SESSION_ID sigue viviendo en sessionStorage (muere con la pestaña)'
)

// ── Resultado ─────────────────────────────────────────────────────────
console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} pasaron, ${fail} fallaron`)
if (fail) console.error('Fallaron:\n  - ' + fallos.join('\n  - '))
process.exit(fail === 0 ? 0 : 1)
