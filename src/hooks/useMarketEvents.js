import { useState, useEffect, useCallback, useRef } from 'react'
import { sb } from '../lib/supabase'

// Acceso a `market_events` en un solo lugar (patrón único de datos, 2026-09):
// antes Dashboard.jsx y MarketEvents.jsx pegaban a la tabla cada uno por su
// cuenta. Las consultas, filtros y manejo de errores son EXACTAMENTE los que
// tenían las páginas — acá solo cambió de archivo.

// Eventos de mercado para la vista diaria del Dashboard. Sin React Query a
// propósito: el efecto original refetcheaba en cada cambio de filtro y se
// vaciaba al salir de la vista diaria; un cache con staleTime cambiaría ese
// comportamiento.
export function useDashboardMarketEvents(filters) {
  const [marketEvents, setMarketEvents] = useState([])
  useEffect(() => {
    if (filters.viewMode !== 'daily') {
      setMarketEvents([])
      return
    }
    let cancelled = false
    sb.from('market_events')
      .select('id, city, event_date, event_type, impact, description')
      .eq('country', filters.country)
      .eq('city', filters.dbCity)
      .gte('event_date', filters.dailyStart)
      .lte('event_date', filters.dailyEnd)
      .order('event_date')
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) {
          setMarketEvents([])
          return
        }
        setMarketEvents(data || [])
      })
    return () => {
      cancelled = true
    }
  }, [filters.country, filters.viewMode, filters.dbCity, filters.dailyStart, filters.dailyEnd])
  return marketEvents
}

// Listado editable de la pantalla Eventos. `onLoaded` corre entre setEvents y
// setLoading(false), en el mismo lugar donde la página reseteaba sus edits.
export function useMarketEventsAdmin({ country, filterCity, filterFrom, filterTo, onLoaded }) {
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(false)
  // Ref, no dependencia: `load` conserva la MISMA identidad que tenía en la
  // página (solo país + filtros), así el `useEffect(() => load(), [load])` del
  // consumidor no se dispara de más por un callback nuevo en cada render.
  const onLoadedRef = useRef(onLoaded)
  onLoadedRef.current = onLoaded

  const load = useCallback(async () => {
    setLoading(true)
    let q = sb
      .from('market_events')
      .select('*')
      .eq('country', country)
      .gte('event_date', filterFrom)
      .lte('event_date', filterTo)
      .order('event_date', { ascending: false })

    if (filterCity !== 'Todas') {
      q = q.eq('city', filterCity)
    }

    const { data } = await q
    setEvents(data || [])
    if (onLoadedRef.current) onLoadedRef.current()
    setLoading(false)
  }, [country, filterCity, filterFrom, filterTo])

  return { events, setEvents, loading, load }
}

// Escrituras: devuelven `{ error }` tal cual supabase-js, la página decide el
// toast. Sin cache que invalidar — la página vuelve a llamar `load()`.
export async function insertMarketEvent(payload) {
  return sb.from('market_events').insert(payload)
}

export async function updateMarketEvent(id, payload) {
  return sb.from('market_events').update(payload).eq('id', id)
}

export async function deleteMarketEvent(id) {
  return sb.from('market_events').delete().eq('id', id)
}
