import { useState, useEffect } from 'react'
import { sb } from '../lib/supabase'

/**
 * Carga las ventanas de rush hour desde la BD y expone
 * una función para determinar si una hora/ciudad es rush.
 */
export function useRushHourConfig() {
  const [windows, setWindows] = useState([])
  const [error,   setError]   = useState(null)

  useEffect(() => {
    sb.from('rush_hour_windows').select('*').order('city').order('start_time')
      .then(({ data, error: e }) => {
        if (e) { setError(e.message); return }
        setWindows(data || [])
      })
  }, [])

  /**
   * ¿Es rush hour?
   * @param {string} timeStr  - "HH:MM" o "HH:MM:SS"
   * @param {string} city     - ciudad DB (Lima, Trujillo, etc.)
   * @returns {boolean|null}  - null si no hay ventanas configuradas
   */
  function isRushHour(timeStr, city) {
    if (!timeStr || !windows.length) return null
    const t = timeStr.slice(0, 5)   // "HH:MM"

    // Ventanas específicas para la ciudad, o 'all' como fallback
    const relevant = windows.filter(w => w.city === city || w.city === 'all')
    // Si hay ventanas específicas de ciudad, ignorar las 'all'
    const citySpecific = relevant.filter(w => w.city === city)
    const toCheck = citySpecific.length > 0 ? citySpecific : relevant.filter(w => w.city === 'all')

    if (!toCheck.length) return null

    return toCheck.some(w => t >= w.start_time.slice(0, 5) && t <= w.end_time.slice(0, 5))
  }

  return { windows, isRushHour, error }
}
