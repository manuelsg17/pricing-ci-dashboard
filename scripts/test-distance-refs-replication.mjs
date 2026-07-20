#!/usr/bin/env node
// Tests para src/lib/distanceRefsReplication.js — cascada "fill-if-missing"
// de Distancias de Referencia (Economy/Comfort → categorías hermanas +
// ciudad "_Airport_B" pareja, invertida).
//
// Run: node scripts/test-distance-refs-replication.mjs

import {
  REPLICATION_EXCLUDED_CATEGORIES,
  getSourceCategory,
  getSiblingCategories,
  hasRouteData,
  buildSiblingPayload,
  buildMirroredBPayload,
  applyFillIfMissingCascade,
} from '../src/lib/distanceRefsReplication.js'

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

console.log('\n══ Distance refs replication tests ══')

const LIMA_CATS = ['Economy/Comfort', 'Comfort+', 'Premier', 'XL', 'TukTuk', 'Corp']

{
  console.log('\n[1] getSourceCategory / getSiblingCategories')
  assert(getSourceCategory(LIMA_CATS) === 'Economy/Comfort', 'fuente = primera categoría de la ciudad')
  assert(getSourceCategory([]) === null, 'ciudad sin categorías → null')
  const siblings = getSiblingCategories(LIMA_CATS, 'Economy/Comfort')
  assert(
    JSON.stringify(siblings) === JSON.stringify(['Comfort+', 'Premier', 'XL']),
    `hermanas excluyen fuente + TukTuk/Corp: ${siblings.join(', ')}`
  )
  assert(REPLICATION_EXCLUDED_CATEGORIES.includes('TukTuk'), 'TukTuk está excluido')
  assert(REPLICATION_EXCLUDED_CATEGORIES.includes('Corp'), 'Corp está excluido')
}

{
  console.log('\n[2] hasRouteData')
  assert(hasRouteData({ point_a: 'Plaza Mayor', point_b: '' }) === true, 'point_a solo cuenta como dato')
  assert(hasRouteData({ point_a: '', point_b: 'Aeropuerto' }) === true, 'point_b solo cuenta como dato')
  assert(hasRouteData({ point_a: '', point_b: '' }) === false, 'ambos vacíos → sin dato')
  assert(hasRouteData({ point_a: '   ', point_b: null }) === false, 'solo espacios → sin dato')
  assert(hasRouteData(null) === false, 'fila null → sin dato')
}

{
  console.log('\n[3] buildSiblingPayload — copia bracket/puntos/coords/distancia, cambia category')
  const source = {
    bracket: 'short',
    point_a: 'Plaza Mayor',
    coordinate_a: '-12.05,-77.03',
    point_b: 'Miraflores',
    coordinate_b: '-12.12,-77.02',
    waze_distance: 5.2,
  }
  const payload = buildSiblingPayload(source, 'Comfort+')
  assert(payload.category === 'Comfort+', 'category cambia al target')
  assert(payload.bracket === 'short', 'bracket se copia igual')
  assert(payload.point_a === 'Plaza Mayor' && payload.point_b === 'Miraflores', 'puntos A/B sin invertir')
  assert(payload.waze_distance === 5.2, 'distancia se copia igual')
}

{
  console.log('\n[4] buildMirroredBPayload — invierte A/B para la ciudad pareja')
  const source = {
    bracket: 'short',
    point_a: 'Plaza Mayor',
    coordinate_a: '-12.05,-77.03',
    point_b: 'Aeropuerto',
    coordinate_b: '-12.02,-77.11',
    waze_distance: 5.2,
  }
  const payload = buildMirroredBPayload(source, 'Economy/Comfort')
  assert(payload.point_a === 'Aeropuerto', 'point_a espejo = point_b original')
  assert(payload.point_b === 'Plaza Mayor', 'point_b espejo = point_a original')
  assert(payload.coordinate_a === '-12.02,-77.11', 'coordinate_a espejo = coordinate_b original')
  assert(payload.coordinate_b === '-12.05,-77.03', 'coordinate_b espejo = coordinate_a original')
  assert(payload.waze_distance === 5.2, 'distancia no cambia (misma ruta, dirección inversa)')
}

// ── applyFillIfMissingCascade: fake Supabase client en memoria ────────────
// Simula .from(table).select().eq().eq()...limit()/.single() y
// .insert()/.update() lo mínimo necesario para ejercitar la cascada sin
// una DB real.
function makeFakeSb(initialRows, markerRows) {
  let rows = [...initialRows]
  let nextId = 1000
  const calls = []

  function matches(row, filters) {
    return Object.entries(filters).every(([k, v]) => row[k] === v)
  }

  function makeQuery(table) {
    const filters = {}
    const state = { table, filters, single: false, limitN: null }
    const api = {
      select() {
        return api
      },
      eq(k, v) {
        filters[k] = v
        return api
      },
      limit(n) {
        state.limitN = n
        return api
      },
      single() {
        state.single = true
        return api
      },
      insert(payload) {
        calls.push({ op: 'insert', table, payload })
        const row = { id: nextId++, ...payload }
        rows.push(row)
        return {
          select: () => ({
            single: async () => ({ data: row }),
          }),
        }
      },
      update(payload) {
        calls.push({ op: 'update', table, payload })
        return {
          eq: (k, v) => ({
            select: () => ({
              single: async () => {
                const row = rows.find((r) => r[k] === v)
                Object.assign(row, payload)
                return { data: row }
              },
            }),
          }),
        }
      },
      delete() {
        return api
      },
      then(resolve) {
        // await de una query select simple
        const table_ = table === 'airport_markers' ? markerRows : rows
        const found = table_.filter((r) => matches(r, filters))
        const data = state.single ? found[0] || null : state.limitN ? found.slice(0, state.limitN) : found
        resolve({ data })
      },
    }
    return api
  }

  return {
    from: (table) => makeQuery(table),
    _rows: () => rows,
    _calls: () => calls,
  }
}

