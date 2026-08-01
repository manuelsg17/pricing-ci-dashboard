// Simulaciones de la detección de inactividad (SESIONES_HALLAZGOS.md P1-6).
//
// LA PREGUNTA QUE RESPONDEN: ¿el número que ve el user mide TRABAJO o mide
// "cuánto tiempo estuvo abierta la pestaña"? Hoy mide lo segundo, y el techo
// de 4h por turno (mig 194) lo tapa sin medirlo: 4h por 150 minutos reales
// sigue siendo el triple, y entra al promedio como si fuera un dato bueno.
//
// Los dos errores son igual de caros y por eso se prueban los dos:
//   · medir de MÁS (la laptop cerrada de 12 a 16 que hoy cuenta como trabajo)
//   · medir de MENOS (descontar los 2-3 minutos en que el hub consulta el
//     simulador del competidor, que SÍ son trabajo)
//
// Y la regla de honestidad que hereda de sessionDuration.js: sin traza de
// actividad NO se devuelve 0. Un 0 se promedia; un "no lo pude medir" se
// excluye.

import {
  UMBRAL_INACTIVIDAD_MS,
  COLA_ACTIVIDAD_MS,
  TIPOS_ACTIVIDAD,
  TIPOS_IGNORADOS,
  esActividad,
  registrarActividad,
  normalizarActividad,
  tramosActivos,
  huecosInactivos,
  tiempoActivo,
  interseccion,
  ventanasDeTurnos,
  duracionActiva,
} from '../src/lib/idleDetection.js'
import { duracionDeSesion, tramosDeTurnos } from '../src/lib/sessionDuration.js'

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

// Reloj fijo: nada de lo que se prueba puede depender de la hora real a la
// que corre el test.
const DIA = '2026-08-01'
const AYER = '2026-07-31'
const iso = (dia, hhmm) => `${dia}T${hhmm}:00.000Z`
const ms = (dia, hhmm) => new Date(iso(dia, hhmm)).getTime()
const MIN = 60_000

// Traza de un hub que teclea cada `cadaMin` minutos entre dos horas.
function tecleando(desde, hasta, cadaMin = 2, traza = []) {
  let t = traza
  for (let ts = desde; ts <= hasta; ts += cadaMin * MIN) t = registrarActividad(t, ts)
  return t
}

// ── [1] El caso reportado: la laptop cerrada de 12 a 16 ────────────────
// "10:00 a 16:30 con la laptop cerrada de 12 a 16 marca 06:30 por ~150 min
// reales" (P1-6, textual). Es la razón de ser de todo este archivo.
console.log('[1] Laptop cerrada de 12 a 16')
{
  const timings = { Mañana: { startedAt: iso(DIA, '10:00'), endedAt: iso(DIA, '16:30') } }
  const traza = tecleando(
    ms(DIA, '16:00'),
    ms(DIA, '16:30'),
    2,
    tecleando(ms(DIA, '10:00'), ms(DIA, '12:00'), 2)
  )

  const r = duracionActiva({ turnoTimings: timings, actividad: traza, fin: ms(DIA, '16:30') })

  eq(r.minutosPared, 390, 'el reloj de pared sigue diciendo 6h30 (390 min)')
  eq(r.minutos, 151, 'el tiempo ACTIVO son ~150 min (120 + cola + 30)')
  eq(r.descontados, 239, 'se descuentan las ~4h de laptop cerrada')
  ok(r.actividadMedida === true, 'la medición se declara hecha')
  eq(r.huecos.length, 1, 'el hueco descontado es UNO y queda auditable')
  eq(r.huecos[0].minutos, 239, 'el hueco mide lo que se descontó')
  eq(r.cobertura, 0.39, 'la cobertura delata la sesión (39%)')

  // El techo de 4h de sessionDuration.js habría recortado la ventana a
  // [10:00, 14:00] y los 30 minutos reales de las 16:00 no existirían.
  // Es la razón por la que este módulo NO usa tramosDeTurnos().
  const conTecho = duracionDeSesion({ turnoTimings: timings, fin: ms(DIA, '16:30') })
  eq(conTecho.minutos, 240, 'lo que hoy escribe la base: 240 min capados (ni 390 ni 151)')
}

