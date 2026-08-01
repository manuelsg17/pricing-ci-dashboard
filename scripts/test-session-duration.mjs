// Simulaciones de `ci_sessions.duration_minutes`
// (reporte del user 2026-08-01: "no tenga data de sesiones terminadas en 0.1
// minutos que es lo que sucede actualmente").
//
// LO QUE SE PRUEBA ACÁ NO ES COSMÉTICO: el user usa este número para decidir
// cuánto le toma a cada hub el corte de la mañana, el de la tarde y el de la
// noche. Una duración que a veces miente es peor que no tenerla, porque se
// promedia con las buenas y contamina la conclusión.
//
// La regla que verifican casi todos los casos: **la duración mide TRABAJO,
// no mide cuánto tiempo estuvo abierta la pestaña.** El instante en que el
// hub apretó "Terminar" no debe influir en el resultado, y una laptop cerrada
// no es trabajo.

import {
  duracionDeSesion,
  tramosDeTurnos,
  minutosUnidos,
  minutosPorTurno,
  TURNO_MAX_MS,
  SESION_MAX_MS,
} from '../src/lib/sessionDuration.js'
import { turnoBreakdownLabel } from '../src/lib/timing.js'

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

// Reloj fijo: nada de lo que se prueba puede depender del reloj real, o el
// test pasaría o fallaría según la hora en que corre.
const DIA = '2026-08-01'
const AYER = '2026-07-31'
const iso = (dia, hhmm) => `${dia}T${hhmm}:00.000Z`
const ms = (dia, hhmm) => new Date(iso(dia, hhmm)).getTime()

// ── [1] Sesión normal de 3 turnos ─────────────────────────────────────
// El caso que el user quiere medir bien: el hub hace el corte de la mañana,
// el de la tarde y el de la noche, uno después del otro.
console.log('[1] Sesión normal de 3 turnos')
{
  const timings = {
    Mañana: { startedAt: iso(DIA, '09:00'), endedAt: iso(DIA, '09:40') },
    Tarde: { startedAt: iso(DIA, '13:00'), endedAt: iso(DIA, '13:35') },
    Noche: { startedAt: iso(DIA, '19:00'), endedAt: iso(DIA, '19:25') },
  }
  const r = duracionDeSesion({ turnoTimings: timings, fin: ms(DIA, '19:26') })
  eq(r.minutos, 100, '40 + 35 + 25 = 100 min de trabajo real')
  eq(r.fuente, 'turnos', 'la fuente es el desglose por turno')
  ok(r.confiable, 'sin recortes → confiable')
  eq(
    minutosPorTurno(timings).map((t) => [t.label, t.minutos]),
    [
      ['Mañana', 40],
      ['Tarde', 35],
      ['Noche', 25],
    ],
    'el desglose por turno es lo que pidió el user'
  )
  // 09:00 → 19:26 son 626 minutos de pared. El cronómetro viejo habría
  // escrito eso: 6 veces el trabajo real, porque cuenta el almuerzo y las
  // 5 horas entre el corte de la tarde y el de la noche.
  eq(r.inicio, ms(DIA, '09:00'), 'started_at = primer trabajo real')
  eq(r.fin, ms(DIA, '19:25'), 'ended_at = último trabajo real, no el click')
}

