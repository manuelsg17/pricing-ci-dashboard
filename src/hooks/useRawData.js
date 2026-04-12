import { useState, useEffect, useCallback } from 'react'
import { sb } from '../lib/supabase'

const PAGE_SIZE = 100

export function useRawData(filters) {
  const [rows,    setRows]    = useState([])
  const [total,   setTotal]   = useState(0)
  const [page,    setPage]    = useState(0)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState(null)

  const { dbCity, dbCategory, competition, surge, bracket, dateFrom, dateTo, searchA, searchB, dataSource } = filters

  const fetch = useCallback(async (p = 0) => {
    if (!dbCity) return
    setLoading(true)
    setError(null)

    try {
      let q = sb
        .from('pricing_observations')
        .select('*', { count: 'exact' })
        .eq('city', dbCity)
        .order('observed_date', { ascending: false })
        .order('observed_time', { ascending: false })
        .range(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE - 1)

      if (dbCategory)    q = q.eq('category', dbCategory)
      if (competition)   q = q.eq('competition_name', competition)
      if (surge !== '')  q = q.eq('surge', surge === 'true')
      if (bracket)       q = q.eq('distance_bracket', bracket)
      if (dateFrom)      q = q.gte('observed_date', dateFrom)
      if (dateTo)        q = q.lte('observed_date', dateTo)
      if (searchA)    q = q.ilike('point_a', `%${searchA}%`)
      if (searchB)    q = q.ilike('point_b', `%${searchB}%`)
      if (dataSource) q = q.eq('data_source', dataSource)

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
  }, [dbCity, dbCategory, competition, surge, bracket, dateFrom, dateTo, searchA, searchB, dataSource])

  useEffect(() => { fetch(0) }, [fetch])

  return { rows, total, page, loading, error, fetch, pageSize: PAGE_SIZE }
}