// ── [2] Medir de menos es tan malo como medir de más ───────────────────
// El hub abre la app del competidor, pone origen y destino, espera la
// cotización, saca la captura y recién ahí teclea. Ese silencio de 1-3 min es
// TRABAJO. Si el umbral se lo come, la métrica dice que el corte se hace en
// la mitad de tiempo y la próxima planificación sale mal.
console.log('[2] Las consultas al simulador NO se descuentan')
{
  const timings = { Mañana: { startedAt: iso(DIA, '09:00'), endedAt: iso(DIA, '10:00') } }
  // Una ráfaga de tecleo por fila, con 3 minutos de consulta entre filas. El
  // último fill es el que completa el turno, así que coincide con su endedAt.
  let traza = []
  for (let m = 0; m <= 60; m += 3) {
    traza = registrarActividad(traza, ms(DIA, '09:00') + m * MIN)
    if (m < 60) traza = registrarActividad(traza, ms(DIA, '09:00') + m * MIN + 20_000)
  }
  const r = duracionActiva({ turnoTimings: timings, actividad: traza, fin: ms(DIA, '10:00') })
  eq(r.minutos, 60, 'una hora de carga normal mide una hora, no 20 minutos')
  eq(r.descontados, 0, 'no se descuenta ni un minuto de trabajo real')
  eq(r.huecos.length, 0, 'no hay huecos que reportar')
}

// ── [3] Sin traza NO se devuelve 0 ─────────────────────────────────────
// Bundle viejo, borrador de otra máquina, localStorage deshabilitado. Es el
// mismo pecado que sessionDuration.js documenta: un 0 entra en cualquier
// promedio y hace creer que el corte fue instantáneo.
console.log('[3] Sin traza: se conserva el número de pared, marcado')
{
  const timings = { Mañana: { startedAt: iso(DIA, '09:00'), endedAt: iso(DIA, '10:00') } }
  for (const sin of [null, undefined, [], 'basura', [{ inicio: 'x', fin: 'y' }]]) {
    const r = duracionActiva({ turnoTimings: timings, actividad: sin, fin: ms(DIA, '10:00') })
    eq(r.minutos, 60, `sin traza (${JSON.stringify(sin)}) devuelve la pared, no 0`)
    ok(r.actividadMedida === false, `sin traza (${JSON.stringify(sin)}) se declara NO medida`)
    eq(r.descontados, null, 'no se puede decir cuánto se descontó')
  }
}

// ── [4] Traza incoherente: tampoco inventa un 0 ────────────────────────
// El borrador viene de otro día o de otra máquina y no toca los turnos.
// Medir 0 sobre una pared de 2 horas sería peor que no medir.
console.log('[4] Traza que no toca los turnos')
{
  const timings = { Mañana: { startedAt: iso(DIA, '09:00'), endedAt: iso(DIA, '11:00') } }
  const traza = tecleando(ms(AYER, '09:00'), ms(AYER, '10:00'), 2)
  const r = duracionActiva({ turnoTimings: timings, actividad: traza, fin: ms(DIA, '11:00') })
  eq(r.minutos, 120, 'se conserva la pared')
  ok(r.actividadMedida === false, 'se declara NO medida')
  eq(r.motivoActividad, 'actividad_incoherente', 'y el motivo dice por qué')
}

// ── [5] El hot path: registrarActividad ────────────────────────────────
console.log('[5] registrarActividad')
{
  const t0 = ms(DIA, '09:00')
  eq(registrarActividad([], t0), [{ inicio: t0, fin: t0 }], 'primer evento abre tramo')

  const dentro = registrarActividad([{ inicio: t0, fin: t0 }], t0 + UMBRAL_INACTIVIDAD_MS)
  eq(
    dentro,
    [{ inicio: t0, fin: t0 + UMBRAL_INACTIVIDAD_MS }],
    'exactamente el umbral todavía fusiona'
  )

  const fuera = registrarActividad([{ inicio: t0, fin: t0 }], t0 + UMBRAL_INACTIVIDAD_MS + 1)
  eq(fuera.length, 2, 'un milisegundo más que el umbral abre tramo nuevo')

  // Idempotencia y monotonía: un evento viejo (reloj corregido hacia atrás,
  // traza rehidratada de otro tab) no debe retroceder el tramo ni fabricar
  // tiempo. Devuelve la MISMA referencia para no re-renderizar la grilla.
  const traza = [{ inicio: t0, fin: t0 + 10 * MIN }]
  ok(
    registrarActividad(traza, t0 + 5 * MIN) === traza,
    'evento viejo no toca la traza (misma referencia)'
  )
  ok(registrarActividad(traza, NaN) === traza, 'NaN no toca la traza')
  ok(registrarActividad(traza, null) === traza, 'null no toca la traza')
  ok(registrarActividad(traza, undefined) === traza, 'undefined no toca la traza')

  // 3000 tecleos seguidos no hacen crecer la traza: es lo que permite que
  // viva en localStorage y sobreviva al F5 (CLAUDE.md §2).
  let larga = []
  for (let i = 0; i < 3000; i++) larga = registrarActividad(larga, t0 + i * 1000)
  eq(larga.length, 1, '3000 eventos seguidos son UN tramo (la traza no explota)')
}

