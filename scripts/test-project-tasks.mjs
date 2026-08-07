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
  fechaLocalDe,
  validateTaskDates,
  projectMatchesCity,
  taskMatchesCity,
  applyTaskFilters,
  EMPTY_TASK_FILTERS,
  UNASSIGNED,
  nombreCorto,
  fechaCorta,
  ciudadesReales,
  resumenDesplazamiento,
  nombreDeCopia,
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

// ── La tarea que desaparecía al final de la jornada ───────────────────
// BUG REAL (2026-08-04): `updated_at` llega de PostgREST en UTC y se comparaba
// con `slice(0,10)` contra un "hoy" calculado en la zona del país. A las 19:00
// de Lima ya es el día siguiente en UTC → no matcheaba → y como la rama de
// `done` hace `continue`, la tarea se iba de "Mis tareas" ENTERA, no solo de
// "Completadas hoy". Justo cuando el hub cierra el día y mira lo que hizo.
console.log('\n[N] Completadas hoy: la zona horaria del país, no la del servidor')
{
  const LIMA = 'America/Lima'
  // 19:30 de Lima del 4 de agosto = 00:30 UTC del 5. El caso exacto.
  const tardeEnLima = [
    { id: 'x', status: 'done', updated_at: '2026-08-05T00:30:00.000Z', due_date: null },
  ]
  const g1 = groupByUrgency(tardeEnLima, '2026-08-04', {}, LIMA)
  assert(g1.doneToday.length === 1,
    'marcada Lista a las 19:30 de Lima SIGUE visible en "Completadas hoy"')

  // Y lo que importa de verdad: que no se pierda de la pantalla.
  const visibles = Object.values(g1).reduce((n, arr) => n + arr.length, 0)
  assert(visibles === 1, 'y no desaparece de "Mis tareas" (era 0 antes del fix)')

  // Contraste: la MISMA hora UTC evaluada en UTC sí caía fuera — es la prueba
  // de que el parámetro es lo que cambia el resultado, no otra cosa.
  const gUtc = groupByUrgency(tardeEnLima, '2026-08-04', {}, 'UTC')
  assert(gUtc.doneToday.length === 0,
    'en UTC esa misma tarea cae al día siguiente (así se veía el bug)')

  // Lo de ayer no debe colarse en "hoy".
  const ayer = [{ id: 'y', status: 'done', updated_at: '2026-08-03T15:00:00.000Z', due_date: null }]
  assert(groupByUrgency(ayer, '2026-08-04', {}, LIMA).doneToday.length === 0,
    'una completada ayer NO aparece en "Completadas hoy"')

  // Nepal (UTC+5:45) rompe por el otro lado: de madrugada, UTC va ATRASADO.
  const madrugadaNepal = [
    { id: 'z', status: 'done', updated_at: '2026-08-03T22:00:00.000Z', due_date: null },
  ]
  assert(groupByUrgency(madrugadaNepal, '2026-08-04', {}, 'Asia/Kathmandu').doneToday.length === 1,
    'Nepal a las 03:45 locales: la completada de hoy también se ve')

  // Sin zona: comportamiento viejo, para no romper un llamador que no la pase.
  assert(fechaLocalDe('2026-08-05T00:30:00.000Z', null) === '2026-08-05',
    'sin zona cae al string UTC (no inventa una zona)')
  assert(fechaLocalDe(null, LIMA) === null, 'un updated_at nulo no rompe')
  assert(fechaLocalDe('no-es-fecha', LIMA) === null, 'una fecha corrupta no rompe')
}
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

{
  console.log('\n[13] Barra de filtros — las 4 vistas tienen que filtrar igual')
  const projectById = {
    p1: { id: 'p1', cities: ['Lima'] },
    p2: { id: 'p2', cities: [] }, // alcance total del país
  }
  const tareas = [
    { id: 'a', project_id: 'p1', owner_email: 'ana@x', status: 'doing', city: null },
    { id: 'b', project_id: 'p1', owner_email: 'beto@x', status: 'done', city: 'Arequipa' },
    { id: 'c', project_id: 'p2', owner_email: null, status: 'todo', city: null },
    { id: 'd', project_id: 'p2', owner_email: 'ana@x', status: 'blocked', city: 'Lima' },
  ]
  const ids = (f) =>
    applyTaskFilters(tareas, f, projectById)
      .map((x) => x.id)
      .join(',')

  assert(applyTaskFilters(tareas, EMPTY_TASK_FILTERS, projectById) === tareas,
    'sin filtros devuelve el MISMO array — identidad estable para los efectos')
  assert(ids({ projectId: 'p1' }) === 'a,b', 'filtra por proyecto')
  assert(ids({ owner: 'ana@x' }) === 'a,d', 'filtra por responsable')
  assert(ids({ status: 'done' }) === 'b', 'filtra por estado')

  // El centinela: sin él, "sin asignar" caía en la rama de "sin filtro" y
  // devolvía las 4 — justo lo contrario de lo que se buscaba.
  assert(ids({ owner: UNASSIGNED }) === 'c', 'sin asignar encuentra las huérfanas')

  // Ciudad: la de la tarea manda, y si no tiene hereda el alcance del proyecto.
  assert(ids({ city: 'Lima' }) === 'a,c,d', 'Lima: a hereda p1, c hereda alcance total, d es de Lima')
  assert(ids({ city: 'Arequipa' }) === 'b,c', 'Arequipa: b es suya, c hereda alcance total')

  assert(ids({ projectId: 'p2', owner: 'ana@x' }) === 'd', 'los filtros se combinan con AND')
  assert(ids({ projectId: 'p1', status: 'blocked' }) === '', 'combinación sin resultados da vacío')
}

