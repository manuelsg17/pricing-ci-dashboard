#!/usr/bin/env node
// Tests de la lógica pura del módulo de Proyectos (src/lib/projectTasks.js).
//
// Los casos no son genéricos: cada bloque corresponde a un problema concreto
// que apareció en las 4 rondas de simulación (PROYECTOS_DESIGN.md) y que este
// test existe para que no vuelva. El más importante es el [3]: el "problema
// del lunes", que habría hecho invisible todo el trabajo del viernes en la
// reunión más importante de la semana.
// Run: node scripts/test-project-tasks.mjs

import {
  todayInTimezone,
  addDays,
  daysBetween,
  isBusinessDay,
  previousBusinessDay,
  businessDaysBetween,
  activityWindow,
  taskUrgency,
  isAtRisk,
  isStalled,
  blockedDays,
  sortTasks,
  groupByUrgency,
  validateTaskDates,
  projectMatchesCity,
  taskMatchesCity,
} from '../src/lib/projectTasks.js'

let pass = 0,
  fail = 0,
  failures = []
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

console.log('\n══ projectTasks tests ══')

{
  console.log('\n[1] Aritmética de fechas inmune a la zona horaria')
  assert(addDays('2026-08-01', 1) === '2026-08-02', 'suma un día')
  assert(addDays('2026-08-01', -1) === '2026-07-31', 'cruza fin de mes hacia atrás')
  assert(addDays('2026-12-31', 1) === '2027-01-01', 'cruza fin de año')
  assert(addDays('2026-02-28', 1) === '2026-03-01', '2026 no es bisiesto')
  assert(daysBetween('2026-08-01', '2026-08-08') === 7, 'diferencia positiva')
  assert(daysBetween('2026-08-08', '2026-08-01') === -7, 'diferencia negativa')
  assert(daysBetween('2026-08-01', '2026-08-01') === 0, 'mismo día = 0')
  // El bug clásico: new Date('2026-03-29') en una zona con horario de verano
  // puede devolver el día anterior. Se parsea a mediodía UTC justamente por esto.
  assert(addDays('2026-03-29', 1) === '2026-03-30', 'cambio de horario no corre la fecha')
  assert(addDays('2026-10-25', 1) === '2026-10-26', 'el otro borde de DST tampoco')
}

{
  console.log('\n[2] Días hábiles')
  // 2026-08-03 es lunes.
  assert(isBusinessDay('2026-08-03') === true, 'lunes es hábil')
  assert(isBusinessDay('2026-08-07') === true, 'viernes es hábil')
  assert(isBusinessDay('2026-08-08') === false, 'sábado no')
  assert(isBusinessDay('2026-08-09') === false, 'domingo no')
  assert(businessDaysBetween('2026-08-03', '2026-08-07') === 4, 'lunes a viernes = 4')
  assert(businessDaysBetween('2026-08-07', '2026-08-10') === 1, 'viernes a lunes = 1 (salta finde)')
  assert(businessDaysBetween('2026-08-10', '2026-08-03') === 0, 'hacia atrás = 0')
}

{
  console.log('\n[3] EL PROBLEMA DEL LUNES — el hallazgo más grave de las simulaciones')
  // Con "ayer" literal, el lunes mira el domingo: TODO lo que los hubs
  // avanzaron el viernes queda invisible en la reunión del lunes. Y en
  // silencio, porque la pantalla diría "sin novedades", no "faltan datos".
  assert(previousBusinessDay('2026-08-03') === '2026-07-31', 'lunes → viernes, NO domingo')
  assert(previousBusinessDay('2026-08-04') === '2026-08-03', 'martes → lunes')
  assert(previousBusinessDay('2026-08-08') === '2026-08-07', 'sábado → viernes')
  assert(previousBusinessDay('2026-08-09') === '2026-08-07', 'domingo → viernes')

  const lunes = activityWindow('2026-08-03', 'auto')
  assert(lunes.fromDate === '2026-07-31', 'la ventana del lunes arranca el viernes')
  assert(lunes.days === 3, 'y cubre 3 días (viernes + finde)')

  const martes = activityWindow('2026-08-04', 'auto')
  assert(martes.days === 1, 'un martes normal cubre 1 día')

  // Volver de un feriado largo o de vacaciones: el preset amplía la ventana.
  assert(activityWindow('2026-08-04', '7d').fromDate === '2026-07-28', 'preset de 7 días')
  assert(activityWindow('2026-08-04', '24h').fromDate === '2026-08-03', 'preset de 24h')
}