// ── [6] Sobrevivir al F5 ───────────────────────────────────────────────
// Al rehidratar hay DOS trazas: la del borrador y la que se acumuló desde
// entonces. Fusionarlas no debe inventar un hueco donde no lo hubo.
console.log('[6] Rehidratación tras un F5')
{
  const delBorrador = tecleando(ms(DIA, '09:00'), ms(DIA, '09:30'), 2)
  // El F5 tarda 20 segundos; el hub sigue en lo mismo.
  const despues = tecleando(ms(DIA, '09:30') + 20_000, ms(DIA, '10:00'), 2)
  const unida = normalizarActividad([...delBorrador, ...despues])
  eq(unida.length, 1, 'un F5 corto no parte la traza en dos')
  eq(unida[0].inicio, ms(DIA, '09:00'), 'y conserva el inicio real, anterior al F5')
  eq(unida[0].fin, ms(DIA, '09:58') + 20_000, 'y llega hasta el último tecleo posterior')

  // Desordenadas (llegaron de dos lados) da lo mismo.
  eq(normalizarActividad([...despues, ...delBorrador]), unida, 'el orden de las fuentes no importa')

  // Un F5 que tarda MÁS que el umbral sí es un hueco: el hub se fue.
  const tarde = tecleando(ms(DIA, '09:36'), ms(DIA, '10:00'), 2)
  eq(
    normalizarActividad([...delBorrador, ...tarde]).length,
    2,
    '6 minutos de silencio sí parten la traza'
  )
}

// ── [7] La cola: un tecleo aislado no mide CERO ────────────────────────
// Sin cola, todos los tramos de un evento único tendrían ancho 0 y la sesión
// entera mediría 0 minutos — el mismo síntoma que este frente vino a matar.
console.log('[7] Cola de actividad')
{
  const t0 = ms(DIA, '09:00')
  const r = tiempoActivo([{ inicio: t0, fin: t0 }])
  eq(r.minutos, COLA_ACTIVIDAD_MS / MIN, 'un evento aislado cuenta la cola, no 0')

  // Acotada por el fin de la ventana: si el último evento es el click en
  // "Terminar", la cola vale ~0 y no infla nada.
  const acotada = tiempoActivo([{ inicio: t0, fin: t0 + 10 * MIN }], {
    ventana: { inicio: t0, fin: t0 + 10 * MIN },
  })
  eq(acotada.minutos, 10, 'la cola nunca pasa el fin de la ventana')
}

// ── [8] Desglose por turno ─────────────────────────────────────────────
// Es el número que pidió el user: cuánto le toma el corte de la mañana, el de
// la tarde y el de la noche. Con inactividad descontada por turno.
console.log('[8] Minutos activos por turno')
{
  const timings = {
    Mañana: { startedAt: iso(DIA, '09:00'), endedAt: iso(DIA, '10:00') },
    Tarde: { startedAt: iso(DIA, '13:00'), endedAt: iso(DIA, '15:00') },
  }
  // Mañana entera; en la Tarde el hub se va 90 minutos al medio.
  let traza = tecleando(ms(DIA, '09:00'), ms(DIA, '10:00'), 2)
  traza = tecleando(ms(DIA, '13:00'), ms(DIA, '13:15'), 2, traza)
  traza = tecleando(ms(DIA, '14:45'), ms(DIA, '15:00'), 2, traza)

  const r = duracionActiva({ turnoTimings: timings, actividad: traza, fin: ms(DIA, '15:00') })
  eq(r.porTurno.length, 2, 'un desglose por turno')
  eq(r.porTurno[0], { label: 'Mañana', minutos: 60, minutosPared: 60 }, 'Mañana: 60 activos de 60')
  eq(r.porTurno[1], { label: 'Tarde', minutos: 30, minutosPared: 120 }, 'Tarde: 30 activos de 120')
  eq(r.minutos, 90, 'el total es la suma de lo activo, no de la pared')
}

