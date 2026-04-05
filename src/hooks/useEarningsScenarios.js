import { useState, useEffect, useCallback } from 'react'
import { sb } from '../lib/supabase'

export function useEarningsScenarios(city, category) {
  const [scenarios, setScenarios] = useState([])
  const [loading,   setLoading]   = useState(false)

  const load = useCallback(async () => {
    if (!city || !category) return
    setLoading(true)
    const { data } = await sb
      .from('earnings_scenarios')
      .select('*')
      .eq('city', city)
      .eq('category', category)
      .order('created_at', { ascending: false })
      .limit(20)
    setScenarios(data || [])
    setLoading(false)
  }, [city, category])

  useEffect(() => { load() }, [load])

  const saveScenario = useCallback(async (payload) => {
    const { error } = await sb.from('earnings_scenarios').insert(payload)
    if (!error) await load()
    return !error
  }, [load])

  const deleteScenario = useCallback(async (id) => {
    const { error } = await sb.from('earnings_scenarios').delete().eq('id', id)
    if (!error) await load()
    return !error
  }, [load])

  return { scenarios, loading, saveScenario, deleteScenario, reload: load }
}