// ── [2] EL BUG REPORTADO: Aeropuerto "Ambos", dos puntos de una sentada ──
// El hub declara alcance A+B, llena las DOS grillas, y recién ahí cierra
// las dos seguidas. Al cerrar A, DataEntry reinicia `sessionStartRef` a
// Date.now() para no sumarle a B el tiempo de A. Entre un Terminar y el otro
// pasan 6 segundos → B se guardaba como 0.1 min.
console.log('[2] Aeropuerto "Ambos": dos puntos terminados en la misma sentada')
{
  // Punto A: se llenó de 09:00 a 09:50.
  const timingsA = { Mañana: { startedAt: iso(DIA, '09:00'), endedAt: iso(DIA, '09:50') } }
  // Punto B: se llenó de 09:50 a 10:45, en la misma sentada.
  const timingsB = { Mañana: { startedAt: iso(DIA, '09:50'), endedAt: iso(DIA, '10:45') } }

  const clickA = ms(DIA, '10:45')
  const clickB = clickA + 6000 // 6 segundos después: el síntoma exacto

  const a = duracionDeSesion({ turnoTimings: timingsA, inicioReloj: ms(DIA, '09:00'), fin: clickA })
  // Así queda `sessionStartRef` tras cerrar A (línea 2475 de DataEntry.jsx).
  const relojReiniciado = clickA
  const b = duracionDeSesion({ turnoTimings: timingsB, inicioReloj: relojReiniciado, fin: clickB })

  eq(a.minutos, 50, 'Punto A: 50 min reales')
  eq(b.minutos, 55, 'Punto B: 55 min reales, NO 0.1')
  ok(b.minutos > 1, 'el bug de 0.1 min no puede reproducirse por este camino')
  // La prueba de que la duración ya no depende del reloj de pared: mover el
  // click de Terminar 3 horas más tarde no cambia el número.
  eq(
    duracionDeSesion({ turnoTimings: timingsB, inicioReloj: relojReiniciado, fin: clickB + 3 * 3600_000 }).minutos,
    55,
    'terminar 3h más tarde da el MISMO número (no depende del click)'
  )
  eq(a.minutos + b.minutos, 105, 'los dos frentes suman el trabajo real, sin doble conteo')
}

// ── [3] Sesión interrumpida por F5 ────────────────────────────────────
// El caso que `debeReanudarTramo()` NO cubre y por el que igual salía 0.1:
// la grilla queda 100% llena (todos los turnos con endedAt estampado), el
// hub aprieta F5 antes de Terminar. Al rehidratar, la jornada figura
// "cerrada" → debeReanudarTramo devuelve false → sessionStartRef = Date.now().
console.log('[3] F5 con la grilla ya completa (jornada "cerrada" sin Terminar)')
{
  const timings = {
    Mañana: { startedAt: iso(DIA, '09:00'), endedAt: iso(DIA, '09:40') },
    Tarde: { startedAt: iso(DIA, '09:40'), endedAt: iso(DIA, '10:20') },
  }
  const F5 = ms(DIA, '10:21')
  const clickTerminar = F5 + 30_000 // 30 s después del refresh

  // Lo que hacía el cronómetro: arrancar de cero en el F5.
  const relojViejo = Math.round(((clickTerminar - F5) / 60000) * 10) / 10
  eq(relojViejo, 0.5, 'el cronómetro de pared habría escrito 0.5 min')

  const r = duracionDeSesion({ turnoTimings: timings, inicioReloj: F5, fin: clickTerminar })
  eq(r.minutos, 80, 'la duración real (80 min) sobrevive al F5')
  eq(r.fuente, 'turnos', 'no se cayó al reloj recién reiniciado')
}

// ── [4] Sesión reanudada al día siguiente ─────────────────────────────
// El hub deja Noche a medias, se va, y vuelve al otro día a esa pantalla.
// El riesgo simétrico: que el turno abierto de ayer se cierre con el "ahora"
// de hoy y escriba ~24h.
console.log('[4] Reanudada al día siguiente: el turno abierto de ayer no infla')
{
  const timings = {
    Mañana: { startedAt: iso(AYER, '09:00'), endedAt: iso(AYER, '09:45') },
    Noche: { startedAt: iso(AYER, '20:00') }, // quedó abierto
  }
  const finHoy = ms(DIA, '11:00') // 15 horas después del startedAt de Noche

  const r = duracionDeSesion({ turnoTimings: timings, fin: finHoy })
  // Noche se recorta a 4h en vez de contar 15h.
  eq(r.minutos, 45 + 240, 'el turno abierto se acota a 4h, no cuenta 15h')
  ok(!r.confiable, 'un tramo recortado marca la medición como NO confiable')
  eq(r.motivo, 'turno_recortado', 'el motivo dice exactamente qué pasó')

  // Y al MOSTRAR una fila histórica no hay "fin de sesión" con el que cerrar
  // ese turno: no se le inventa una duración, se muestra sin medir. (En
  // `duracionDeSesion` el fin siempre existe —es el instante del cierre— así
  // que este camino es el de la vista, no el del guardado.)
  const soloCerrados = tramosDeTurnos(timings)
  eq(
    soloCerrados.map((t) => [t.label, t.minutos]),
    [
      ['Mañana', 45],
      ['Noche', null],
    ],
    'sin fin de sesión, el turno abierto no inventa minutos'
  )
}