{
  console.log('\n[14] Cómo se leen personas y fechas en pantalla')
  // En producción los emails son largos y el dominio se repite en cada fila.
  assert(nombreCorto('raisalopez@yandex-team.ru') === 'raisalopez', 'saca el dominio')
  assert(nombreCorto('masantillanag@yango-team.com') === 'masantillanag', 'y del otro dominio')
  assert(nombreCorto('') === '', 'vacío no rompe')
  assert(nombreCorto(null) === '', 'null tampoco')
  // Un valor sin @ se devuelve tal cual en vez de quedar vacío: perder el
  // texto sería peor que mostrarlo raro.
  assert(nombreCorto('sin-arroba') === 'sin-arroba', 'sin @ se muestra igual')

  // Mismo año que la referencia: sin año, que solo sería ruido repetido.
  assert(fechaCorta('2026-08-06', 'es', '2026-08-05') === '6 ago', 'día y mes corto')
  // Otro año: el año SÍ aparece, o una tarea del año que viene se leería como
  // si fuera de este.
  assert(/2027/.test(fechaCorta('2027-01-15', 'es', '2026-08-05')), 'otro año lo dice')
  assert(fechaCorta('', 'es') === '', 'vacío da vacío')
  assert(fechaCorta(null, 'es') === '', 'null da vacío')
  assert(fechaCorta('no-es-fecha', 'es') === 'no-es-fecha', 'basura se devuelve tal cual')
  // Un locale inválido en country_config no puede romper la pantalla.
  assert(fechaCorta('2026-08-06', 'xx-YY-zz', '2026-08-05') === '2026-08-06', 'locale inválido cae al ISO')
}

{
  console.log('\n[15] Ciudades reales vs buckets de carga de CI')
  // Datos calcados de producción (country_config de Perú).
  const peru = [
    'Lima', 'Trujillo', 'Arequipa',
    'Lima_Airport_A', 'Lima_Airport_B',
    'Trujillo_Airport_A', 'Trujillo_Airport_B',
    'Arequipa_Airport_A', 'Arequipa_Airport_B',
    'Corp',
  ]
  const catsPeru = {
    Lima: ['Economy/Comfort', 'Comfort+', 'Premier', 'XL', 'TukTuk'],
    Trujillo: ['Economy/Comfort', 'Comfort+', 'XL'],
    Arequipa: ['Economy/Comfort', 'Comfort+', 'XL'],
    Lima_Airport_A: ['Economy/Comfort', 'Comfort+', 'Premier', 'XL'],
    Lima_Airport_B: ['Economy/Comfort', 'Comfort+', 'Premier', 'XL'],
    Trujillo_Airport_A: ['Economy/Comfort', 'Viaje+', 'Comfort+', 'XL'],
    Trujillo_Airport_B: ['Economy/Comfort', 'Viaje+', 'Comfort+', 'XL'],
    Arequipa_Airport_A: ['Economy/Comfort', 'Económico+', 'Comfort+', 'XL'],
    Arequipa_Airport_B: ['Economy/Comfort', 'Económico+', 'Comfort+', 'XL'],
    Corp: ['Corp'],
  }
  const reales = ciudadesReales(peru, catsPeru)
  assert(reales.join(',') === 'Lima,Trujillo,Arequipa', 'Perú: quedan las 3 ciudades de verdad')
  assert(!reales.includes('Corp'), 'Corp es un bucket, no una ciudad')
  assert(reales.every((c) => !c.includes('_Airport_')), 'ningún bucket de aeropuerto sobrevive')

  // Colombia NO tiene buckets: la regla no puede sacarle nada.
  const colombia = ['Bogotá', 'Cali', 'Barranquilla']
  const catsCo = {
    'Bogotá': ['Economy', 'Bike', 'Comfort'],
    Cali: ['Economy', 'Bike', 'Comfort'],
    Barranquilla: ['Economy', 'Bike', 'Comfort'],
  }
  assert(ciudadesReales(colombia, catsCo).length === 3, 'Colombia queda intacta')

  // Falla abierto: sin información de categorías no se esconde nada salvo lo
  // que el propio nombre delata. Esconder una ciudad legítima sería peor que
  // dejar una opción de más.
  assert(ciudadesReales(['Kathmandu'], {}).join(',') === 'Kathmandu', 'sin categorías no esconde')
  assert(ciudadesReales([], {}).length === 0, 'lista vacía no rompe')
  // Una ciudad con guion bajo que NO deriva de otra ciudad se conserva.
  assert(
    ciudadesReales(['Santa_Cruz', 'Lima'], {}).includes('Santa_Cruz'),
    'un guion bajo no basta: hace falta que la raíz sea otra ciudad'
  )
}

