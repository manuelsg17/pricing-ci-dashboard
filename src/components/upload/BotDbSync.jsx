import { useState, useEffect, useCallback, useRef } from 'react'
import { Zap, Search, RotateCcw, Check, AlertTriangle, ScrollText } from 'lucide-react'
import { sb } from '../../lib/supabase'
import { useCountry } from '../../context/CountryContext'
import { useI18n } from '../../context/LanguageContext'
import { useToast } from '../ui/Toast'
import EmptyState from '../ui/EmptyState'
import { SkeletonTable } from '../ui/Skeleton'
import { useConfirm } from '../ui/ConfirmDialog'
import { Button } from '../ui/shadcn/button'

// Mapa de razones que emite scripts/bot-sync/bot_sync_push.py.
// labelKey/hintKey/actionKey → keys de i18n resueltas en el componente
// (esta tabla vive fuera del componente, sin acceso a t()).
const REASON_PILLS = {
  no_rule: {
    labelKey: 'botdbsync.reason.no_rule.label',
    bg: '#fee2e2',
    fg: '#991b1b',
    hintKey: 'botdbsync.reason.no_rule.hint',
    actionKey: 'botdbsync.reason.no_rule.action',
  },
  no_price: {
    labelKey: 'botdbsync.reason.no_price.label',
    bg: '#fef3c7',
    fg: '#78350f',
    hintKey: 'botdbsync.reason.no_price.hint',
    actionKey: 'botdbsync.reason.no_price.action',
  },
  incomplete: {
    labelKey: 'botdbsync.reason.incomplete.label',
    bg: '#fef3c7',
    fg: '#78350f',
    hintKey: 'botdbsync.reason.incomplete.hint',
    actionKey: 'botdbsync.reason.incomplete.action',
  },
  no_timestamp: {
    labelKey: 'botdbsync.reason.no_timestamp.label',
    bg: '#fef3c7',
    fg: '#78350f',
    hintKey: 'botdbsync.reason.no_timestamp.hint',
    actionKey: 'botdbsync.reason.no_timestamp.action',
  },
  outlier: {
    labelKey: 'botdbsync.reason.outlier.label',
    bg: '#e0e7ff',
    fg: '#3730a3',
    hintKey: 'botdbsync.reason.outlier.hint',
    actionKey: 'botdbsync.reason.outlier.action',
  },
}

function renderReason(reason, t) {
  const p = REASON_PILLS[reason]
  if (!p) return <span style={{ color: '#94a3b8' }}>—</span>
  return (
    <span
      title={`${t(p.hintKey)}\n\n👉 ${t(p.actionKey)}`}
      style={{
        padding: '2px 8px',
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 600,
        background: p.bg,
        color: p.fg,
        whiteSpace: 'nowrap',
        cursor: 'help',
      }}
    >
      {t(p.labelKey)}
    </span>
  )
}

// Agrupa el array dropped_combos por razón y suma filas. Devuelve
// [{ reason, total, pct, hint, action }] ordenado por total desc.
// Sirve para el summary arriba de la tabla — "tus 900 descartes son 100% sin regla"
// es info accionable; "tabla de 1 fila con jerga" no.
function summarizeReasons(combos) {
  const total = combos.reduce((s, c) => s + (c.n || 0), 0)
  if (total === 0) return { total: 0, byReason: [] }
  const map = {}
  for (const c of combos) {
    const k = c.reason || 'unknown'
    map[k] = (map[k] || 0) + (c.n || 0)
  }
  const byReason = Object.entries(map)
    .map(([reason, n]) => ({
      reason,
      n,
      pct: Math.round((n / total) * 100),
      info: REASON_PILLS[reason] || { label: reason, hint: '', action: '' },
    }))
    .sort((a, b) => b.n - a.n)
  return { total, byReason }
}