// ── [5] Sesión cerrada por el admin ───────────────────────────────────
// El camino de `admin_close_ci_session`. Antes escribía 0 literal cuando no
// encontraba fila de latido — y esa fila se borra en cualquier navegación
// interna del cliente (P1-4), así que el 0 no era un caso raro.
console.log('[5] Cierre administrativo')
{
  // 5a. Hay timings en el latido: el admin cierra y el trabajo real se
  //     conserva, sin importar cuándo apretó el botón.
  const timings = {
    Mañana: { startedAt: iso(DIA, '09:00'), endedAt: iso(DIA, '09:55') },
    Tarde: { startedAt: iso(DIA, '14:00') }, // el hub se fue sin cerrarlo
  }
  const cierreAdmin = ms(DIA, '19:30') // 5h30 después de abrir la Tarde
  const r = duracionDeSesion({ turnoTimings: timings, fin: cierreAdmin })
  eq(r.minutos, 55 + 240, 'Mañana real + Tarde acotada a 4h')
  ok(!r.confiable, 'el admin ve que la Tarde es un tope, no un dato')

  // Un turno abierto que se cierra DENTRO del techo sí es un dato bueno: el
  // cierre es el fin real de ese trabajo, no una estimación floja. Es el caso
  // normal del "Terminar" del propio hub con el último turno a medias.
  const aMedias = duracionDeSesion({
    turnoTimings: { Mañana: { startedAt: iso(DIA, '09:00') } },
    fin: ms(DIA, '09:35'),
  })
  eq(aMedias.minutos, 35, 'turno a medias cerrado por el Terminar: 35 min')
  ok(aMedias.confiable, 'y eso SÍ es confiable — el fin es real, no un tope')

  // 5b. Sin latido y sin timings: NULL, nunca 0.
  const vacio = duracionDeSesion({ turnoTimings: null, inicioReloj: null, fin: cierreAdmin })
  eq(vacio.minutos, null, 'sin nada que medir devuelve null, NO 0')
  eq(vacio.fuente, 'desconocida', 'y lo declara como desconocida')
  ok(vacio.minutos !== 0, 'un 0 se promedia y miente; un null se excluye')

  // 5c. Sin timings pero con reloj: se usa acotado, marcado no confiable.
  const soloReloj = duracionDeSesion({
    turnoTimings: {},
    inicioReloj: ms(DIA, '09:00'),
    fin: cierreAdmin,
  })
  eq(soloReloj.minutos, 630, 'fallback de reloj de pared: 09:00 → 19:30 = 10h30')
  eq(soloReloj.fuente, 'reloj', 'la fuente queda declarada como reloj')
  ok(!soloReloj.confiable, 'el reloj de pared nunca se declara confiable')
  eq(soloReloj.motivo, 'sin_timings', 'y dice por qué')

  // 5d. `started_at` heredado de ayer (P1-5): el fallback se acota a 12h en
  //     vez de escribir ~24h.
  const heredado = duracionDeSesion({
    turnoTimings: {},
    inicioReloj: ms(AYER, '09:00'),
    fin: ms(DIA, '11:00'), // 26 horas
  })
  eq(heredado.minutos, SESION_MAX_MS / 60000, 'started_at de ayer se acota a 12h, no 26h')
  eq(heredado.motivo, 'reloj_recortado', 'y queda marcado como recortado')
}

