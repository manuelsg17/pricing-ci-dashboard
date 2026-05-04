import { useEffect, useState, useCallback } from 'react'
import { sb } from '../../lib/supabase'
import { useCountry } from '../../context/CountryContext'

function formatRelative(date) {
  const minutes = Math.floor((Date.now() - date.getTime()) / 60000)
  if (minutes < 1)  return 'hace <1 min'
  if (minutes < 60) return `hace ${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `hace ${hours}h`
  const days = Math.floor(hours / 24)
  return `hace ${days}d`
}

function getStatusColor(minutes) {
  if (minutes == null) return { bg: '#f1f5f9', fg: '#64748b', dot: '#94a3b8' }
  if (minutes <= 30)   return { bg: '#dcfce7', fg: '#166534', dot: '#16a34a' }
  if (minutes <= 90)   return { bg: '#fef9c3', fg: '#854d0e', dot: '#ca8a04' }
  return { bg: '#fee2e2', fg: '#991b1b', dot: '#dc2626' }
}

export default function BotFreshnessBadge({ variant = 'compact' }) {
  const { country } = useCountry()
  const [lastSync, setLastSync] = useState(null)
  const [loading, setLoading]   = useState(true)
  const [, force] = useState(0)

  const reload = useCallback(async () => {
    setLoading(true)
    const { data } = await sb
      .from('bot_sync_log')
      .select('started_at, finished_at, status, inserted_count, read_count')
      .eq('country', country)
      .eq('status', 'ok')
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    setLastSync(data || null)
    setLoading(false)
  }, [country])

  useEffect(() => { reload() }, [reload])

  // Refresh "X min ago" label every 30s (clock tick) and re-query every 5 min
  useEffect(() => {
    const tick = setInterval(() => force(n => n + 1), 30_000)
    const refresh = setInterval(reload, 5 * 60_000)
    return () => { clearInterval(tick); clearInterval(refresh) }
  }, [reload])

  if (loading && !lastSync) return null

  const startedAt = lastSync?.started_at ? new Date(lastSync.started_at) : null
  const minutes = startedAt ? Math.floor((Date.now() - startedAt.getTime()) / 60000) : null
  const colors = getStatusColor(minutes)
  const tooltip = startedAt
    ? `Última sync OK del bot: ${startedAt.toLocaleString()} · ${lastSync.inserted_count ?? 0} filas insertadas`
    : 'Sin corridas exitosas del bot todavía'

  if (variant === 'pill') {
    return (
      <div
        title={tooltip}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '4px 10px', borderRadius: 999,
          background: colors.bg, color: colors.fg,
          fontSize: 11, fontWeight: 600,
          border: `1px solid ${colors.dot}40`,
        }}
      >
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: colors.dot, boxShadow: `0 0 0 2px ${colors.dot}30` }} />
        Bot {startedAt ? formatRelative(startedAt) : 'sin corridas'}
      </div>
    )
  }

  return (
    <span
      title={tooltip}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        padding: '2px 8px', borderRadius: 4,
        background: colors.bg, color: colors.fg,
        fontSize: 10, fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: colors.dot }} />
      Bot {startedAt ? formatRelative(startedAt) : '—'}
    </span>
  )
}
