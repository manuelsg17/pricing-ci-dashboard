import { useState, useEffect, useCallback } from 'react'
import { sb } from '../lib/supabase'

// CRUD de competitive_bands (mig 124) — espejo de useCompetitorCommissions.js
// pero sin dimensión de ciudad (la banda aplica a TODAS las ciudades/brackets
// del país a la vez, por diseño).
export function useCompetitiveBands(country) {
  const [allRows, setAllRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    if (!country) return
    setLoading(true)
    setError(null)
    const { data, error: e } = await sb
      .from('competitive_bands')
      .select('*')
      .eq('country', country)
      .order('competitor_name')
      .order('category')
    if (e) setError(e.message)
    else if (data) setAllRows(data)
    setLoading(false)
  }, [country])

  useEffect(() => {
    load()
  }, [load])

  const saveBand = useCallback(
    async (row) => {
      const payload = {
        country,
        competitor_name: row.competitor_name,
        category: row.category,
        min_pct: Number(row.min_pct),
        max_pct: Number(row.max_pct),
        note: row.note || null,
        is_active: row.is_active !== false,
        updated_at: new Date().toISOString(),
      }
      let err
      if (String(row.id).startsWith('new_')) {
        ;({ error: err } = await sb.from('competitive_bands').insert(payload))
      } else {
        ;({ error: err } = await sb.from('competitive_bands').update(payload).eq('id', row.id))
      }
      if (!err) await load()
      return !err ? null : err.message
    },
    [load, country]
  )

  const deleteBand = useCallback(
    async (id) => {
      if (String(id).startsWith('new_')) {
        setAllRows((prev) => prev.filter((r) => r.id !== id))
        return true
      }
      const { error: e } = await sb.from('competitive_bands').delete().eq('id', id)
      if (!e) await load()
      return !e
    },
    [load]
  )

  const addRow = useCallback(() => {
    const tempId = `new_${Date.now()}`
    setAllRows((prev) => [
      ...prev,
      {
        id: tempId,
        competitor_name: '',
        category: '',
        min_pct: -15,
        max_pct: -5,
        note: '',
        is_active: true,
        _isNew: true,
      },
    ])
  }, [])

  return { allRows, loading, error, saveBand, deleteBand, addRow, reload: load }
}