// ── [6] Laptop cerrada 4 horas en el medio ────────────────────────────
// P1-6. Dos variantes que se comportan distinto y las dos son correctas.
console.log('[6] Laptop cerrada 4 horas en el medio')
{
  // 6a. La pausa cae ENTRE dos turnos: no cuenta nada. Es el caso normal
  //     (el hub hace la mañana, almuerza/se va, vuelve para la tarde).
  const entreturnos = {
    Mañana: { startedAt: iso(DIA, '09:00'), endedAt: iso(DIA, '09:40') },
    Tarde: { startedAt: iso(DIA, '13:40'), endedAt: iso(DIA, '14:15') },
  }
  const r1 = duracionDeSesion({ turnoTimings: entreturnos, fin: ms(DIA, '14:16') })
  eq(r1.minutos, 75, 'las 4h de pausa entre turnos NO se cuentan')
  ok(r1.confiable, 'y la medición sigue siendo confiable')
  // El reloj de pared habría dado 316 min para 75 min de trabajo.

  // 6b. La pausa cae DENTRO de un turno (cerró la laptop a mitad del corte
  //     de la mañana). Acá no hay forma de separar trabajo de pausa con los
  //     datos que existen: se acota al techo y se declara NO confiable, que
  //     es lo honesto — no se puede afirmar un número exacto.
  const dentro = { Mañana: { startedAt: iso(DIA, '09:00'), endedAt: iso(DIA, '15:30') } }
  const r2 = duracionDeSesion({ turnoTimings: dentro, fin: ms(DIA, '15:31') })
  eq(r2.minutos, TURNO_MAX_MS / 60000, 'un turno de 6h30 se acota a 4h')
  ok(!r2.confiable, 'y NO se presenta como dato confiable')
  eq(turnoBreakdownLabel(dentro), 'Mañana 240min*', 'el asterisco avisa que está recortado')
}

// ── [7] Turnos intercalados: unión, no suma ───────────────────────────
// Un hub puede saltar entre Mañana y Tarde. Sumar los tramos contaría dos
// veces el mismo minuto de pared.
console.log('[7] Turnos intercalados: se unen, no se suman')
{
  const solapados = {
    Mañana: { startedAt: iso(DIA, '09:00'), endedAt: iso(DIA, '10:00') },
    Tarde: { startedAt: iso(DIA, '09:30'), endedAt: iso(DIA, '10:30') },
  }
  const r = duracionDeSesion({ turnoTimings: solapados, fin: ms(DIA, '10:31') })
  eq(r.minutos, 90, '[09:00,10:00] ∪ [09:30,10:30] = 90 min, no 120')

  // Contiguos exactos: un solo tramo.
  eq(
    minutosUnidos([
      { inicio: 0, fin: 60000 },
      { inicio: 60000, fin: 120000 },
    ]),
    2,
    'tramos contiguos se fusionan'
  )
  // Disjuntos: se suman los dos.
  eq(
    minutosUnidos([
      { inicio: 0, fin: 60000 },
      { inicio: 600000, fin: 660000 },
    ]),
    2,
    'tramos disjuntos suman por separado'
  )
  // Uno contenido dentro del otro no agrega nada.
  eq(
    minutosUnidos([
      { inicio: 0, fin: 600000 },
      { inicio: 60000, fin: 120000 },
    ]),
    10,
    'un tramo contenido en otro no agrega minutos'
  )
  eq(minutosUnidos([]), 0, 'sin tramos, 0')
  eq(minutosUnidos(null), 0, 'null no rompe')
}

