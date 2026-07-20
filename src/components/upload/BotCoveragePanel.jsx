import { useState, useEffect, useCallback } from 'react'
import { sb } from '../../lib/supabase'
import BotCoverageMatrix from './BotCoverageMatrix'

// Panel de frescura de la data del bot por ciudad × bracket (página Bot DB
// Sync). La matriz vive en BotCoverageMatrix (compartida con la tarjeta del
// dashboard). Lee de la RPC bot_coverage_recent (mig 134). Si la RPC no está
// aplicada, la llamada falla → el panel NO renderiza nada (inerte).

export default function BotCoveragePanel({ country, t }) {
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
  }, [load])

  if (failed || !rows || rows.length === 0) return null

  return (
    <div style={{ marginTop: 20 }}>
      <h3 style={{ fontSize: 14, marginBottom: 2 }}>{t('botdbsync.coverage_title')}</h3>
      <div style={{ fontSize: 11, color: '#64748b', marginBottom: 8 }}>
        {t('botdbsync.coverage_subtitle')}
      </div>
      <BotCoverageMatrix rows={rows} t={t} />
      <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 6, fontStyle: 'italic' }}>
        {t('botdbsync.coverage_legend')}
      </div>
    </div>
  )
}
