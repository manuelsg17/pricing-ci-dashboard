#!/usr/bin/env node
// Tests de la aritmética del Gantt (src/lib/gantt.js).
//
// El Gantt se dibuja con CSS grid y aritmética de fechas, sin librería. O sea
// que si esta aritmética se equivoca, no hay nada que la ataje: la barra queda
// en el día que no es y nadie lo nota, porque una barra siempre "se ve bien".
// Es el mismo riesgo que ya se materializó en este módulo con "vence hoy"
// desfasado por zona horaria (PROYECTOS_DESIGN.md §13.4).
//
// Run: node scripts/test-gantt.mjs

import {
  GANTT_ZOOMS,
  startOfWeek,
  ganttWindow,
  taskBar,
  ganttTicks,
  ganttMonths,
  todayColumn,
  arrastrarBarra,
} from '../src/lib/gantt.js'

let pass = 0,
  fail = 0
const failures = []
function assert(cond, label) {
  if (cond) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    failures.push(label)
    console.log(`  ✗ ${label}`)
  }
}

{
  console.log('\n[1] Lunes de la semana')
  // 2026-08-04 es martes.
  assert(startOfWeek('2026-08-04') === '2026-08-03', 'un martes devuelve el lunes')
  assert(startOfWeek('2026-08-03') === '2026-08-03', 'un lunes se devuelve a sí mismo')
  assert(startOfWeek('2026-08-09') === '2026-08-03', 'un domingo devuelve el lunes ANTERIOR')
  // Cruzando el cambio de mes: el lunes está en julio.
  assert(startOfWeek('2026-08-01') === '2026-07-27', 'cruza el cambio de mes')
}

{
  console.log('\n[2] Ventana por zoom')
  const semana = ganttWindow('2026-08-04', 'week')
  assert(semana.from === '2026-08-03' && semana.to === '2026-08-16', 'semana: 14 días desde el lunes')

  const mes = ganttWindow('2026-08-04', 'month')
  // atras=7: una semana antes, para que lo atrasado siga visible.
  assert(mes.from === '2026-07-27' && mes.dias === 35, 'mes: arranca una semana antes')
  assert(mes.to === '2026-08-30', 'mes: 35 días de ancho')

  const trim = ganttWindow('2026-08-04', 'quarter')
  assert(trim.from === '2026-07-20' && trim.dias === 91, 'trimestre: dos semanas antes, 91 días')

  // Un zoom inventado no puede romper la pantalla.
  const raro = ganttWindow('2026-08-04', 'siglo')
  assert(raro.zoom === 'month' && raro.dias === 35, 'zoom desconocido cae a mes')

  const antes = ganttWindow('2026-08-04', 'month', -1)
  assert(antes.from === '2026-07-13', 'un paso atrás corre 14 días')
  const despues = ganttWindow('2026-08-04', 'month', 2)
  assert(despues.from === '2026-08-24', 'dos pasos adelante corren 28')
}

{
  console.log('\n[3] Geometría de la barra')
  const win = ganttWindow('2026-08-04', 'week') // 2026-08-03 .. 2026-08-16

  const normal = taskBar({ start_date: '2026-08-05', due_date: '2026-08-07' }, win)
  assert(normal.offset === 2 && normal.span === 3, 'del 5 al 7: offset 2, 3 días de ancho')
  assert(normal.recorteIzq === false && normal.recorteDer === false, 'entera dentro de la ventana')

  // El span es INCLUSIVO: una tarea que empieza y termina el mismo día ocupa
  // un día, no cero. Con la resta pelada la barra desaparecería.
  const unDia = taskBar({ start_date: '2026-08-05', due_date: '2026-08-05' }, win)
  assert(unDia.span === 1 && unDia.hito === true, 'mismo día = 1 columna, marcada como hito')

  // Solo vencimiento: se dibuja igual, como hito. Omitirla sería esconderla.
  const soloFin = taskBar({ due_date: '2026-08-10' }, win)
  assert(soloFin.span === 1 && soloFin.offset === 7, 'solo vencimiento se dibuja como hito')
  const soloInicio = taskBar({ start_date: '2026-08-10' }, win)
  assert(soloInicio.span === 1, 'solo inicio también')

  // Sin ninguna fecha NO se dibuja — y el null es la señal de que hay que
  // listarla aparte, no de que se pueda tirar.
  assert(taskBar({}, win) === null, 'sin fechas devuelve null')

  console.log('\n[4] Recortes en los bordes')
  const cortadaIzq = taskBar({ start_date: '2026-07-20', due_date: '2026-08-05' }, win)
  assert(cortadaIzq.offset === 0 && cortadaIzq.recorteIzq === true, 'empieza antes: se recorta a la izquierda')
  assert(cortadaIzq.span === 3, 'y ocupa solo lo visible (3, 4 y 5)')

  const cortadaDer = taskBar({ start_date: '2026-08-14', due_date: '2026-09-30' }, win)
  assert(cortadaDer.recorteDer === true && cortadaDer.span === 3, 'termina después: se recorta a la derecha')

  const abarca = taskBar({ start_date: '2026-01-01', due_date: '2026-12-31' }, win)
  assert(abarca.offset === 0 && abarca.span === 14, 'una tarea que abarca toda la ventana la llena')

  const fuera = taskBar({ start_date: '2026-06-01', due_date: '2026-06-05' }, win)
  assert(fuera.visible === false && fuera.antes === true, 'fuera de la ventana, y se sabe de qué lado')
  const futura = taskBar({ start_date: '2027-01-01', due_date: '2027-01-05' }, win)
  assert(futura.visible === false && futura.antes === false, 'la del futuro también')

  // Fechas invertidas: la tabla tiene un CHECK, pero si una llegara igual, un
  // span negativo se comería la fila entera.
  const alReves = taskBar({ start_date: '2026-08-10', due_date: '2026-08-06' }, win)
  assert(alReves.span === 5 && alReves.offset === 3, 'fechas invertidas se normalizan, no rompen')
}

