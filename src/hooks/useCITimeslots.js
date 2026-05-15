import { sb } from '../lib/supabase'
import { useStaleWhileRevalidate } from './useStaleWhileRevalidate'

// Fallback si la tabla ci_timeslots no existe aún en la BD.
const FALLBACK_TIMESLOTS = [
  { id: 1, label: 'Mañana', start_time: '08:00', end_time: '10:00', is_active: true, sort_order: 1 },
  { id: 2, label: 'Tarde',  start_time: '13:00', end_time: '15:00', is_active: true, sort_order: 2 },
  { id: 3, label: 'Noche',  start_time: '18:00', end_time: '20:00', is_active: true, sort_order: 3 },
]

export function useCITimeslots() {
  const { data, loading } = useStaleWhileRevalidate({
    key: 'cfg.ci_timeslots.active',
    liveSyncTable: 'ci_timeslots',
    fetcher: async () => {
      const { data, error } = await sb.from('ci_timeslots')
        .select('*').eq('is_active', true).order('sort_order')
      if (error) throw error
      return (data && data.length > 0) ? data : FALLBACK_TIMESLOTS
    },
  })
  // Si SWR devolvió null (cache miss y fetch en curso) → fallback hasta
  // que llegue la respuesta. Mantiene la UI funcional sin pantalla en
  // blanco para callers que no validan timeslots vacío.
  const timeslots = data || FALLBACK_TIMESLOTS
  return { timeslots, loading }
}
