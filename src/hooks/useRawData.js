import { useState, useEffect, useCallback } from 'react'
import { sb } from '../lib/supabase'
import { getCountryConfig } from '../lib/constants'

const PAGE_SIZE = 100

export function useRawData(filters) {
  const [rows,    setRows]    = useState([])
  const [total,   setTotal]   = useState(0)
  const [page,    setPage]    = useState(0)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState(null)

  const { dbCity, dbCategory, competition, surge, bracket, dateFrom, dateTo, searchA, searchB, dataSource, outlierOnly, country } = filters

  const fetch = useCallback(async (p = 0) => {
    if (!dbCity) return
    setLoading(true)
    setError(null)

    try {
      let q = sb
        .from('pricing_observations')
        .select(
          'id, country, city, year, week, observed_date, observed_time, rush_hour, surge, category, competition_name, data_source, distance_bracket, zone, distance_km, point_a, point_b, price_without_discount, price_with_discount, recommended_price, minimal_bid, eta_min',
          { count: 'exact' }
        )
        .eq('city', dbCity)
        .order('observed_date', { ascending: false })
        .order('observed_time', { ascending: false })
        .range(p * PAGE_SIZE, p * PAGE_SIZE + PAGE_SIZE - 1)

      if (country)       q = q.eq('country', country)
      if (dbCategory)    q = q.eq('category', dbCategory)
      if (competition)   q = q.eq('competition_name', competition)
      if (surge !== '')  q = q.eq('surge', surge === 'true')
      if (bracket)       q = q.eq('distance_bracket', bracket)
      if (dateFrom)      q = q.gte('observed_date', dateFrom)
      if (dateTo)        q = q.lte('observed_date', dateTo)
      if (searchA)    q = q.ilike('point_a', `%${searchA}%`)
      if (searchB)    q = q.ilike('point_b', `%${searchB}%`)
      if (dataSource) q = q.eq('data_source', dataSource)
      if (outlierOnly) {
        const threshold = getCountryConfig(country).outlierThreshold || 100
        q = q.or(
          `price_without_discount.gt.${threshold},price_with_discount.gt.${threshold},recommended_price.gt.${threshold},minimal_bid.gt.${threshold}`
        )
      }

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
  }, [dbCity, dbCategory, competition, surge, bracket, dateFrom, dateTo, searchA, searchB, dataSource, outlierOnly, country])

  useEffect(() => { fetch(0) }, [fetch])

  return { rows, setRows, total, setTotal, page, loading, error, fetch, pageSize: PAGE_SIZE }
}