{
  console.log('\n[5] Grilla de fondo y cabecera')
  const win = ganttWindow('2026-08-04', 'week')
  const ticks = ganttTicks(win)
  assert(ticks.length === 14, 'un tick por día')
  assert(ticks[0].date === '2026-08-03' && ticks[13].date === '2026-08-16', 'del lunes al domingo siguiente')
  assert(ticks.filter((x) => x.finDeSemana).length === 4, '2 semanas = 4 días de fin de semana')

  const trim = ganttWindow('2026-08-04', 'quarter')
  const marcados = ganttTicks(trim).filter((x) => x.marca)
  assert(marcados.length === 13, 'en trimestre la grilla marca semanas (13), no 91 días')

  // Cabecera de meses: la ventana de mes arranca el 27 de julio.
  const meses = ganttMonths(ganttWindow('2026-08-04', 'month'))
  assert(meses.length === 2, 'julio y agosto')
  assert(meses[0].key === '2026-07' && meses[0].span === 5, 'julio ocupa 5 columnas (27 al 31)')
  assert(meses[1].key === '2026-08' && meses[1].span === 30, 'agosto las 30 restantes')
  assert(
    meses.reduce((n, m) => n + m.span, 0) === 35,
    'los bloques suman exactamente el ancho de la ventana'
  )
}

{
  console.log('\n[6] Línea de hoy')
  const win = ganttWindow('2026-08-04', 'week') // arranca el lunes 3
  assert(todayColumn(win, '2026-08-04') === 2, 'martes = segunda columna (1-based, como CSS grid)')
  assert(todayColumn(win, '2026-08-03') === 1, 'el primer día es la columna 1, no la 0')
  assert(todayColumn(win, '2026-07-01') === null, 'fuera de la ventana no se dibuja')
  assert(todayColumn(win, '2026-09-01') === null, 'ni por el otro lado')
}

{
  console.log('\n[7] Arrastre')
  const t = { start_date: '2026-08-05', due_date: '2026-08-10' }

  const movida = arrastrarBarra(t, 'mover', 3)
  assert(
    movida.start_date === '2026-08-08' && movida.due_date === '2026-08-13',
    'mover corre las DOS fechas la misma cantidad'
  )
  const atras = arrastrarBarra(t, 'mover', -2)
  assert(atras.start_date === '2026-08-03' && atras.due_date === '2026-08-08', 'y también hacia atrás')

  assert(arrastrarBarra(t, 'fin', 4).due_date === '2026-08-14', 'estirar el borde derecho mueve el fin')
  assert(arrastrarBarra(t, 'inicio', -1).start_date === '2026-08-04', 'el izquierdo mueve el inicio')
  assert(arrastrarBarra(t, 'fin', 4).start_date === undefined, 'estirar un borde NO toca el otro')

  // Cruzar los extremos se ignora en vez de escribir un rango inválido que el
  // CHECK de la tabla rechazaría con un error crudo en la cara del usuario.
  assert(arrastrarBarra(t, 'fin', -10) === null, 'no se puede llevar el fin antes del inicio')
  assert(arrastrarBarra(t, 'inicio', 10) === null, 'ni el inicio después del fin')

  // Un arrastre de cero días no puede escribir: el trigger de la mig 215
  // dispararía igual y dejaría un "movió el vencimiento" que no movió nada.
  assert(arrastrarBarra(t, 'mover', 0) === null, 'arrastre de 0 días no escribe')

  const soloFin = { due_date: '2026-08-10' }
  assert(arrastrarBarra(soloFin, 'mover', 2).due_date === '2026-08-12', 'con solo vencimiento, mover lo mueve')
  assert(
    arrastrarBarra(soloFin, 'mover', 2).start_date === undefined,
    'y no le inventa una fecha de inicio'
  )
  assert(arrastrarBarra(soloFin, 'inicio', 2) === null, 'no se puede estirar un borde que no existe')
  assert(arrastrarBarra({}, 'mover', 5) === null, 'una tarea sin fechas no se arrastra')

  assert(arrastrarBarra(t, 'inventado', 3) === null, 'un modo desconocido no escribe nada')
}

{
  console.log('\n[8] Los zooms declarados son coherentes')
  for (const [nombre, z] of Object.entries(GANTT_ZOOMS)) {
    assert(z.dias > 0 && z.paso > 0 && z.atras >= 0, `${nombre}: valores positivos`)
    assert(z.paso <= z.dias, `${nombre}: un paso no salta más de una ventana entera`)
  }
}

console.log(`\nResultado: ${pass} pasados / ${fail} fallidos`)
if (fail > 0) {
  console.log('\nFallidos:')
  failures.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('Todo OK ✓')