{
  console.log('\n[4] Urgencia')
  const hoy = '2026-08-05'
  const t = (due, status = 'todo') => ({ due_date: due, status })
  assert(taskUrgency(t('2026-08-01'), hoy) === 'overdue', 'vencida')
  assert(taskUrgency(t('2026-08-05'), hoy) === 'today', 'vence hoy')
  assert(taskUrgency(t('2026-08-10'), hoy) === 'week', 'dentro de la semana')
  assert(taskUrgency(t('2026-09-01'), hoy) === 'later', 'más adelante')
  assert(taskUrgency(t(null), hoy) === 'none', 'sin fecha tiene su propia categoría')
  assert(taskUrgency(t('2026-08-01', 'done'), hoy) === 'done', 'lista nunca es vencida')
}

{
  console.log('\n[5] En riesgo (umbral configurable)')
  const hoy = '2026-08-05'
  const t = (due, status = 'todo') => ({ due_date: due, status })
  assert(isAtRisk(t('2026-08-06'), hoy) === true, 'vence mañana → en riesgo')
  assert(isAtRisk(t('2026-08-07'), hoy) === true, 'vence en 2 días → en riesgo')
  assert(isAtRisk(t('2026-08-08'), hoy) === false, 'vence en 3 días → todavía no')
  assert(isAtRisk(t('2026-08-01'), hoy) === false, 'ya vencida NO es "en riesgo" (es otra sección)')
  assert(isAtRisk(t('2026-08-06', 'done'), hoy) === false, 'lista nunca está en riesgo')
  assert(isAtRisk(t(null), hoy) === false, 'sin fecha no puede estar en riesgo')
  assert(isAtRisk(t('2026-08-10'), hoy, 7) === true, 'con umbral de 7 sí entra')
}

{
  console.log('\n[6] Tarea estancada (mal dimensionada, no hub lento)')
  const hoy = '2026-08-20'
  assert(
    isStalled({ status: 'doing' }, hoy, { since: '2026-08-05' }) === true,
    '11 días hábiles en curso → estancada'
  )
  assert(
    isStalled({ status: 'doing' }, hoy, { since: '2026-08-17' }) === false,
    '3 días en curso → normal'
  )
  assert(isStalled({ status: 'todo' }, hoy, { since: '2026-01-01' }) === false, 'solo aplica a "en curso"')
  assert(isStalled({ status: 'done' }, hoy, { since: '2026-01-01' }) === false, 'una lista no se estanca')
  assert(isStalled({ status: 'doing' }, hoy, {}) === false, 'sin fecha de referencia no inventa')
}

{
  console.log('\n[7] Antigüedad de una tarea trabada')
  const hoy = '2026-08-10'
  assert(blockedDays({ status: 'blocked' }, hoy, { since: '2026-08-05' }) === 5, 'trabada hace 5 días')
  assert(blockedDays({ status: 'blocked' }, hoy, { since: '2026-08-10' }) === 0, 'trabada hoy = 0')
  assert(blockedDays({ status: 'doing' }, hoy, { since: '2026-08-05' }) === null, 'no trabada → null')
}

{
  console.log('\n[8] Orden determinístico entre proyectos')
  // sort_order es POR proyecto: un hub con 3 proyectos tiene 3 secuencias que
  // arrancan en 0. Ordenar solo por ese campo mezcla arbitrariamente.
  const nombres = { p1: 'Alfa', p2: 'Beta' }
  const tareas = [
    { id: 'c', project_id: 'p2', due_date: '2026-08-05', sort_order: 0 },
    { id: 'a', project_id: 'p1', due_date: '2026-08-05', sort_order: 0 },
    { id: 'b', project_id: 'p1', due_date: '2026-08-05', sort_order: 1 },
    { id: 'd', project_id: 'p1', due_date: '2026-08-01', sort_order: 9 },
  ]
  const orden = sortTasks(tareas, nombres).map((t) => t.id)
  assert(orden[0] === 'd', 'la fecha manda por encima de todo')
  assert(orden.join('') === 'dabc', 'luego proyecto, luego sort_order: d,a,b,c')

  const sinFecha = sortTasks(
    [{ id: 'x', due_date: null, project_id: 'p1' }, { id: 'y', due_date: '2026-08-01', project_id: 'p1' }],
    nombres
  ).map((t) => t.id)
  assert(sinFecha.join('') === 'yx', 'las sin fecha van al final, no al principio')
}

