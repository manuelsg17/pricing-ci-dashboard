import { useState, useEffect, useCallback } from 'react'
import { sb } from '../lib/supabase'
import { classifySession, DEBUG_WINDOW_MS } from '../lib/monitoring'

// Sesiones EN VIVO de "Ingresar CI" — lee la tabla de latido (mig 146,
// ci_active_sessions) cada ~20s. Solo admin puede ver todas las filas (RLS);
// para un hub normal esta misma query le devolvería solo la suya (no se usa
// este hook fuera de Monitoreo, así que no importa acá).
const POLL_MS = 20_000

export function useLiveSessions(country) {
  const [rows, setRows] = useState([])
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    if (!country) return
    try {
      const sinceIso = new Date(Date.now() - DEBUG_WINDOW_MS).toISOString()
      const { data, error } = await sb
        .from('ci_active_sessions')
        .select('*')
        .eq('country', country)
        .gte('last_seen_at', sinceIso)
        .order('last_seen_at', { ascending: false })
      if (error) {
        setFailed(true)
        setRows([])
        return
      }
      setFailed(false)
      setRows(Array.isArray(data) ? data : [])
    } catch {
      setFailed(true)
      setRows([])
    }
  }, [country])

  useEffect(() => {
    load()
    const iv = setInterval(load, POLL_MS)
    return () => clearInterval(iv)
  }, [load])

  const now = Date.now()
  const live = rows.filter((r) => classifySession(r.last_seen_at, now) === 'live')
  const recentInactive = rows.filter(
    (r) => classifySession(r.last_seen_at, now) === 'recent_inactive'
  )

  return { live, recentInactive, failed }
}
