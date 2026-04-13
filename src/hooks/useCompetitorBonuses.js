import { useState, useEffect, useCallback, useMemo } from 'react'
import { sb } from '../lib/supabase'

export function useCompetitorBonuses(city, country = 'Peru') {
  const [allRows, setAllRows] = useState([])
  const [loading, setLoading] = useState(true)

  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    if (!country) return
    setLoading(true)
    setError(null)
    const { data, error: e } = await sb
      .from('competitor_bonuses')
      .select('*')
      .eq('country', country)
      .order('competitor_name')
      .order('sort_order')
    if (e) setError(e.message)
    else if (data) setAllRows(data)
    setLoading(false)
  }, [country])

  useEffect(() => { load() }, [load])

  // Returns active bonuses relevant to the city (global + city-specific), grouped by competitor
  const bonuses = useMemo(() => {
    const result = {}
    for (const row of allRows) {
      if (!row.is_active) continue
      if (row.city !== null && row.city !== undefined && row.city !== city) continue
      if (!result[row.competitor_name]) result[row.competitor_name] = []
      result[row.competitor_name].push(row)
    }
    return result
  }, [allRows, city])

  const saveBonus = useCallback(async (row) => {
    const payload = {
      competitor_name: row.competitor_name,
      city:            row.city || null,
      country,
      bonus_type:      row.bonus_type,
      threshold:       Number(row.threshold),
      bonus_amount:    Number(row.bonus_amount),
      description:     row.description || null,
      sort_order:      Number(row.sort_order) || 0,
      is_active:       row.is_active ?? true,
      updated_at:      new Date().toISOString(),
    }
    let err
    if (String(row.id).startsWith('new_')) {
      ;({ error: err } = await sb.from('competitor_bonuses').insert(payload))
    } else {
      ;({ error: err } = await sb.from('competitor_bonuses').update(payload).eq('id', row.id))
    }
    if (!err) await load()
    return !err
  }, [load, country])

  const deleteBonus = useCallback(async (id) => {
    if (String(id).startsWith('new_')) {
      setAllRows(prev => prev.filter(r => r.id !== id))
      return true
    }
    const { error } = await sb.from('competitor_bonuses').delete().eq('id', id)
    if (!error) await load()
    return !error
  }, [load])

  const addRow = useCallback(() => {
    const tempId = `new_${Date.now()}`
    setAllRows(prev => [...prev, {
      id: tempId, competitor_name: '', city: null,
      bonus_type: 'viajes', threshold: 0, bonus_amount: 0,
      description: '', sort_order: 0, is_active: true, _isNew: true,
    }])
  }, [])

  return { allRows, bonuses, loading, error, saveBonus, deleteBonus, addRow, reload: load }
}
