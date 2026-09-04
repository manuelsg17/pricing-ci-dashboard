import { useState, useEffect, useCallback } from 'react'
import { sb } from '../lib/supabase'

// Lecturas del bot para el dashboard (patrón único de datos, 2026-09). Mismas
// consultas, mismos intervalos y mismo manejo de errores que tenían
// BotCoverageCard.jsx y Dashboard.jsx — solo cambiaron de archivo.

// Frescura de la data del bot (RPC bot_coverage_recent, mig 134). Refresca
// cada 5 min mientras el componente está montado. `rows === null` = sin data
// o RPC caída (ver `failed`); la tarjeta decide no renderizar nada.
export function useBotCoverageRecent(country) {
  const [rows, setRows] = useState(null)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    try {
      const { data, error } = await sb.rpc('bot_coverage_recent', { p_country: country })
      if (error) {
        setFailed(true)
        setRows(null)
        return
      }
      setFailed(false)
      setRows(Array.isArray(data) ? data : [])
    } catch {
      setFailed(true)
      setRows(null)
    }
  }, [country])

  useEffect(() => {
    load()
    // refresca cada 5 min mientras el dashboard está abierto
    const iv = setInterval(load, 5 * 60_000)
    return () => clearInterval(iv)
  }, [load])

  return { rows, failed }
}

// Outliers acumulados en las corridas de bot_sync_log de los últimos 7 días.
// `null` hasta que responde la primera consulta.
export function useBotOutlierTotal(country) {
  const [outlierTotal, setOutlierTotal] = useState(null)
  useEffect(() => {
    let cancelled = false
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000).toISOString()
    sb.from('bot_sync_log')
      .select('outlier_count')
      .eq('country', country)
      .gte('started_at', sevenDaysAgo)
      .then(({ data }) => {
        if (cancelled) return
        const total = (data || []).reduce((s, r) => s + (r.outlier_count || 0), 0)
        setOutlierTotal(total)
      })
    return () => {
      cancelled = true
    }
  }, [country])
  return outlierTotal
}
