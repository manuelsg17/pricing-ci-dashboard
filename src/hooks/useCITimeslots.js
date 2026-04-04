import { useState, useEffect } from 'react'
import { sb } from '../lib/supabase'

// Fallback si la tabla ci_timeslots no existe aún en la BD
const FALLBACK_TIMESLOTS = [
  { id: 1, label: 'Mañana', start_time: '08:00', end_time: '10:00', is_active: true, sort_order: 1 },
  { id: 2, label: 'Tarde',  start_time: '13:00', end_time: '15:00', is_active: true, sort_order: 2 },
  { id: 3, label: 'Noche',  start_time: '18:00', end_time: '20:00', is_active: true, sort_order: 3 },
]

export function useCITimeslots() {
  const [timeslots, setTimeslots] = useState(FALLBACK_TIMESLOTS)
  const [loading,   setLoading]   = useState(true)

  useEffect(() => {
    sb.from('ci_timeslots')
      .select('*')
      .eq('is_active', true)
      .order('sort_order')
      .then(({ data, error }) => {
        if (!error && data && data.length > 0) setTimeslots(data)
        // Si hay error (tabla no existe) o vacío, queda el fallback
        setLoading(false)
      })
  }, [])

  return { timeslots, loading }
}
