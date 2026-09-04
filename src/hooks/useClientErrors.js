import { useState, useEffect, useCallback } from 'react'
import { sb } from '../lib/supabase'

// Errores del cliente sin resolver (mig 185), más reciente primero. Antes
// vivía inline en ClientErrorsPanel.jsx; el panel ahora solo pinta. Las
// consultas son las mismas: la RLS de client_errors (SELECT solo admin) y
// resolve_client_error (RAISE si no es admin) siguen siendo la seguridad real.
export const CLIENT_ERRORS_PAGE_SIZE = 20

export function useClientErrors() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [actionErr, setActionErr] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setFailed(false)
    // Se pide UNA fila de más que la página para saber si hay más sin
    // truncar en silencio (CLAUDE.md §5: paginación sin truncado silencioso).
    const { data, error } = await sb
      .from('client_errors')
      .select('*')
      .is('resolved_at', null)
      .order('last_seen', { ascending: false })
      .limit(CLIENT_ERRORS_PAGE_SIZE + 1)

    if (error) {
      setFailed(true)
      setRows([])
    } else {
      setHasMore((data || []).length > CLIENT_ERRORS_PAGE_SIZE)
      setRows((data || []).slice(0, CLIENT_ERRORS_PAGE_SIZE))
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const resolve = useCallback(async (id) => {
    setActionErr(null)
    const { error } = await sb.rpc('resolve_client_error', { p_id: id })
    if (error) {
      // Sin esto el click no hacía NADA visible cuando fallaba — y un panel
      // que ignora tus clics en silencio es peor que no tener panel.
      setActionErr(error.message)
      return
    }
    setRows((prev) => prev.filter((r) => r.id !== id))
  }, [])

  return { rows, loading, failed, hasMore, actionErr, load, resolve }
}