// ── [8] Corregir una sesión pasada ────────────────────────────────────
// "Abrir" desde el Historial reinicia el cronómetro a Date.now(): corregir
// una celda y Terminar escribía otra fila de 0.1 min. Ahora los timings
// vienen seedeados de la sesión original (nunca se sobreescriben), así que
// la fila nueva repite la duración REAL de aquel día en vez de un 0.1.
console.log('[8] Reabrir una sesión pasada para corregir una celda')
{
  const original = {
    Mañana: { startedAt: iso(AYER, '09:00'), endedAt: iso(AYER, '09:50') },
  }
  const r = duracionDeSesion({
    turnoTimings: original,
    inicioReloj: ms(DIA, '15:00'), // el reloj arrancó recién ahora
    fin: ms(DIA, '15:02'),
  })
  eq(r.minutos, 50, 'la corrección no escribe 0.1: repite la duración real del día')
  eq(r.inicio, ms(AYER, '09:00'), 'y el started_at apunta al trabajo original')
}

// ── [9] Datos corruptos o ausentes: nada puede romper el cierre ───────
console.log('[9] Entradas corruptas')
{
  eq(duracionDeSesion({}).fuente, 'desconocida', 'sin argumentos útiles → desconocida')
  eq(duracionDeSesion().minutos, null, 'sin argumentos no rompe')
  eq(tramosDeTurnos(null), [], 'timings null → sin tramos')
  eq(tramosDeTurnos('no soy un objeto'), [], 'timings no-objeto → sin tramos')
  eq(tramosDeTurnos({ Mañana: null }), [], 'un turno null se ignora')
  eq(tramosDeTurnos({ Mañana: { startedAt: 'basura' } }), [], 'startedAt no parseable se ignora')
  eq(
    tramosDeTurnos({ Mañana: {} }),
    [],
    'un turno sin startedAt no aparece (no es 0 min de trabajo)'
  )

  // endedAt anterior a startedAt (relojes de máquina desincronizados): se
  // descarta el endedAt y se cae al fin de sesión.
  const invertido = {
    Mañana: { startedAt: iso(DIA, '10:00'), endedAt: iso(DIA, '09:00') },
  }
  const r = duracionDeSesion({ turnoTimings: invertido, fin: ms(DIA, '10:30') })
  eq(r.minutos, 30, 'endedAt invertido cae al fin de sesión, nunca da negativo')
  ok(r.minutos >= 0, 'la duración nunca es negativa')

  // Un fin de sesión ANTERIOR al inicio del turno tampoco puede dar negativo.
  const anterior = duracionDeSesion({
    turnoTimings: { Mañana: { startedAt: iso(DIA, '10:00') } },
    fin: ms(DIA, '09:00'),
  })
  eq(anterior.minutos, null, 'un fin anterior al inicio no cierra el turno')

  // Formatos mixtos: el código real pasa Date, epoch ms e ISO string.
  eq(
    duracionDeSesion({
      turnoTimings: { M: { startedAt: ms(DIA, '09:00'), endedAt: new Date(iso(DIA, '09:30')) } },
      fin: iso(DIA, '09:31'),
    }).minutos,
    30,
    'acepta epoch ms, Date e ISO string indistintamente'
  )
}

// ── [10] El desglose visible y el total no pueden contradecirse ───────
// Antes cada uno hacía su cuenta por su lado: el hub podía ver
// "Mañana 40min · Tarde 35min" al lado de un total de "0.1 min".
console.log('[10] Desglose y total salen del mismo módulo')
{
  const timings = {
    Mañana: { startedAt: iso(DIA, '09:00'), endedAt: iso(DIA, '09:40') },
    Tarde: { startedAt: iso(DIA, '13:00'), endedAt: iso(DIA, '13:35') },
  }
  eq(turnoBreakdownLabel(timings), 'Mañana 40min · Tarde 35min', 'el desglose se lee igual')
  const total = duracionDeSesion({ turnoTimings: timings, fin: ms(DIA, '13:36') }).minutos
  const suma = minutosPorTurno(timings).reduce((a, t) => a + t.minutos, 0)
  eq(total, suma, 'sin solapamiento, total === suma del desglose visible')

  eq(turnoBreakdownLabel({ Noche: { startedAt: iso(DIA, '20:00') } }), 'Noche —', 'turno abierto → —')
  eq(turnoBreakdownLabel(null), '', 'null no rompe el desglose')
  eq(turnoBreakdownLabel({}), '', 'sin turnos, sin texto')
}