// ── [9] Turnos intercalados: unión, no suma ────────────────────────────
// Mismo criterio que sessionDuration.js: un hub puede intercalar Mañana y
// Tarde, y sumar contaría dos veces el mismo minuto de reloj.
console.log('[9] Turnos solapados')
{
  const timings = {
    Mañana: { startedAt: iso(DIA, '09:00'), endedAt: iso(DIA, '10:00') },
    Tarde: { startedAt: iso(DIA, '09:30'), endedAt: iso(DIA, '10:30') },
  }
  const traza = tecleando(ms(DIA, '09:00'), ms(DIA, '10:30'), 2)
  const r = duracionActiva({ turnoTimings: timings, actividad: traza, fin: ms(DIA, '10:30') })
  eq(r.minutosPared, 90, 'la pared es la unión (90), no la suma (120)')
  eq(r.minutos, 90, 'lo activo tampoco se cuenta dos veces')
}

// ── [10] Lo activo nunca puede superar la pared ────────────────────────
// Propiedad, no caso puntual: si esto se rompe, el número volvió a mentir en
// la dirección vieja.
console.log('[10] Invariante activo ≤ pared')
{
  const escenarios = [
    { desde: '09:00', hasta: '09:05', turno: ['09:00', '09:05'] },
    { desde: '09:00', hasta: '11:00', turno: ['09:00', '11:00'] },
    { desde: '09:00', hasta: '09:10', turno: ['09:00', '13:00'] },
    // La traza se estira más allá del turno (el hub siguió tocando la app
    // después del último fill): la ventana de trabajo manda.
    { desde: '09:00', hasta: '12:00', turno: ['09:00', '10:00'] },
  ]
  for (const e of escenarios) {
    const timings = { M: { startedAt: iso(DIA, e.turno[0]), endedAt: iso(DIA, e.turno[1]) } }
    const traza = tecleando(ms(DIA, e.desde), ms(DIA, e.hasta), 1)
    const r = duracionActiva({ turnoTimings: timings, actividad: traza, fin: ms(DIA, e.turno[1]) })
    ok(r.minutos <= r.minutosPared, `activo ≤ pared en ${JSON.stringify(e)}`)
    ok(r.minutos >= 0, `activo ≥ 0 en ${JSON.stringify(e)}`)
  }
}

// ── [11] Qué cuenta como actividad ─────────────────────────────────────
// Basta con que UNO de los eventos de segundo plano cuente para que una
// laptop abierta y sola "trabaje" toda la noche: el bug de vuelta, con más
// pasos.
console.log('[11] esActividad')
{
  for (const t of TIPOS_ACTIVIDAD) ok(esActividad(t) === true, `cuenta: ${t}`)
  for (const t of TIPOS_IGNORADOS) ok(esActividad(t) === false, `no cuenta: ${t}`)
  ok(esActividad('lo_que_sea_nuevo') === false, 'un tipo desconocido NO cuenta (lado conservador)')
  ok(esActividad(undefined) === false, 'undefined no cuenta')
  ok(
    TIPOS_ACTIVIDAD.every((t) => !TIPOS_IGNORADOS.includes(t)),
    'ningún tipo está en las dos listas'
  )
}

// ── [12] Laptop abierta y sola: solo latidos ───────────────────────────
// El escenario que hace falta que NO se cuente. Como los latidos no generan
// traza, no hay actividad: se conserva la pared marcada como no medida, que
// es lo honesto — no se puede afirmar que trabajó ni que no.
console.log('[12] Solo latidos, nadie delante')
{
  const timings = { Mañana: { startedAt: iso(DIA, '10:00'), endedAt: iso(DIA, '18:00') } }
  const traza = [] // ningún evento de TIPOS_ACTIVIDAD llegó nunca
  const r = duracionActiva({ turnoTimings: timings, actividad: traza, fin: ms(DIA, '18:00') })
  ok(r.actividadMedida === false, 'sin eventos reales no se declara medición')
  eq(r.minutos, r.minutosPared, 'y el número no cambia respecto de hoy')
}

// ── [13] Huecos: se reportan para poder auditarlos ─────────────────────
console.log('[13] Huecos')
{
  const t0 = ms(DIA, '09:00')
  const traza = [
    { inicio: t0, fin: t0 + 10 * MIN },
    { inicio: t0 + 60 * MIN, fin: t0 + 70 * MIN },
  ]
  const h = huecosInactivos(traza, { ventana: { inicio: t0, fin: t0 + 70 * MIN } })
  eq(h.length, 1, 'un hueco entre las dos ráfagas')
  eq(h[0].minutos, 49, 'mide 49 min (50 menos la cola del tramo previo)')

  // El silencio FINAL también es un hueco: el hub dejó de tocar la grilla y
  // recién 40 minutos después apretó Terminar.
  const hFinal = huecosInactivos([{ inicio: t0, fin: t0 + 10 * MIN }], {
    ventana: { inicio: t0, fin: t0 + 50 * MIN },
  })
  eq(hFinal.length, 1, 'el silencio final se reporta')
  ok(hFinal[0].final === true, 'y se marca como final')
}

