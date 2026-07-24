import { sb } from './supabase'

// Cap por request. La API de Supabase/PostgREST tiene un "Max Rows" (default
// 1000): una consulta que pide TODAS las filas en un solo request para
// agregarlas en el cliente recibe como mucho ese cap SIN error — el resultado
// se ve válido pero está calculado sobre un subconjunto truncado. Este helper
// pagina con .range() para traer el universo completo.
const CHUNK = 1000

// Trae TODAS las filas de pricing_observations que matcheen los filtros,
// paginando en chunks. Pensado para features que AGREGAN en el cliente
// (promedios de reportes/rentabilidad) donde traer solo 1000 filas daría un
// número incorrecto en silencio.
//
// El corte del loop usa `all.length < total` (el count real de Postgres), NO
// "¿vino menos de lo pedido?" — si el "Max Rows" del proyecto fuera menor que
// CHUNK, cada chunk vendría corto y cortar por "vino menos" truncaría todo tras
// el primer chunk. `offset` avanza por `data.length` real. Mismo patrón robusto
// que fetchAllRawData en useRawData.js.
//
// `applyFilters(q)` recibe el query base y le encadena los .eq()/.not() del
// caller. El orden por `id` (PK única) garantiza chunks determinísticos sin
// solapes; el orden no afecta el agregado (sum/count son conmutativos).
export async function fetchAllObservations(columns, applyFilters) {
  let offset = 0
  let total = null
  const all = []

  while (total === null || all.length < total) {
    let q = sb
      .from('pricing_observations')
      .select(columns, total === null ? { count: 'exact' } : {})
    q = applyFilters(q)
    q = q.order('id', { ascending: true }).range(offset, offset + CHUNK - 1)

    const { data, error, count } = await q
    if (error) throw error
    if (total === null) total = count || 0
    if (!data || data.length === 0) break // count decía que había más pero no vino nada: cortar, no colgar
    all.push(...data)
    offset += data.length
  }

  return all
}
