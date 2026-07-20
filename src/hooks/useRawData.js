import { useState, useEffect, useCallback } from 'react'
import { sb } from '../lib/supabase'
import { getCountryConfig } from '../lib/constants'

const PAGE_SIZE = 100
const EXPORT_CHUNK_SIZE = 1000

// Columnas compartidas por la tabla en pantalla y el export de data raw —
// una sola fuente de verdad para que ambos siempre muestren lo mismo.
export const RAW_DATA_COLUMNS =
  'id, country, city, year, week, observed_date, observed_time, rush_hour, surge, category, competition_name, data_source, distance_bracket, zone, distance_km, point_a, point_b, price_without_discount, price_with_discount, recommended_price, minimal_bid, bid_1, bid_2, bid_3, bid_4, bid_5, eta_min'

// Aplica el mismo set de filtros de RawData.jsx a un query builder de
// supabase-js — compartido entre fetch() (paginado, para la tabla) y
// fetchAllRawData() (todas las filas que matcheen, para el export).
function applyRawDataFilters(query, filters) {
  const {
    dbCity,
    dbCategory,
    competition,
    surge,
    bracket,
    dateFrom,
    dateTo,
    searchA,
    searchB,
    dataSource,
    outlierOnly,
    country,
  } = filters
  let q = query
  if (country) q = q.eq('country', country)
  if (dbCity) q = q.eq('city', dbCity)
  if (dbCategory) q = q.eq('category', dbCategory)
  if (competition) q = q.eq('competition_name', competition)
  if (surge !== '') q = q.eq('surge', surge === 'true')
  if (bracket) q = q.eq('distance_bracket', bracket)
  if (dateFrom) q = q.gte('observed_date', dateFrom)
  if (dateTo) q = q.lte('observed_date', dateTo)
  if (searchA) q = q.ilike('point_a', `%${searchA}%`)
  if (searchB) q = q.ilike('point_b', `%${searchB}%`)
  if (dataSource) q = q.eq('data_source', dataSource)
  if (outlierOnly) {
    const threshold = getCountryConfig(country).outlierThreshold || 100
    q = q.or(
      `price_without_discount.gt.${threshold},price_with_discount.gt.${threshold},recommended_price.gt.${threshold},minimal_bid.gt.${threshold}`
    )
  }
  return q
}

export function useRawData(filters) {
  const [rows, setRows] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const {
    dbCity,
    dbCategory,
    competition,
    surge,
    bracket,
    dateFrom,
    dateTo,
    searchA,
    searchB,
    dataSource,
    outlierOnly,
    country,
  } = filters

  const fetch = useCallback(
    async (p = 0) => {
      if (!dbCity) return
      setLoading(true)
      setError(null)

      try {
        let q = sb.from('pricing_observations').select(RAW_DATA_COLUMNS, { count: 'exact' })
        q = applyRawDataFilters(q, filters)
        // Tercer criterio (id) desempata filas con mismo date+time exacto (ej.
        // una carga manual en batch) — sin esto, .range() puede repetir o
        // saltarse filas entre página y página cuando Postgres reordena empates.
        q = q
          .order('observed_date', { ascending: false })
          .order('observed_time', { ascending: false })
          .order('id', { ascending: true })
          .range(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE - 1)

        const { data, error: err, count } = await q
        if (err) throw err
        setRows(data || [])
        setTotal(count || 0)
        setPage(p)
      } catch (e) {
        setError(e.message)
      } finally {
        setLoading(false)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      dbCity,
      dbCategory,
      competition,
      surge,
      bracket,
      dateFrom,
      dateTo,
      searchA,
      searchB,
      dataSource,
      outlierOnly,
      country,
    ]
  )

  useEffect(() => {
    fetch(0)
  }, [fetch])

  return { rows, setRows, total, setTotal, page, loading, error, fetch, pageSize: PAGE_SIZE }
}

// Cuenta filas que matcheen los filtros SIN traer datos (head: true) — usado
// por el botón Exportar para decidir si pedir confirmación con un número
// confiable. No reusar el `total` del hook: queda stale hasta que resuelve
// el fetch paginado, y si el usuario cambia un filtro y exporta antes de que
// eso resuelva, el conteo mostrado (y el gate de confirmación) correspondería
// a los filtros VIEJOS en vez de los que realmente se van a exportar.
//
// snapshotIso (opcional): ancla el conteo a "subido hasta este instante"
// (uploaded_at <= snapshotIso). RawData.jsx pasa el MISMO snapshotIso acá y
// en fetchAllRawData para que el número que se muestra en el diálogo de
// confirmación coincida con lo que realmente se exporta — sin esto, una
// sync del bot entrando a mitad de un export grande (puede tardar varios
// minutos) haría que el conteo y las filas exportadas no coincidan.
export async function countRawData(filters, { snapshotIso } = {}) {
  if (!filters.dbCity) return 0
  let q = sb.from('pricing_observations').select('id', { count: 'exact', head: true })
  q = applyRawDataFilters(q, filters)
  if (snapshotIso) q = q.lte('uploaded_at', snapshotIso)
  const { count, error } = await q
  if (error) throw error
  return count || 0
}

// Trae TODAS las filas que matcheen los filtros (no solo la página actual)
// paginando en chunks de hasta EXPORT_CHUNK_SIZE filas — para el botón
// "Exportar" de RawData.jsx.
//
// El corte del loop se basa en `all.length < total` (el `count` real de
// Postgres), NO en "¿la respuesta trajo menos de EXPORT_CHUNK_SIZE filas?" —
// si el proyecto de Supabase tuviera un "Max Rows" de API configurado por
// debajo de EXPORT_CHUNK_SIZE, cada chunk devolvería silenciosamente menos
// filas de las pedidas, y cortar por "vino menos de lo pedido" truncaría el
// export completo tras el primer chunk. `offset` avanza por `data.length`
// (lo que realmente vino), no por EXPORT_CHUNK_SIZE asumido — así el
// paginado es correcto sin importar cuál sea el cap real del servidor.
//
// El count exacto solo se pide en el primer chunk (evita recalcular
// COUNT(*) en cada una de las N vueltas de un export grande).
// onProgress(loaded, total) se llama tras cada chunk. snapshotIso: ver
// countRawData — mismo valor pasado desde RawData.jsx para que el total
// contado y las filas traídas correspondan al mismo instante.
export async function fetchAllRawData(filters, { onProgress, snapshotIso } = {}) {
  if (!filters.dbCity) return []
  let offset = 0
  let total = null
  const all = []

  while (total === null || all.length < total) {
    let q = sb
      .from('pricing_observations')
      .select(RAW_DATA_COLUMNS, total === null ? { count: 'exact' } : {})
    q = applyRawDataFilters(q, filters)
    if (snapshotIso) q = q.lte('uploaded_at', snapshotIso)
    // id como tercer criterio: mismo motivo que en fetch() — garantiza orden
    // determinístico para que los chunks de .range() no se pisen ni salteen
    // filas cuando hay empates de date+time.
    q = q
      .order('observed_date', { ascending: false })
      .order('observed_time', { ascending: false })
      .order('id', { ascending: true })
      .range(offset, offset + EXPORT_CHUNK_SIZE - 1)

    const { data, error, count } = await q
    if (error) throw error
    if (total === null) total = count || 0
    if (!data || data.length === 0) break // count decía que había más, pero no vino nada más: cortar, no colgar
    all.push(...data)
    offset += data.length
    onProgress?.(all.length, total)
  }

  return all
}
