import { useState, useEffect, useCallback } from 'react'
import { sb } from '../lib/supabase'

export function useConfig(country) {
  const [thresholds, setThresholds] = useState([])
  const [weights,    setWeights]    = useState([])
  const [semaforo,   setSemaforo]   = useState([])
  const [loading,    setLoading]    = useState(true)
  const [saving,     setSaving]     = useState(false)
  const [error,      setError]      = useState(null)

  const load = useCallback(async () => {
    if (!country) return
    setLoading(true)
    setError(null)
    try {
      const [t, w, s] = await Promise.all([
        sb.from('distance_thresholds').select('*').eq('country', country).order('city').order('category').order('max_km'),
        sb.from('bracket_weights').select('*').eq('country', country).order('city').order('bracket'),
        sb.from('semaforo_config').select('*').order('band').order('min_pct'),
      ])
      if (t.error) throw t.error
      if (w.error) throw w.error
      if (s.error) throw s.error
      setThresholds(t.data || [])
      setWeights(w.data    || [])
      setSemaforo(s.data   || [])
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [country])

  useEffect(() => { load() }, [load])

  const saveThresholds = async (rows) => {
    setSaving(true)
    // Inyectar country si no está presente
    const data = rows.map(r => ({ ...r, country }))
    const { error } = await sb.from('distance_thresholds').upsert(data, { onConflict: 'country,city,category,bracket' })
    setSaving(false)
    if (error) throw error
    await load()
  }

  const saveWeights = async (rows) => {
    setSaving(true)
    const data = rows.map(r => ({ ...r, country }))
    const { error } = await sb.from('bracket_weights').upsert(data, { onConflict: 'country,city,bracket' })
    setSaving(false)
    if (error) throw error
    await load()
  }

  const saveSemaforo = async (rows) => {
    setSaving(true)
    // Borrar y re-insertar (configuración completa)
    await sb.from('semaforo_config').delete().neq('id', 0)
    const { error } = await sb.from('semaforo_config').insert(rows)
    setSaving(false)
    if (error) throw error
    await load()
  }

  return {
    thresholds,
    weights,
    semaforo,
    loading,
    saving,
    error,
    saveThresholds,
    saveWeights,
    saveSemaforo,
    reload: load,
  }
}