export default function BotDbSync() {
  const { country } = useCountry()
  const { t } = useI18n()
  const toast = useToast()
  const confirm = useConfirm()
  const [running, setRunning] = useState(false)
  const [probing, setProbing] = useState(false)
  const [watermark, setWatermark] = useState(null)
  const [logRows, setLogRows] = useState([])
  const [loadingLog, setLoadingLog] = useState(true)
  const [limit, setLimit] = useState(20000)
  // Combos (app, vc, ovc, city) que NO matchearon ninguna regla en la
  // última corrida ok. Permiten click-to-add a bot_rules.
  const [droppedCombos, setDroppedCombos] = useState([])
  // Timer del auto-refresh de 60s post-trigger. Lo guardamos para
  // limpiarlo si el componente unmounta antes (evita setState en unmounted).
  const autoRefreshTimerRef = useRef(null)
  useEffect(
    () => () => {
      if (autoRefreshTimerRef.current) clearTimeout(autoRefreshTimerRef.current)
    },
    []
  )

  const reload = useCallback(async () => {
    setLoadingLog(true)
    const [{ data: wm }, { data: log }] = await Promise.all([
      sb.from('bot_sync_watermark').select('*').eq('country', country).maybeSingle(),
      sb
        .from('bot_sync_log')
        .select('*')
        .eq('country', country)
        .order('started_at', { ascending: false })
        .limit(20),
    ])
    setWatermark(wm || null)
    setLogRows(log || [])
    // dropped_combos del último log ok con notes.dropped_combos no null
    const lastWithCombos = (log || []).find(
      (r) =>
        r.status === 'ok' &&
        Array.isArray(r.notes?.dropped_combos) &&
        r.notes.dropped_combos.length > 0
    )
    setDroppedCombos(lastWithCombos?.notes?.dropped_combos || [])
    setLoadingLog(false)
  }, [country])

  // Re-procesar últimos N días: retrocede el watermark vía RPC segura
  // (mig 53). No borra data. Después dispara un sync.
  async function handleResync() {
    const ok = await confirm({
      title: t('botdbsync.resync_confirm_title', { country }),
      message: t('botdbsync.resync_confirm_message'),
      confirmText: t('botdbsync.resync_confirm_btn'),
    })
    if (!ok) return
    setRunning(true)
    try {
      const { data, error } = await sb.rpc('reset_bot_watermark', {
        p_country: country,
        p_days_back: 30,
      })
      if (error) throw error
      if (data?.ok === false) {
        toast.err(t('botdbsync.watermark_fail', { reason: data.reason }))
        return
      }
      toast.ok(
        t('botdbsync.watermark_success', { date: new Date(data.new).toLocaleDateString() }),
        { duration: 6000 }
      )
      await handleSync()
    } catch (e) {
      toast.err(t('botdbsync.resync_error', { msg: e.message }))
    } finally {
      setRunning(false)
    }
  }

  useEffect(() => {
    reload()
  }, [reload])

  // Sync via GitHub Actions — dispara el workflow Bot Sync.
  // El sync corre en infraestructura de GitHub (no en Supabase) porque
  // helioho.st es muy lento para queries en vivo desde Supabase.
  async function handleSync() {
    setRunning(true)
    try {
      const {
        data: { session },
      } = await sb.auth.getSession()
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
      const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
      const res = await fetch(`${supabaseUrl}/functions/v1/trigger-bot-sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: anonKey,
          Authorization: session?.access_token
            ? `Bearer ${session.access_token}`
            : `Bearer ${anonKey}`,
        },
        body: JSON.stringify({
          limit: Number(limit) || 20000,
          probe_only: false,
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || json?.ok === false) {
        const hint = json?.hint ? ` (${json.hint})` : ''
        throw new Error((json?.error || `HTTP ${res.status}`) + hint)
      }
      toast.ok(t('botdbsync.sync_triggered_toast'), { duration: 8000 })
      // Auto-refresh la tabla de corridas en 60s — guardamos el id en
      // ref por si el user navega antes de que dispare.
      if (autoRefreshTimerRef.current) clearTimeout(autoRefreshTimerRef.current)
      autoRefreshTimerRef.current = setTimeout(() => reload(), 60_000)
    } catch (e) {
      toast.err(t('botdbsync.sync_trigger_error', { msg: e.message }), { duration: 12000 })
    } finally {
      setRunning(false)
    }
  }

  // Dispara el workflow en modo probe (lista columnas, no inserta nada).
  // Útil para confirmar que el job de GitHub Actions sigue funcionando
  // sin meter data nueva.
  async function handleProbe() {
    setProbing(true)
    try {
      const {
        data: { session },
      } = await sb.auth.getSession()
      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
      const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY
      const res = await fetch(`${supabaseUrl}/functions/v1/trigger-bot-sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: anonKey,
          Authorization: session?.access_token
            ? `Bearer ${session.access_token}`
            : `Bearer ${anonKey}`,
        },
        body: JSON.stringify({ limit: 100, probe_only: true }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || json?.ok === false) {
        throw new Error(json?.error || `HTTP ${res.status}`)
      }
      toast.ok(t('botdbsync.probe_triggered_toast'), {
        duration: 7000,
      })
    } catch (e) {
      toast.err(t('botdbsync.probe_trigger_error', { msg: e.message }), { duration: 10000 })
    } finally {
      setProbing(false)
    }
  }

  return (
    <div style={{ marginTop: 12 }}>
      <div className="config-section">
        <h2>{t('botdbsync.title')}</h2>
        <p style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 12 }}>
          {t('botdbsync.desc')}
        </p>

        <div
          style={{
            marginBottom: 14,
            padding: 12,
            borderRadius: 8,
            background: '#ecfdf5',
            border: '1px solid #10b981',
            fontSize: 12,
            color: '#065f46',
          }}
        >
          <strong>
            <Check size={13} className="inline align-text-bottom" />{' '}
            {t('botdbsync.github_mode_title')}
          </strong>{' '}
          — {t('botdbsync.github_mode_desc')}
        </div>

        <div
          style={{
            display: 'flex',
            gap: 12,
            alignItems: 'center',
            background: '#f8fafc',
            padding: 12,
            borderRadius: 8,
            border: '1px solid #e2e8f0',
            marginBottom: 16,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ fontSize: 12 }}>
            <strong>{t('botdbsync.country_label')}</strong> {country}
          </div>
          <div style={{ fontSize: 12, color: '#475569' }}>
            <strong>{t('botdbsync.last_sync_label')}</strong>{' '}
            {watermark?.last_synced_at
              ? new Date(watermark.last_synced_at).toLocaleString()
              : t('botdbsync.never')}
          </div>
        </div>

        {/* Acciones principales */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
          <Button
            onClick={() => handleSync()}
            disabled={running}
            title={t('botdbsync.sync_button_title')}
          >
            {running ? (
              t('botdbsync.triggering')
            ) : (
              <>
                <Zap size={14} /> {t('botdbsync.sync_now_btn')}
              </>
            )}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="border-slate-300"
            onClick={handleProbe}
            disabled={probing}
            title={t('botdbsync.probe_button_title')}
          >
            {probing ? (
              t('botdbsync.triggering')
            ) : (
              <>
                <Search size={14} /> {t('botdbsync.probe_btn')}
              </>
            )}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="border-amber-500 bg-amber-50 text-amber-900 hover:bg-amber-100 hover:text-amber-900"
            onClick={handleResync}
            disabled={running}
            title={t('botdbsync.resync_button_title')}
          >
            <RotateCcw size={14} /> {t('botdbsync.resync_btn')}
          </Button>
          <label
            style={{
              fontSize: 11,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              marginLeft: 'auto',
            }}
          >
            {t('botdbsync.limit_per_run')}
            <input
              type="number"
              min="1000"
              max="100000"
              step="1000"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              style={{ width: 100 }}
            />
          </label>
        </div>

        {/* Dropped combos — filas que el sync NO insertó, con breakdown por razón */}
        {droppedCombos.length > 0 &&
          (() => {
            const { total, byReason } = summarizeReasons(droppedCombos)
            return (
              <div
                style={{
                  marginBottom: 16,
                  padding: 12,
                  borderRadius: 8,
                  background: '#fef3c7',
                  border: '1px solid #f59e0b',
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 700, color: '#78350f', marginBottom: 8 }}>
                  <AlertTriangle size={14} className="inline align-text-bottom" />{' '}
                  {t('botdbsync.dropped_title', { n: total.toLocaleString() })}
                </div>

                {/* Breakdown por razón — la info más accionable */}
                <div style={{ fontSize: 11, color: '#78350f', marginBottom: 10 }}>
                  <div style={{ marginBottom: 6, fontWeight: 600 }}>{t('botdbsync.why_label')}</div>
                  <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
                    {byReason.map((r) => (
                      <li key={r.reason}>
                        <strong>
                          {t('botdbsync.rows_pct', { n: r.n.toLocaleString(), pct: r.pct })}
                        </strong>{' '}
                        — {t(r.info.labelKey || r.reason)}.{' '}
                        <span style={{ color: '#92400e' }}>
                          {r.info.hintKey ? t(r.info.hintKey) : ''}
                        </span>{' '}
                        <em>{r.info.actionKey ? t(r.info.actionKey) : ''}</em>
                      </li>
                    ))}
                  </ul>
                </div>

                <div style={{ fontSize: 11, color: '#92400e', marginBottom: 8, fontWeight: 600 }}>
                  {t('botdbsync.detail_by_combo', { n: Math.min(droppedCombos.length, 30) })}
                </div>
                <div style={{ maxHeight: 240, overflowY: 'auto' }}>
                  <table className="config-table" style={{ fontSize: 11 }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: 'left' }} title={t('botdbsync.col_reason_title')}>
                          {t('botdbsync.col_reason_lower')}
                        </th>
                        <th style={{ textAlign: 'left' }} title={t('botdbsync.col_app_bot_title')}>
                          {t('botdbsync.col_app_bot')}
                        </th>
                        <th
                          style={{ textAlign: 'left' }}
                          title={t('botdbsync.col_cat_declared_title')}
                        >
                          {t('botdbsync.col_cat_declared')}
                        </th>
                        <th
                          style={{ textAlign: 'left' }}
                          title={t('botdbsync.col_cat_observed_title')}
                        >
                          {t('botdbsync.col_cat_observed')}
                        </th>
                        <th style={{ textAlign: 'left' }}>{t('botdbsync.col_city_lower')}</th>
                        <th style={{ textAlign: 'right' }} title={t('botdbsync.col_rows_title')}>
                          {t('botdbsync.col_rows_lower')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {droppedCombos.slice(0, 30).map((c, i) => (
                        <tr key={i}>
                          <td>{renderReason(c.reason, t)}</td>
                          <td>
                            <code>{c.app || '∅'}</code>
                          </td>
                          <td>
                            <code>{c.vc || '∅'}</code>
                          </td>
                          <td>
                            <code>{c.ovc || '*'}</code>
                          </td>
                          <td>{c.db_city || '∅'}</td>
                          <td style={{ textAlign: 'right', fontWeight: 600 }}>
                            {c.n?.toLocaleString() || '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div style={{ fontSize: 10, color: '#92400e', marginTop: 8, fontStyle: 'italic' }}>
                  {t('botdbsync.hover_hint_prefix')} <strong>↺ {t('botdbsync.resync_btn')}</strong>{' '}
                  {t('botdbsync.hover_hint_suffix')}
                </div>
              </div>
            )
          })()}

        {/* Log de corridas */}
        <h3 style={{ fontSize: 14, marginBottom: 6 }}>{t('botdbsync.recent_runs_title')}</h3>
        {loadingLog ? (
          <SkeletonTable rows={4} cols={6} />
        ) : logRows.length === 0 ? (
          <EmptyState
            icon={<ScrollText size={28} />}
            title={t('botdbsync.empty_runs_title')}
            message={t('botdbsync.empty_runs_message')}
            compact
          />
        ) : (
          <table className="config-table" style={{ marginTop: 4 }}>
            <thead>
              <tr>
                <th>{t('botdbsync.col_start')}</th>
                <th>{t('botdbsync.col_status')}</th>
                <th style={{ textAlign: 'right' }}>{t('botdbsync.col_read')}</th>
                <th style={{ textAlign: 'right' }}>{t('botdbsync.col_inserted')}</th>
                <th style={{ textAlign: 'right' }}>{t('upload.col_discarded')}</th>
                <th style={{ textAlign: 'right' }}>{t('botdbsync.col_outliers')}</th>
                <th style={{ textAlign: 'left' }}>{t('botdbsync.col_error')}</th>
              </tr>
            </thead>
            <tbody>
              {logRows.map((r) => (
                <tr key={r.id}>
                  <td style={{ fontSize: 11 }}>{new Date(r.started_at).toLocaleString()}</td>
                  <td>
                    <span
                      style={{
                        padding: '2px 8px',
                        borderRadius: 4,
                        fontSize: 11,
                        fontWeight: 600,
                        background:
                          r.status === 'ok'
                            ? '#d1fae5'
                            : r.status === 'error'
                              ? '#fee2e2'
                              : '#e0e7ff',
                        color:
                          r.status === 'ok'
                            ? '#065f46'
                            : r.status === 'error'
                              ? '#991b1b'
                              : '#3730a3',
                      }}
                    >
                      {r.status}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right' }}>{r.read_count?.toLocaleString() ?? '—'}</td>
                  <td style={{ textAlign: 'right', color: '#065f46' }}>
                    {r.inserted_count?.toLocaleString() ?? '—'}
                  </td>
                  <td style={{ textAlign: 'right', color: '#92400e' }}>
                    {r.dropped_count?.toLocaleString() ?? '—'}
                  </td>
                  <td style={{ textAlign: 'right', color: '#991b1b' }}>
                    {r.outlier_count?.toLocaleString() ?? '—'}
                  </td>
                  <td
                    style={{
                      fontSize: 10,
                      color: '#991b1b',
                      maxWidth: 280,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                    title={r.error_msg || ''}
                  >
                    {r.error_msg || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