{
  console.log('\n[9] Agrupación: nada desaparece por omisión')
  const hoy = '2026-08-05'
  const tareas = [
    { id: '1', due_date: '2026-08-01', status: 'todo' },
    { id: '2', due_date: '2026-08-05', status: 'doing' },
    { id: '3', due_date: '2026-08-09', status: 'todo' },
    { id: '4', due_date: '2026-09-01', status: 'todo' },
    { id: '5', due_date: null, status: 'todo' },
    { id: '6', due_date: '2026-08-04', status: 'done', updated_at: '2026-08-05T10:00:00Z' },
    { id: '7', due_date: '2026-08-02', status: 'done', updated_at: '2026-08-02T10:00:00Z' },
  ]
  const g = groupByUrgency(tareas, hoy)
  assert(g.overdue.length === 1, '1 vencida')
  assert(g.today.length === 1, '1 vence hoy')
  assert(g.week.length === 1, '1 esta semana')
  assert(g.later.length === 1, '1 más adelante')
  assert(g.none.length === 1, '1 sin fecha — con su propia sección, no escondida')
  assert(g.doneToday.length === 1, 'la completada HOY sigue visible')
  assert(g.doneToday[0].id === '6', 'y es la correcta')
  assert(
    Object.keys(g).every((k) => Array.isArray(g[k])),
    'todas las claves existen aunque estén vacías'
  )
}

{
  console.log('\n[10] Validación de fechas: avisar, no prohibir')
  const hoy = '2026-08-05'
  assert(validateTaskDates('2026-08-10', '2026-08-01', hoy).valid === false, 'fin antes que inicio se rechaza')
  assert(
    validateTaskDates('2026-08-01', '2026-08-10', hoy).valid === true,
    'orden correcto se acepta'
  )
  const nacida = validateTaskDates(null, '2026-08-01', hoy)
  assert(nacida.valid === true, 'una tarea que nace vencida SE PERMITE')
  assert(nacida.warning === 'born_overdue', 'pero avisa')
  assert(validateTaskDates(null, null, hoy).valid === true, 'sin fechas es válido')
}

{
  console.log('\n[11] Filtro por ciudad — el bug que rompía multi-ciudad')
  // Con `city NULL = multi`, filtrar por Arequipa hacía DESAPARECER los
  // proyectos multi-ciudad: los más importantes se volvían invisibles.
  const multi = { cities: [] }
  const dos = { cities: ['Lima', 'Arequipa'] }
  const uno = { cities: ['Lima'] }
  assert(projectMatchesCity(multi, 'Arequipa') === true, 'alcance total matchea cualquier ciudad')
  assert(projectMatchesCity(dos, 'Arequipa') === true, 'proyecto de 2 ciudades matchea una')
  assert(projectMatchesCity(uno, 'Arequipa') === false, 'proyecto de Lima no matchea Arequipa')
  assert(projectMatchesCity(uno, null) === true, 'sin filtro, todo matchea')

  assert(taskMatchesCity({ city: 'Arequipa' }, uno, 'Arequipa') === true, 'la ciudad de la TAREA manda')
  assert(taskMatchesCity({ city: 'Lima' }, dos, 'Arequipa') === false, 'tarea de Lima no entra en Arequipa')
  assert(taskMatchesCity({ city: null }, dos, 'Arequipa') === true, 'sin ciudad propia hereda el proyecto')
}

{
  console.log('\n[12] "Hoy" en la zona horaria del país')
  // 2026-08-06 01:30 UTC = todavía 5 de agosto en Lima (UTC-5).
  const t = new Date('2026-08-06T01:30:00Z')
  assert(todayInTimezone('America/Lima', t) === '2026-08-05', 'Lima va un día atrás a esa hora')
  assert(todayInTimezone('UTC', t) === '2026-08-06', 'UTC ya pasó de día')
  assert(todayInTimezone('Asia/Kathmandu', t) === '2026-08-06', 'Nepal (UTC+5:45) también')
  assert(todayInTimezone('Zona/Inventada', t) === '2026-08-06', 'zona inválida cae a UTC sin romper')
}

console.log(`\nResultado: ${pass} pasados / ${fail} fallidos`)
if (fail > 0) {
  console.log('\nFallidos:')
  failures.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('Todo OK ✓')