// ── [11] REGRESIÓN: el tramo de ancho cero ────────────────────────────
// Lo encontró la revisión adversarial y era un P0: el mismo síntoma (0 min)
// por un camino NUEVO, y peor que el original porque salía marcado como
// medición confiable.
//
// Origen: el efecto de estampado veía `filled` saltar de 0 a 100% en un solo
// update de estado y ponía `startedAt` y `endedAt` con el MISMO instante.
// Pasa en toda rehidratación masiva sin semilla de `turno_timings`: el hub
// usó "Guardar progreso" pero nunca "Terminar" (así que no hay fila en
// ci_sessions de dónde sembrar) y vuelve desde otra laptop, o tras un relevo,
// o con la caché limpia.
console.log('[11] Regresión: tramos de ancho cero no son una medición')
{
  const t = iso(DIA, '12:00')
  const envenenado = {
    Mañana: { startedAt: t, endedAt: t },
    Tarde: { startedAt: t, endedAt: t },
    Noche: { startedAt: t, endedAt: t },
  }
  const r = duracionDeSesion({ turnoTimings: envenenado, fin: ms(DIA, '12:10') })
  ok(r.minutos !== 0, 'un tramo de ancho cero NO puede dar un 0 con cara de dato')
  eq(r.minutos, null, 'sin reloj de respaldo queda en null (desconocida)')
  eq(r.fuente, 'desconocida', 'y NO se declara medido por turnos')
  ok(!r.confiable, 'y nunca confiable')

  // Con reloj de respaldo cae al fallback, marcado como no confiable — no a
  // un 0 con `fuente: 'turnos'`.
  const conReloj = duracionDeSesion({
    turnoTimings: envenenado,
    inicioReloj: ms(DIA, '11:30'),
    fin: ms(DIA, '12:10'),
  })
  eq(conReloj.minutos, 40, 'con reloj de respaldo mide 40 min de pared')
  eq(conReloj.fuente, 'reloj', 'declarado como reloj, no como turnos')
  ok(!conReloj.confiable, 'y no confiable')

  // Un tramo bueno convive con uno envenenado sin contaminarse.
  const mixto = {
    Mañana: { startedAt: iso(DIA, '09:00'), endedAt: iso(DIA, '09:45') },
    Tarde: { startedAt: t, endedAt: t },
  }
  eq(
    duracionDeSesion({ turnoTimings: mixto, fin: ms(DIA, '12:10') }).minutos,
    45,
    'el tramo bueno se mide y el de ancho cero se descarta'
  )

  // Un turno de 1 segundo SÍ es una medición (absurda, pero real): el filtro
  // es `> 0`, no un umbral arbitrario que se coma trabajo legítimo.
  eq(
    duracionDeSesion({
      turnoTimings: { M: { startedAt: iso(DIA, '09:00'), endedAt: iso(DIA, '09:00') } },
      fin: ms(DIA, '09:10'),
    }).minutos,
    null,
    'exactamente 0 ms se descarta'
  )
  eq(
    tramosDeTurnos({
      M: { startedAt: ms(DIA, '09:00'), endedAt: ms(DIA, '09:00') + 1000 },
    })[0].minutos,
    0,
    '1 segundo redondea a 0.0 min pero SÍ es un tramo medido'
  )
}

// ── Resultado ─────────────────────────────────────────────────────────
console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} pasaron, ${fail} fallaron`)
if (fail) console.error('Fallaron:\n  - ' + fallos.join('\n  - '))
process.exit(fail === 0 ? 0 : 1)
