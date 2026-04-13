import { useState, useEffect, useCallback } from 'react'
import { sb } from '../lib/supabase'

export function useEarningsScenarios(city, category, country = 'Peru') {
  const [scenarios, setScenarios] = useState([])
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState(null)

  const load = useCallback(async () => {
    if (!city || !category) return
    setLoading(true)
    setError(null)
    const { data, error: e } = await sb
      .from('earnings_scenarios')
      .select('*')
      .eq('country', country)
      .eq('city', city)
      .eq('category', category)
      .order('created_at', { ascending: false })
      .limit(20)
    if (e) setError(e.message)
    else setScenarios(data || [])
    setLoading(false)
  }, [country, city, category])

  useEffect(() => { load() }, [load])

  const saveScenario = useCallback(async (payload) => {
    const { error } = await sb.from('earnings_scenarios').insert({ ...payload, country })
    if (!error) await load()
    return !error
  }, [load, country])

  const deleteScenario = useCallback(async (id) => {
    const { error } = await sb.from('earnings_scenarios').delete().eq('id', id)
    if (!error) await load()
    return !error
  }, [load])

  return { scenarios, loading, error, saveScenario, deleteScenario, reload: load }
}