{
  console.log('\n[5] Cascada: no hace nada si la categoría guardada no es la fuente')
  const sb = makeFakeSb([], [])
  const result = await applyFillIfMissingCascade(sb, {
    country: 'Peru',
    dbCity: 'Lima',
    savedRow: { category: 'Comfort+', bracket: 'short', point_a: 'A', point_b: 'B' },
    categoriesForCity: LIMA_CATS,
  })
  assert(result.filled.length === 0, 'no propaga si category !== fuente')
}

{
  console.log('\n[6] Cascada: fila fuente sin datos no dispara nada')
  const sb = makeFakeSb([], [])
  const result = await applyFillIfMissingCascade(sb, {
    country: 'Peru',
    dbCity: 'Lima',
    savedRow: { category: 'Economy/Comfort', bracket: 'short', point_a: '', point_b: '' },
    categoriesForCity: LIMA_CATS,
  })
  assert(result.filled.length === 0, 'sin point_a/point_b no propaga')
}

{
  console.log('\n[7] Cascada: llena hermanas vacías, respeta las que ya tienen datos, sin ciudad pareja')
  const sb = makeFakeSb(
    [
      // Premier ya tiene su propia ruta — no debe tocarse
      {
        id: 1,
        country: 'Peru',
        city: 'Lima',
        category: 'Premier',
        bracket: 'short',
        point_a: 'Ruta propia A',
        point_b: 'Ruta propia B',
      },
    ],
    [] // Lima no tiene par de aeropuerto
  )
  const savedRow = {
    category: 'Economy/Comfort',
    bracket: 'short',
    point_a: 'Plaza Mayor',
    point_b: 'Miraflores',
    coordinate_a: '-12.05,-77.03',
    coordinate_b: '-12.12,-77.02',
    waze_distance: 5.2,
  }
  const result = await applyFillIfMissingCascade(sb, {
    country: 'Peru',
    dbCity: 'Lima',
    savedRow,
    categoriesForCity: LIMA_CATS,
  })
  const filledCats = result.filled.map((f) => f.category).sort()
  assert(JSON.stringify(filledCats) === JSON.stringify(['Comfort+', 'XL']), `llena Comfort+ y XL (no Premier, no TukTuk/Corp): ${filledCats.join(', ')}`)
  const premier = sb._rows().find((r) => r.category === 'Premier')
  assert(premier.point_a === 'Ruta propia A', 'Premier con datos propios queda intacto')
  const comfortPlus = sb._rows().find((r) => r.category === 'Comfort+')
  assert(comfortPlus.point_a === 'Plaza Mayor' && comfortPlus.point_b === 'Miraflores', 'Comfort+ se llenó con la ruta de Economy/Comfort')
}

{
  console.log('\n[8] Cascada: propaga a la ciudad "_Airport_B" pareja con A/B invertidos')
  const sb = makeFakeSb(
    [],
    [{ country: 'Peru', city_from: 'Lima_Airport_A', city_to: 'Lima_Airport_B' }]
  )
  const savedRow = {
    category: 'Economy/Comfort',
    bracket: 'median',
    point_a: 'Aeropuerto Jorge Chávez',
    point_b: 'Hospital Lima Norte',
    coordinate_a: '-12.02,-77.11',
    coordinate_b: '-12.03,-77.09',
    waze_distance: 9.7,
  }
  const result = await applyFillIfMissingCascade(sb, {
    country: 'Peru',
    dbCity: 'Lima_Airport_A',
    savedRow,
    categoriesForCity: LIMA_CATS,
  })
  const bEconomy = sb
    ._rows()
    .find((r) => r.city === 'Lima_Airport_B' && r.category === 'Economy/Comfort')
  assert(!!bEconomy, 'se creó la fila Economy/Comfort en Lima_Airport_B')
  assert(bEconomy.point_a === 'Hospital Lima Norte', 'point_a invertido en la ciudad B')
  assert(bEconomy.point_b === 'Aeropuerto Jorge Chávez', 'point_b invertido en la ciudad B')

  const bComfortPlus = sb
    ._rows()
    .find((r) => r.city === 'Lima_Airport_B' && r.category === 'Comfort+')
  assert(!!bComfortPlus, 'la cascada dentro de Lima_Airport_B también llenó sus propias hermanas (Comfort+)')
  assert(bComfortPlus.point_a === 'Hospital Lima Norte', 'Comfort+ en B hereda la ruta ya invertida')

  const filledCities = new Set(result.filled.map((f) => f.city))
  assert(filledCities.has('Lima_Airport_A') && filledCities.has('Lima_Airport_B'), 'reporta filas llenadas en ambas ciudades')
}

console.log(`\nResultado: ${pass} pasados / ${fail} fallidos`)
if (fail > 0) {
  console.log('\nFallidos:')
  failures.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
console.log('Todo OK ✓')
