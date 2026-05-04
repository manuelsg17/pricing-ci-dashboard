import { useState, useEffect } from 'react'
import { sb } from '../lib/supabase'

export function useFilterPresets(country) {
  const [presets, setPresets]   = useState([])
  const [saving,  setSaving]    = useState(false)

  useEffect(() => {
    let cancelled = false
    sb.from('user_filter_presets')
      .select('id, name, filters, created_at')
      .eq('country', country)
      .order('created_at', { ascending: false })
      .then(({ data }) => {
        if (!cancelled) setPresets(data || [])
      })
    return () => { cancelled = true }
  }, [country])

  async function savePreset(name, filters) {
    if (!name.trim()) return false
    setSaving(true)
    const { data: userData } = await sb.auth.getUser()
    if (!userData?.user) { setSaving(false); return false }
    const payload = {
      name: name.trim(),
      country,
      user_id: userData.user.id,
      filters: {
        city:         filters.city,
        category:     filters.category,
        subCategory:  filters.subCategory,
        zone:         filters.zone,
        surge:        filters.surge,
        dataSource:   filters.dataSource,
        compareVs:    filters.compareVs,
        viewMode:     filters.viewMode,
        weekStart:    filters.weekStart,
        dailyStart:   filters.dailyStart,
        historicFrom: filters.historicFrom,
        historicTo:   filters.historicTo,
        timeOfDay:    filters.timeOfDay,
      },
    }
    const { data, error } = await sb.from('user_filter_presets').insert(payload).select().single()
    setSaving(false)
    if (!error && data) { setPresets(prev => [data, ...prev]); return true }
    return false
  }

  async function deletePreset(id) {
    const { error } = await sb.from('user_filter_presets').delete().eq('id', id)
    if (!error) setPresets(prev => prev.filter(p => p.id !== id))
    return !error
  }

  return { presets, saving, savePreset, deletePreset }
}
