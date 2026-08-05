// Aritmética del Gantt. Separada del componente por lo mismo que
// projectTasks.js: para poder testearla (scripts/test-gantt.mjs).
//
// El Gantt se dibuja con CSS grid, sin librería (PROYECTOS_DESIGN.md §11).
// Eso significa que toda la geometría es aritmética de fechas, y la aritmética
// de fechas es donde este módulo ya se equivocó una vez: el bug de "vence hoy"
// desfasado por zona horaria (§13.4). Por eso acá se sigue la MISMA regla de
// oro que en projectTasks.js — se trabaja con strings 'YYYY-MM-DD', nunca con
// objetos Date sueltos — y las funciones que tocan el reloj se reciben ya
// resueltas desde afuera.

// Con extensión explícita: los tests corren con `node` plano, sin el resolver
// de Vite, y sin el `.js` no encuentra el módulo.
import { addDays, daysBetween, isBusinessDay } from './projectTasks.js'

/**
 * Los tres niveles de zoom (§4.2).
 *
 * `dias`  — ancho de la ventana visible.
 * `atras` — cuántos días antes del lunes actual arranca. No es cero salvo en
 *           la semana: en una vista de trimestre, empezar hoy esconde todo lo
 *           que viene atrasado, que es justo lo que hay que mirar.
 * `paso`  — cuánto se corre con las flechas.
 * `tick`  — granularidad de la grilla de fondo.
 */
export const GANTT_ZOOMS = {
  week: { dias: 14, atras: 0, paso: 7, tick: 'day' },
  month: { dias: 35, atras: 7, paso: 14, tick: 'day' },
  quarter: { dias: 91, atras: 14, paso: 28, tick: 'week' },
}

/** Lunes de la semana de una fecha. */
export function startOfWeek(dateStr) {
  let d = dateStr
  // getUTCDay(): 0=domingo. Se retrocede hasta el lunes.
  while (new Date(`${d}T12:00:00Z`).getUTCDay() !== 1) d = addDays(d, -1)
  return d
}

/**
 * Ventana visible del Gantt.
 * `corrimiento` en pasos: -1 = un paso atrás, +1 = un paso adelante.
 */
export function ganttWindow(today, zoom = 'month', corrimiento = 0) {
  const z = GANTT_ZOOMS[zoom] || GANTT_ZOOMS.month
  const from = addDays(startOfWeek(today), -z.atras + corrimiento * z.paso)
  return {
    zoom: GANTT_ZOOMS[zoom] ? zoom : 'month',
    from,
    to: addDays(from, z.dias - 1),
    dias: z.dias,
    paso: z.paso,
    tick: z.tick,
  }
}

/**
 * Geometría de la barra de una tarea, en unidades de DÍA (no de píxel): el
 * componente las traduce a columnas de la grilla. Así el test no depende de
 * ningún ancho.
 *
 * Devuelve null si la tarea no tiene ninguna fecha. NO es un caso a ignorar:
 * una tarea sin fechas no se puede dibujar, y si el Gantt la omitiera sin más
 * desaparecería del radar en silencio — el patrón que §13.3 y CLAUDE.md §5
 * prohíben. El componente las lista aparte, siempre visibles.
 */
export function taskBar(task, win) {
  const inicio = task.start_date || task.due_date
  const fin = task.due_date || task.start_date
  if (!inicio || !fin) return null

  // Una tarea con las fechas al revés no debería existir (hay CHECK en la
  // tabla), pero si llegara, dibujarla al revés daría un span negativo y la
  // barra se comería la fila entera. Se normaliza.
  const desde = inicio <= fin ? inicio : fin
  const hasta = inicio <= fin ? fin : inicio

  if (hasta < win.from || desde > win.to) {
    return { visible: false, desde, hasta, antes: hasta < win.from }
  }

  const recorteIzq = desde < win.from
  const recorteDer = hasta > win.to
  const ci = recorteIzq ? win.from : desde
  const cf = recorteDer ? win.to : hasta

  return {
    visible: true,
    desde,
    hasta,
    offset: daysBetween(win.from, ci),
    span: daysBetween(ci, cf) + 1,
    recorteIzq,
    recorteDer,
    // Un solo día: la tarea tiene vencimiento pero no inicio. Se dibuja igual,
    // como un hito — omitirla sería esconderla.
    hito: desde === hasta,
  }
}

/** Un tick por día de la ventana, con lo que el fondo necesita saber. */
export function ganttTicks(win) {
  const out = []
  for (let i = 0; i < win.dias; i++) {
    const date = addDays(win.from, i)
    out.push({
      date,
      finDeSemana: !isBusinessDay(date),
      inicioDeMes: date.endsWith('-01'),
      // En trimestre la grilla marca semanas, no días: 91 líneas verticales
      // en una pantalla son ruido, no información.
      marca: win.tick === 'week' ? date === startOfWeek(date) : true,
    })
  }
  return out
}

/** Cabecera: un bloque por mes, con cuántas columnas ocupa. */
export function ganttMonths(win) {
  const out = []
  for (let i = 0; i < win.dias; i++) {
    const date = addDays(win.from, i)
    const key = date.slice(0, 7)
    const ultimo = out[out.length - 1]
    if (ultimo && ultimo.key === key) ultimo.span += 1
    else out.push({ key, span: 1 })
  }
  return out
}

/** Columna del día de hoy (1-based, como las columnas de CSS grid). null si cae fuera. */
export function todayColumn(win, today) {
  if (today < win.from || today > win.to) return null
  return daysBetween(win.from, today) + 1
}

/**
 * Fechas nuevas tras arrastrar una barra.
 *
 * `modo`: 'mover' corre las dos fechas; 'inicio' y 'fin' estiran un extremo.
 * Devuelve null si el arrastre no cambia nada o produce un rango inválido —
 * el llamador NO debe escribir en ese caso: un UPDATE que no cambia nada
 * dispararía igual el trigger de la mig 215 y ensuciaría la bitácora del hub
 * con "movió el vencimiento" que no movió nada.
 */
export function arrastrarBarra(task, modo, dias) {
  if (!dias) return null
  const inicio = task.start_date
  const fin = task.due_date

  if (modo === 'mover') {
    const patch = {}
    if (inicio) patch.start_date = addDays(inicio, dias)
    if (fin) patch.due_date = addDays(fin, dias)
    if (!inicio && !fin) return null
    // Correr las dos fechas juntas no puede invertir el rango, pero si la
    // tarea tenía solo una, la otra sigue null y tampoco hay nada que validar.
    return patch
  }

  if (modo === 'inicio') {
    if (!inicio) return null
    const nuevo = addDays(inicio, dias)
    if (fin && nuevo > fin) return null // estirar más allá del fin: se ignora
    return { start_date: nuevo }
  }

  if (modo === 'fin') {
    if (!fin) return null
    const nuevo = addDays(fin, dias)
    if (inicio && nuevo < inicio) return null
    return { due_date: nuevo }
  }

  return null
}
