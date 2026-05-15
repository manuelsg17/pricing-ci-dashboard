import { sb } from '../lib/supabase'
import { useStaleWhileRevalidate } from './useStaleWhileRevalidate'

/**
 * Carga las ventanas de rush hour desde la BD y expone una función para
 * determinar si una hora/ciudad es rush. Cachea localmente y se refresca
 * automáticamente si otra sesión edita rush_hour_windows.
 */
export function useRushHourConfig(country = 'Peru') {
  const { data: windows = [], error } = useStaleWhileRevalidate({
    key: `cfg.rush_hour_windows.${country}`,
    enabled: !!country,
    liveSyncTable: 'rush_hour_windows',
    fetcher: async () => {
      const { data, error } = await sb.from('rush_hour_windows')
        .select('*').eq('country', country)
        .order('city').order('start_time')
      if (error) throw error
      return data || []
    },
  })

  /**
   * @param {string} timeStr - "HH:MM" o "HH:MM:SS"
   * @param {string} city    - ciudad DB (Lima, Trujillo, etc.)
   * @returns {boolean|null} - null si no hay ventanas configuradas
   */
  function isRushHour(timeStr, city) {
    if (!timeStr || !windows.length) return null
    const t = timeStr.slice(0, 5)
    // Ventanas específicas para la ciudad, o 'all' como fallback
    const relevant = windows.filter(w => w.city === city || w.city === 'all')
    const citySpecific = relevant.filter(w => w.city === city)
    const toCheck = citySpecific.length > 0 ? citySpecific : relevant.filter(w => w.city === 'all')
    if (!toCheck.length) return null
    return toCheck.some(w => t >= w.start_time.slice(0, 5) && t <= w.end_time.slice(0, 5))
  }

  return { windows, isRushHour, error }
}
