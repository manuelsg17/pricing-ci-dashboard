#!/usr/bin/env node
// Tests de paginarTodo (src/lib/paginarTodo.js).
//
// POR QUÉ EXISTE
// PostgREST corta en 1000 filas y NO avisa: devuelve 1000 y un Content-Range
// que dice 1212. Medido en local con la consulta real de Proyectos — la app
// mostraba 1000 tareas de 1212 y ni el usuario ni el código tenían forma de
// notarlo. Es el truncado silencioso que CLAUDE.md §5 prohíbe.
//
// El helper no se puede probar contra PostgREST desde un test unitario, así
// que acá se le da un constructor de query FALSO que se comporta como él:
// devuelve páginas y un count total. Lo que se prueba es el algoritmo de
// paginación, que es donde estaba el riesgo.
//
// Run: node scripts/test-paginar-todo.mjs

import { paginarTodo } from '../src/lib/paginarTodo.js'

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

/** Simula PostgREST: sirve `total` filas en páginas de `maxRows` como mucho. */
function fakePostgrest(total, { maxRows = 1000 } = {}) {
  const llamadas = []
  const construir = async (desde, hasta, pedirTotal) => {
    llamadas.push({ desde, hasta, pedirTotal })
    const finPedido = Math.min(hasta, desde + maxRows - 1)
    const data = []
    for (let i = desde; i <= Math.min(finPedido, total - 1); i++) data.push({ id: i })
    return { data, error: null, count: pedirTotal ? total : null }
  }
  return { construir, llamadas }
}

{
  console.log('\n[1] Menos de una página: una sola llamada')
  const { construir, llamadas } = fakePostgrest(37)
  const r = await paginarTodo(construir)
  assert(r.filas.length === 37, 'devuelve las 37')
  assert(llamadas.length === 1, 'sin pedir páginas de más')
  assert(r.truncado === false, 'no marca truncado')
  assert(llamadas[0].pedirTotal === true, 'el count se pide UNA vez, en la primera página')
}

{
  console.log('\n[2] El caso que rompía: 1212 filas')
  const { construir, llamadas } = fakePostgrest(1212)
  const r = await paginarTodo(construir)
  // Sin paginar, esto daba 1000 y la app no se enteraba.
  assert(r.filas.length === 1212, 'devuelve las 1212, no 1000')
  assert(llamadas.length === 2, 'en dos páginas')
  assert(r.total === 1212, 'y reporta el total real')
  const ids = new Set(r.filas.map((x) => x.id))
  assert(ids.size === 1212, 'sin repetidas')
}

{
  console.log('\n[3] Justo en el borde')
  for (const n of [999, 1000, 1001, 2000, 2001]) {
    const { construir } = fakePostgrest(n)
    const r = await paginarTodo(construir)
    assert(r.filas.length === n, `${n} filas exactas`)
  }
}

{
  console.log('\n[4] Vacío')
  const { construir, llamadas } = fakePostgrest(0)
  const r = await paginarTodo(construir)
  assert(r.filas.length === 0 && r.total === 0, 'cero filas, cero total')
  assert(llamadas.length === 1, 'una sola llamada')
}

{
  console.log('\n[5] Un "Max Rows" del servidor MENOR que la página que pedimos')
  // Si el proyecto tuviera max-rows=500, cada página vendría corta. Cortar el
  // loop por "vino menos de lo que pedí" truncaría en 500 — por eso el corte
  // es por `total`, no por el largo de la página.
  const { construir } = fakePostgrest(1212, { maxRows: 500 })
  const r = await paginarTodo(construir)
  assert(r.filas.length === 1212, 'igual las trae todas')
}

{
  console.log('\n[6] El count miente (otra sesión borró filas mientras paginábamos)')
  let servidas = 0
  const construir = async (desde, hasta, pedirTotal) => {
    // Dice que hay 3000 pero solo entrega 1200: sin la salida por página
    // vacía, el loop giraría para siempre y colgaría la pestaña.
    const data = []
    for (let i = desde; i <= hasta && servidas < 1200; i++, servidas++) data.push({ id: i })
    return { data, error: null, count: pedirTotal ? 3000 : null }
  }
  const r = await paginarTodo(construir)
  assert(r.filas.length === 1200, 'corta con lo que hay en vez de colgarse')
}

{
  console.log('\n[7] Un error del servidor NO se traga')
  let v = 'sin lanzar'
  try {
    await paginarTodo(async () => ({ data: null, error: new Error('boom'), count: null }))
  } catch (e) {
    v = e.message
  }
  // Devolver [] ante un error diría "no hay nada" cuando en realidad no se
  // pudo saber — exactamente lo que este archivo viene a evitar.
  assert(v === 'boom', 'propaga el error en vez de devolver vacío')
}

console.log(`\nResultado: ${pass} pasados / ${fail} fallidos`)
if (fail > 0) {
  console.log('\nFallidos:')
  failures.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('Todo OK ✓')
