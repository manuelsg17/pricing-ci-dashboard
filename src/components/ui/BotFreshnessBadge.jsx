import { useEffect, useState, useCallback } from 'react'
import { sb } from '../../lib/supabase'
import { useCountry } from '../../context/CountryContext'
import { useI18n } from '../../context/LanguageContext'

function formatRelative(t, date) {
  const minutes = Math.floor((Date.now() - date.getTime()) / 60000)
  if (minutes < 1) return t('common.bot_freshness.time_ago_lt1min')
  if (minutes < 60) return t('common.bot_freshness.time_ago_min', { n: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('common.bot_freshness.time_ago_hours', { n: hours })
  const days = Math.floor(hours / 24)
  return t('common.bot_freshness.time_ago_days', { n: days })
}

function getStatusColor(minutes) {
  if (minutes == null) return { bg: '#f1f5f9', fg: '#64748b', dot: '#94a3b8' }
  if (minutes <= 30) return { bg: '#dcfce7', fg: '#166534', dot: '#16a34a' }
  if (minutes <= 90) return { bg: '#fef9c3', fg: '#854d0e', dot: '#ca8a04' }
  return { bg: '#fee2e2', fg: '#991b1b', dot: '#dc2626' }
}

export default function BotFreshnessBadge({ variant = 'compact' }) {
  const { country } = useCountry()
  const { t } = useI18n()
  const [lastSync, setLastSync] = useState(null)
  // Última corrida SIN filtrar por status. Hasta 2026-09-03 el badge solo
  // leía status='ok': una racha de corridas fallidas (helioho caído 13 h)
  // se veía idéntica a "todo bien pero lento" — el "hace 13h" envejecía en
  // silencio sin decir nunca que algo estaba fallando.
  const [lastRun, setLastRun] = useState(null)
  const [loading, setLoading] = useState(true)
  const [, force] = useState(0)

  const reload = useCallback(async () => {
    setLoading(true)
    const base = () =>
      sb
        .from('bot_sync_log')
        .select('started_at, finished_at, status, inserted_count, read_count, error_msg')
        .eq('country', country)
        .order('started_at', { ascending: false })
        .limit(1)
    const [okRes, anyRes] = await Promise.all([
      base().eq('status', 'ok').maybeSingle(),
      base().maybeSingle(),
    ])
    setLastSync(okRes.data || null)
    setLastRun(anyRes.data || null)
    setLoading(false)
  }, [country])

  useEffect(() => {
    reload()
  }, [reload])

  // Refresh "X min ago" label every 30s (clock tick) and re-query every 5 min
  useEffect(() => {
    const tick = setInterval(() => force((n) => n + 1), 30_000)
    const refresh = setInterval(reload, 5 * 60_000)
    return () => {
      clearInterval(tick)
      clearInterval(refresh)
    }
  }, [reload])

  // Mientras carga el primer fetch, renderizamos un placeholder con la misma
  // forma del badge final para evitar layout shift en la topbar y dar señal
  // visual de "estado desconocido" en lugar de aparecer/desaparecer.
  if (loading && !lastSync) {
    const phStyle =
      variant === 'pill'
        ? {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 10px',
            borderRadius: 999,
            background: '#f1f5f9',
            color: '#94a3b8',
            fontSize: 11,
            fontWeight: 600,
            border: '1px solid #e2e8f0',
          }
        : {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            padding: '2px 8px',
            borderRadius: 4,
            background: '#f1f5f9',
            color: '#94a3b8',
            fontSize: 10,
            fontWeight: 600,
            whiteSpace: 'nowrap',
          }
    return (
      <span title={t('common.bot_freshness.loading_title')} style={phStyle} aria-busy="true">
        <span
          style={{
            width: variant === 'pill' ? 7 : 6,
            height: variant === 'pill' ? 7 : 6,
            borderRadius: '50%',
            background: '#cbd5e1',
          }}
        />
        {t('common.bot_freshness.loading_label')}
      </span>
    )
  }

  const startedAt = lastSync?.started_at ? new Date(lastSync.started_at) : null
  const minutes = startedAt ? Math.floor((Date.now() - startedAt.getTime()) / 60000) : null

  // Estado de FALLA: la corrida más reciente terminó en error (y es posterior
  // al último ok), o quedó en 'running' hace más de 20 min (el job tiene
  // timeout de 10; 'running' viejo = murió sin cerrar el log).
  const lastRunAt = lastRun?.started_at ? new Date(lastRun.started_at) : null
  const runMinutes = lastRunAt ? Math.floor((Date.now() - lastRunAt.getTime()) / 60000) : null
  const failed =
    lastRun &&
    (!startedAt || lastRunAt > startedAt) &&
    (lastRun.status === 'error' || (lastRun.status === 'running' && runMinutes > 20))

  const colors = failed ? getStatusColor(Infinity) : getStatusColor(minutes)
  const tooltip = failed
    ? t('common.bot_freshness.last_failed_tooltip', {
        date: lastRunAt.toLocaleString(),
        error: (lastRun.error_msg || t('common.bot_freshness.stuck_running')).slice(0, 140),
        last_ok: startedAt ? formatRelative(t, startedAt) : '—',
      })
    : startedAt
      ? t('common.bot_freshness.last_sync_tooltip', {
          date: startedAt.toLocaleString(),
          n: lastSync.inserted_count ?? 0,
        })
      : t('common.bot_freshness.no_runs_tooltip')
  const label = failed
    ? t('common.bot_freshness.failed_label', { time: formatRelative(t, lastRunAt) })
    : null

  if (variant === 'pill') {
    return (
      <div
        title={tooltip}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 10px',
          borderRadius: 999,
          background: colors.bg,
          color: colors.fg,
          fontSize: 11,
          fontWeight: 600,
          border: `1px solid ${colors.dot}40`,
        }}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: colors.dot,
            boxShadow: `0 0 0 2px ${colors.dot}30`,
          }}
        />
        {label ??
          t('common.bot_freshness.label', {
            time: startedAt
              ? formatRelative(t, startedAt)
              : t('common.bot_freshness.no_runs_short'),
          })}
      </div>
    )
  }

  return (
    <span
      title={tooltip}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '2px 8px',
        borderRadius: 4,
        background: colors.bg,
        color: colors.fg,
        fontSize: 10,
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: colors.dot }} />
      {label ??
        t('common.bot_freshness.label', { time: startedAt ? formatRelative(t, startedAt) : '—' })}
    </span>
  )
}