// ─────────────────────────────────────────────────────────────────────
// [12] Correr fechas en lote (§15.8) — la vista previa antes de apretar
// ─────────────────────────────────────────────────────────────────────
{
  console.log('\n[12] resumenDesplazamiento: qué se mueve y qué no')

  const sel = [
    { start_date: '2026-08-03', due_date: '2026-08-07' },
    { start_date: null, due_date: '2026-08-20' },
    { start_date: '2026-08-10', due_date: null },
    { start_date: null, due_date: null }, // sin fechas: no se mueve
  ]

  const r = resumenDesplazamiento(sel, 7)
  assert(r.total === 4, 'cuenta todas las seleccionadas')
  assert(r.conFecha === 3, 'tres tienen al menos una fecha')
  assert(r.sinFecha === 1, 'la que no tiene fechas se cuenta aparte, no se esconde')
  assert(r.desde === '2026-08-03' && r.hasta === '2026-08-20', 'el rango actual sale de las dos puntas')
  assert(r.nuevoDesde === '2026-08-10' && r.nuevoHasta === '2026-08-27', 'ambas puntas se mueven +7')

  // La duración total NO cambia: es una traslación. Si esto se rompiera, el
  // CHECK `due >= start` de la mig 183 podría violarse en el servidor.
  assert(
    daysBetween(r.desde, r.hasta) === daysBetween(r.nuevoDesde, r.nuevoHasta),
    'correr fechas no estira ni encoge el plan'
  )

  const atras = resumenDesplazamiento(sel, -3)
  assert(atras.nuevoDesde === '2026-07-31', 'hacia atrás cruza el cambio de mes')

  // Cruce de año bisiesto: 2028 lo es, así que +1 día sobre el 28/2 da 29.
  assert(
    resumenDesplazamiento([{ start_date: '2028-02-28', due_date: '2028-02-28' }], 1).nuevoDesde ===
      '2028-02-29',
    'año bisiesto: 28/2/2028 + 1 = 29/2'
  )

  // Nada seleccionado, o todo sin fechas: no hay rango que mostrar y no
  // rompe. El componente usa esto para deshabilitar el botón.
  const vacio = resumenDesplazamiento([], 7)
  assert(vacio.desde === null && vacio.total === 0, 'lista vacía no rompe')
  const soloSinFecha = resumenDesplazamiento([{ start_date: null, due_date: null }], 7)
  assert(soloSinFecha.conFecha === 0 && soloSinFecha.desde === null, 'todas sin fecha: no hay nada que mover')

  // Correr 0 días es un no-op y tiene que verse como tal.
  const cero = resumenDesplazamiento(sel, 0)
  assert(cero.nuevoDesde === cero.desde && cero.nuevoHasta === cero.hasta, '0 días no mueve nada')
}

// ─────────────────────────────────────────────────────────────────────
// [13] Duplicar proyecto (§15.6) — el nombre de la copia
// ─────────────────────────────────────────────────────────────────────
{
  console.log('\n[13] nombreDeCopia: dos proyectos activos no pueden llamarse igual')

  assert(nombreDeCopia('Onboarding TukTuk', []) === 'Onboarding TukTuk (copia)', 'primera copia')
  assert(
    nombreDeCopia('Onboarding TukTuk', ['Onboarding TukTuk', 'Onboarding TukTuk (copia)']) ===
      'Onboarding TukTuk (copia 2)',
    'si ya hay una copia, numera'
  )
  assert(
    nombreDeCopia('X', ['X (copia)', 'X (copia 2)', 'X (copia 3)']) === 'X (copia 4)',
    'sigue numerando hasta encontrar un hueco'
  )
  // Comparación sin distinguir mayúsculas: "X (Copia)" y "X (copia)" se leen
  // igual en una lista y elegir mal es el mismo error.
  assert(nombreDeCopia('X', ['X (COPIA)']) === 'X (copia 2)', 'no distingue mayúsculas')
  assert(nombreDeCopia('', []) === 'Proyecto (copia)', 'nombre vacío no genera " (copia)"')
  assert(nombreDeCopia('   ', []) === 'Proyecto (copia)', 'solo espacios tampoco')

  // El alta limita el nombre a 120: la copia no puede pasarse o Postgres
  // rebota el INSERT por haber apretado "Duplicar".
  const largo = 'A'.repeat(130)
  assert(nombreDeCopia(largo, []).length <= 120, 'un nombre largo se recorta, no explota')
}

console.log(`\nResultado: ${pass} pasados / ${fail} fallidos`)
if (fail > 0) {
  console.log('\nFallidos:')
  failures.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('Todo OK ✓')
