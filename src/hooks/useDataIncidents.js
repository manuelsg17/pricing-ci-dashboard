import { useQuery } from '@tanstack/react-query'
import { sb } from '../lib/supabase'

// Identidad estable para no invalidar memos aguas abajo (CLAUDE.md §5).
const EMPTY_ARR = []

// Incidentes de "sin data por falla del sistema" (mig 229). Cambian poco
// (se cargan cuando algo se rompe), así que 10 min de caché alcanzan.
export function useDataIncidents(country) {
  const { data } = useQuery({
    queryKey: ['dataIncidents', country],
    enabled: Boolean(country),
    staleTime: 10 * 60 * 1000,
    queryFn: async () => {
      const { data: rows, error } = await sb
        .from('data_incidents')
        .select('city, competitor, date_from, date_to, reason')
        .eq('country', country)
      if (error) throw error
      return rows || []
    },
  })
  return data || EMPTY_ARR
}
