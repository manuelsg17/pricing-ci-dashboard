import { useState, useEffect, useCallback, useMemo } from 'react'
import { sb } from '../lib/supabase'

export function useCompetitorCommissions(city, country = 'Peru') {
  const [allRows, setAllRows] = useState([])
  const [loading, setLoading] = useState(true)

  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    if (!country) return
    setLoading(true)
    setError(null)
    const { data, error: e } = await sb
      .from('competitor_commissions')
      .select('*')
      .eq('country', country)
      .order('competitor_name')
    if (e) setError(e.message)
    else if (data) setAllRows(data)
    setLoading(false)
  }, [country])

  useEffect(() => { load() }, [load])

  // Returns commission_pct for a competitor, preferring city-specific over global (city=null)
  const commissions = useMemo(() => {
    const result = {}
    for (const row of allRows) {
      const name = row.competitor_name
      if (row.city === null || row.city === undefined) {
        if (result[name] === undefined) result[name] = row.commission_pct
      }
    }
    for (const row of allRows) {
      if (row.city === city) result[row.competitor_name] = row.commission_pct
    }
    return result
  }, [allRows, city])

  const saveCommission = useCallback(async (row) => {
    const payload = {
      competitor_name: row.competitor_name,
      city:            row.city || null,
      country,
      commission_pct:  Number(row.commission_pct),
      updated_at:      new Date().toISOString(),
    }
    let err
    if (String(row.id).startsWith('new_')) {
      ;({ error: err } = await sb.from('competitor_commissions').insert(payload))
    } else {
      ;({ error: err } = await sb.from('competitor_commissions').update(payload).eq('id', row.id))
    }
    if (!err) await load()
    return !err
  }, [load, country])

  const deleteCommission = useCallback(async (id) => {
    if (String(id).startsWith('new_')) {
      setAllRows(prev => prev.filter(r => r.id !== id))
      return true
    }
    const { error } = await sb.from('competitor_commissions').delete().eq('id', id)
    if (!error) await load()
    return !error
  }, [load])

  const addRow = useCallback(() => {
    const tempId = `new_${Date.now()}`
    setAllRows(prev => [...prev, {
      id: tempId, competitor_name: '', city: null, commission_pct: 0, _isNew: true,
    }])
  }, [])

  return { allRows, commissions, loading, error, saveCommission, deleteCommission, addRow, reload: load }
}