// ── [14] Utilidades ────────────────────────────────────────────────────
console.log('[14] interseccion / tramosActivos')
{
  const t0 = ms(DIA, '09:00')
  eq(
    interseccion(
      [
        { inicio: t0, fin: t0 + 10 * MIN },
        { inicio: t0 + 20 * MIN, fin: t0 + 30 * MIN },
      ],
      [{ inicio: t0 + 5 * MIN, fin: t0 + 25 * MIN }]
    ),
    [
      { inicio: t0 + 5 * MIN, fin: t0 + 10 * MIN },
      { inicio: t0 + 20 * MIN, fin: t0 + 25 * MIN },
    ],
    'intersección de dos listas'
  )
  eq(interseccion([], [{ inicio: t0, fin: t0 + MIN }]), [], 'intersección vacía')
  eq(interseccion(null, null), [], 'null no rompe')
  eq(normalizarActividad([{ inicio: 5, fin: 1 }]), [], 'un tramo invertido se descarta')
  eq(tramosActivos([]), [], 'traza vacía no genera tramos')
}

// ── [15] Paridad con sessionDuration.js ────────────────────────────────
// `ventanasDeTurnos` reimplementa el parseo de turno_timings para poder
// saltearse el techo de 4h. Reimplementar es aceptar el riesgo de divergencia
// (CLAUDE.md §4), así que se verifica: mientras el techo NO entre en juego,
// las dos funciones tienen que ver exactamente los mismos tramos.
console.log('[15] Paridad con tramosDeTurnos (sin techo de por medio)')
{
  const casos = [
    { M: { startedAt: iso(DIA, '09:00'), endedAt: iso(DIA, '09:40') } },
    // Los tres formatos de fecha que aparecen en el código real.
    { M: { startedAt: ms(DIA, '09:00'), endedAt: ms(DIA, '09:40') } },
    { M: { startedAt: new Date(ms(DIA, '09:00')), endedAt: new Date(ms(DIA, '09:40')) } },
    // endedAt invertido → cae al fin de sesión en las dos.
    { M: { startedAt: iso(DIA, '10:00'), endedAt: iso(DIA, '09:00') } },
    // Turno abierto → se cierra con el fin de sesión en las dos.
    { M: { startedAt: iso(DIA, '10:00') } },
    // Basura: se ignora en las dos.
    { M: { startedAt: 'no soy una fecha' } },
    { M: {} },
    {},
    // Ancho cero: ninguna de las dos lo cuenta como trabajo.
    { M: { startedAt: iso(DIA, '09:00'), endedAt: iso(DIA, '09:00') } },
    // Varios turnos, desordenados en el objeto.
    {
      Tarde: { startedAt: iso(DIA, '13:00'), endedAt: iso(DIA, '13:35') },
      Mañana: { startedAt: iso(DIA, '09:00'), endedAt: iso(DIA, '09:40') },
    },
  ]
  const finSesion = ms(DIA, '11:00')
  for (const c of casos) {
    const mio = ventanasDeTurnos(c, { finDeSesion: finSesion })
    const suyo = tramosDeTurnos(c, { finDeSesion: finSesion })
      .filter((t) => t.fin != null && t.fin > t.inicio && !t.recortado)
      .map((t) => ({ label: t.label, inicio: t.inicio, fin: t.fin }))
    eq(mio, suyo, `paridad de parseo: ${JSON.stringify(c)}`)
  }

  // Y la diferencia que SÍ es intencional, explícita.
  const largo = { M: { startedAt: iso(DIA, '09:00'), endedAt: iso(DIA, '16:00') } }
  eq(
    ventanasDeTurnos(largo)[0].fin - ventanasDeTurnos(largo)[0].inicio,
    7 * 60 * MIN,
    'la ventana cruda mide 7h'
  )
  eq(tramosDeTurnos(largo)[0].minutos, 240, 'y tramosDeTurnos la recorta a 4h, como debe')
}

// ── Resultado ─────────────────────────────────────────────────────────
console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} pasaron, ${fail} fallaron`)
if (fail) console.error('Fallaron:\n  - ' + fallos.join('\n  - '))
process.exit(fail === 0 ? 0 : 1)
