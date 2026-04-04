import { useState, useEffect, useCallback } from 'react'
import { sb } from '../lib/supabase'

export function useDistanceRefs(dbCity) {
  const [refs,    setRefs]    = useState([])
  const [loading, setLoading] = useState(false)
  const [saving,  setSaving]  = useState(false)
  const [error,   setError]   = useState(null)

  const load = useCallback(async () => {
    if (!dbCity) return
    setLoading(true)
    setError(null)
    const { data, error: err } = await sb
      .from('distance_references')
      .select('*')
      .eq('city', dbCity)
      .order('category')
      .order('bracket')
    if (err) setError(err.message)
    else     setRefs(data || [])
    setLoading(false)
  }, [dbCity])

  useEffect(() => { load() }, [load])

  const saveRef = useCallback(async (row) => {
    setSaving(true)
    setError(null)
    const { error: err } = await sb
      .from('distance_references')
      .upsert({ ...row, city: dbCity, updated_at: new Date().toISOString() }, { onConflict: 'id' })
    if (err) { setError(err.message); setSaving(false); return false }
    await load()
    setSaving(false)
    return true
  }, [dbCity, load])

  const deleteRef = useCallback(async (id) => {
    setSaving(true)
    const { error: err } = await sb.from('distance_references').delete().eq('id', id)
    if (err) { setError(err.message); setSaving(false); return false }
    await load()
    setSaving(false)
    return true
  }, [load])

  const addRow = useCallback(() => {
    const tempId = `new_${Date.now()}`
    setRefs(prev => [...prev, {
      id: tempId, city: dbCity, category: '', bracket: '',
      point_a: '', coordinate_a: '', point_b: '', coordinate_b: '',
      waze_distance: '', _isNew: true,
    }])
  }, [dbCity])

  const addCategoryRows = useCallback((category, brackets) => {
    const newRows = brackets.map((b, i) => ({
      id: `new_${Date.now()}_${i}_${Math.random().toString(36).slice(2)}`,
      city: dbCity, category, bracket: b,
      point_a: '', coordinate_a: '', point_b: '', coordinate_b: '',
      waze_distance: '', _isNew: true,
    }))
    setRefs(prev => [...prev, ...newRows])
  }, [dbCity])

  return { refs, loading, saving, error, saveRef, deleteRef, addRow, addCategoryRows, reload: load }
}
