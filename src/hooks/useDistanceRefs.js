import { useState, useEffect, useCallback } from 'react'
import { sb } from '../lib/supabase'
import { BRACKETS } from '../lib/constants'

// Orden fijo very_short → very_long para mostrar/editar (Supabase ordena
// `bracket` alfabéticamente, que no coincide con el orden real de brackets).
// Brackets desconocidos/vacíos quedan al final en vez de romper el sort.
function sortByBracketOrder(rows) {
  const rank = (b) => {
    const i = BRACKETS.indexOf(b)
    return i === -1 ? BRACKETS.length : i
  }
  return [...rows].sort((a, b) => {
    if (a.category !== b.category) return a.category < b.category ? -1 : 1
    return rank(a.bracket) - rank(b.bracket)
  })
}

export function useDistanceRefs(dbCity, country) {
  const [refs, setRefs] = useState([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    if (!dbCity || !country) return
    setLoading(true)
    setError(null)
    const { data, error: err } = await sb
      .from('distance_references')
      .select('*')
      .eq('country', country)
      .eq('city', dbCity)
    if (err) setError(err.message)
    else setRefs(sortByBracketOrder(data || []))
    setLoading(false)
  }, [dbCity, country])

  useEffect(() => {
    load()
  }, [load])

  const saveRef = useCallback(
    async (row) => {
      setSaving(true)
      setError(null)
      const { error: err } = await sb
        .from('distance_references')
        .upsert(
          { ...row, city: dbCity, country, updated_at: new Date().toISOString() },
          { onConflict: 'id' }
        )
      if (err) {
        setError(err.message)
        setSaving(false)
        return false
      }
      await load()
      setSaving(false)
      return true
    },
    [dbCity, country, load]
  )

  const deleteRef = useCallback(
    async (id) => {
      setSaving(true)
      const { error: err } = await sb.from('distance_references').delete().eq('id', id)
      if (err) {
        setError(err.message)
        setSaving(false)
        return false
      }
      await load()
      setSaving(false)
      return true
    },
    [load]
  )

  const addRow = useCallback(() => {
    const tempId = `new_${Date.now()}`
    setRefs((prev) => [
      ...prev,
      {
        id: tempId,
        city: dbCity,
        country,
        category: '',
        bracket: '',
        point_a: '',
        coordinate_a: '',
        point_b: '',
        coordinate_b: '',
        waze_distance: '',
        zone: '',
        _isNew: true,
      },
    ])
  }, [dbCity, country])

  const addCategoryRows = useCallback(
    (category, brackets) => {
      const newRows = brackets.map((b, i) => ({
        id: `new_${Date.now()}_${i}_${Math.random().toString(36).slice(2)}`,
        city: dbCity,
        country,
        category,
        bracket: b,
        point_a: '',
        coordinate_a: '',
        point_b: '',
        coordinate_b: '',
        waze_distance: '',
        zone: '',
        _isNew: true,
      }))
      setRefs((prev) => [...prev, ...newRows])
    },
    [dbCity, country]
  )

  return { refs, loading, saving, error, saveRef, deleteRef, addRow, addCategoryRows, reload: load }
}
