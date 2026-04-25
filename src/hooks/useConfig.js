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
        sb.from('semaforo_config').select('*').eq('country', country).order('band').order('min_pct'),
      ])
      if (t.error) throw t.error
      if (w.error) throw w.error

      // semaforo_config puede no tener columna country (pre-migración 33).
      // En ese caso caemos al select sin filtro para no romper la UI.
      let semaforoRows = s.data
      if (s.error) {
        const s2 = await sb.from('semaforo_config').select('*').order('band').order('min_pct')
        if (s2.error) throw s2.error
        semaforoRows = s2.data
      }

      setThresholds(t.data || [])
      setWeights(w.data    || [])
      setSemaforo(semaforoRows || [])
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [country])

  useEffect(() => { load() }, [load])

  // Guarda umbrales y dispara backfill inmediato en la BD para que los
  // brackets de pricing_observations queden alineados con la nueva config.
  // Devuelve { recomputedCount } con el número de filas re-clasificadas.
  const saveThresholds = async (rows) => {
    setSaving(true)
    try {
      const data = rows.map(r => ({ ...r, country }))
      const { error } = await sb
        .from('distance_thresholds')
        .upsert(data, { onConflict: 'country,city,category,bracket' })
      if (error) throw error

      // Backfill automático: re-clasifica filas existentes con los nuevos umbrales.
      // Si el RPC no existe (migración 33 no aplicada), seguimos sin romper el save.
      let recomputedCount = 0
      if (rows.length > 0) {
        const { city, category } = rows[0]
        const { data: cnt, error: rpcErr } = await sb.rpc('recompute_brackets_for', {
          p_country:  country,
          p_city:     city,
          p_category: category,
        })
        if (!rpcErr && typeof cnt === 'number') recomputedCount = cnt
      }

      await load()
      return { recomputedCount }
    } finally {
      setSaving(false)
    }
  }

  const saveWeights = async (rows) => {
    setSaving(true)
    try {
      const data = rows.map(r => ({ ...r, country }))
      const { error } = await sb
        .from('bracket_weights')
        .upsert(data, { onConflict: 'country,city,bracket' })
      if (error) throw error
      await load()
    } finally {
      setSaving(false)
    }
  }

  // Semáforo: antes borraba TODO globalmente (sin filtro por country),
  // lo que al guardar Perú borraría semáforo de otros países. Ahora el
  // scope es sólo country actual.
  const saveSemaforo = async (rows) => {
    setSaving(true)
    try {
      const { error: delErr } = await sb
        .from('semaforo_config')
        .delete()
        .eq('country', country)
      if (delErr) throw delErr

      const data = rows.map(r => ({ ...r, country }))
      const { error: insErr } = await sb.from('semaforo_config').insert(data)
      if (insErr) throw insErr

      await load()
    } finally {
      setSaving(false)
    }
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
