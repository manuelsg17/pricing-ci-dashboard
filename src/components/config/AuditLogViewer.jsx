import { useState, useEffect, useCallback, useMemo } from 'react'
import '../../styles/dashboard.css' // usa .state-box/.filter-bar/.semaforo-*: no depender de que otra página lo cargue
import { toISODate } from '../../lib/dateUtils'
import { sb } from '../../lib/supabase'
import { useI18n } from '../../context/LanguageContext'
import { useAccessControl } from '../../hooks/useAccessControl'
import { Button } from '../ui/shadcn/button'

// ════════════════════════════════════════════════════════════════════════
// AuditLogViewer — UI para audit_log (admin-only)
//
// Consume la RPC list_audit_log() de la migración 62, que aplica RLS
// (solo admin lee). Si un viewer logra cargar este tab por algún quirk
// de routing, igual ve "Access denied" porque la RPC devuelve [] sin
// is_admin().
//
// FILTROS:
//   - table_name (dropdown con tablas auditadas)
//   - user_email (text input libre)
//   - country (dropdown con países activos)
//   - action (INSERT/UPDATE/DELETE)
//   - since (date input)
//
// DIFF VIEW:
//   Modal que muestra old_data vs new_data en formato side-by-side.
//   Para UPDATE, calcula qué campos cambiaron y los resalta.
// ════════════════════════════════════════════════════════════════════════

const AUDITED_TABLES = [
  'country_config',
  'catalog_extras',
  'bot_rules',
  'distance_thresholds',
  'bracket_weights',
  'bracket_weights_by_category',
  'semaforo_config',
  'rush_hour_windows',
  'price_validation_rules',
  'indrive_config',
  'distance_references',
  'ci_timeslots',
  'competitor_commissions',
  'competitor_bonuses',
  'market_events',
  'user_profiles',
  'roles',
]

const ACTIONS = ['INSERT', 'UPDATE', 'DELETE']

export default function AuditLogViewer() {
  const { t, locale } = useI18n()
  const { isAdmin, loading: acLoading } = useAccessControl()

  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [diff, setDiff] = useState(null)

  // Filtros
  const [fTable, setFTable] = useState('')
  const [fUser, setFUser] = useState('')
  const [fCountry, setFCountry] = useState('')
  const [fAction, setFAction] = useState('')
  const [fSince, setFSince] = useState(() => {
    // Default: hoy - 7 días
    const d = new Date()
    d.setDate(d.getDate() - 7)
    return toISODate(d)
  })

  const load = useCallback(async () => {
    if (!isAdmin) return
    setLoading(true)
    setError(null)
    const sinceTs = fSince ? new Date(fSince + 'T00:00:00').toISOString() : null
    const { data, error } = await sb.rpc('list_audit_log', {
      p_table: fTable || null,
      p_user: fUser || null,
      p_country: fCountry || null,
      p_action: fAction || null,
      p_since: sinceTs,
      p_limit: 200,
      p_offset: 0,
    })
    if (error) {
      setError(error.message)
      setRows([])
    } else {
      setRows(data || [])
    }
    setLoading(false)
  }, [isAdmin, fTable, fUser, fCountry, fAction, fSince])

  useEffect(() => {
    load()
  }, [load])

  // Live: si llega audit_log nuevo, refrescar (estamos viendo audit log
  // en realtime, irónicamente vía el mismo mecanismo de la mig 62).
  useEffect(() => {
    function onChange() {
      // No queremos refetch en cada cambio (sería ruidoso); solo
      // mostramos un hint y dejamos que el admin apriete refresh.
      // En cambio dejamos que el toast del RealtimeSyncProvider hable.
    }
    window.addEventListener('config:changed', onChange)
    return () => window.removeEventListener('config:changed', onChange)
  }, [])

  const fmtTs = useCallback(
    (ts) => {
      try {
        return new Date(ts).toLocaleString(locale, {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })
      } catch {
        return ts
      }
    },
    [locale]
  )

  if (acLoading) {
    return <div className="state-box">{t('audit.loading')}</div>
  }
  if (!isAdmin) {
    return <div className="state-box state-box--error">{t('audit.access_denied')}</div>
  }

  return (
    <div className="audit-log-viewer">
      <header style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>{t('audit.title')}</h2>
        <p style={{ marginTop: 4, color: '#64748b', fontSize: 13 }}>{t('audit.desc')}</p>
      </header>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
          gap: 8,
          marginBottom: 12,
          alignItems: 'end',
        }}
      >
        <label style={{ fontSize: 12 }}>
          {t('audit.filter_table')}
          <select
            value={fTable}
            onChange={(e) => setFTable(e.target.value)}
            className="audit-input"
          >
            <option value="">{t('audit.filter_all')}</option>
            {AUDITED_TABLES.map((tbl) => (
              <option key={tbl} value={tbl}>
                {tbl}
              </option>
            ))}
          </select>
        </label>

        <label style={{ fontSize: 12 }}>
          {t('audit.filter_user')}
          <input
            value={fUser}
            onChange={(e) => setFUser(e.target.value)}
            placeholder="user@example.com"
            className="audit-input"
          />
        </label>

        <label style={{ fontSize: 12 }}>
          {t('audit.filter_country')}
          <input
            value={fCountry}
            onChange={(e) => setFCountry(e.target.value)}
            placeholder={t('config.audit.country_placeholder')}
            className="audit-input"
          />
        </label>

        <label style={{ fontSize: 12 }}>
          {t('audit.filter_action')}
          <select
            value={fAction}
            onChange={(e) => setFAction(e.target.value)}
            className="audit-input"
          >
            <option value="">{t('audit.filter_all')}</option>
            {ACTIONS.map((a) => (
              <option key={a} value={a}>
                {t(`audit.action.${a}`)}
              </option>
            ))}
          </select>
        </label>

        <label style={{ fontSize: 12 }}>
          {t('audit.filter_since')}
          <input
            type="date"
            value={fSince}
            onChange={(e) => setFSince(e.target.value)}
            className="audit-input"
          />
        </label>

        <Button
          type="button"
          variant="outline"
          className="border-slate-300 bg-slate-100 hover:bg-slate-200 text-foreground"
          onClick={load}
          disabled={loading}
        >
          {t('audit.refresh')}
        </Button>
      </div>

      {error && (
        <div className="state-box state-box--error">
          {t('app.error')}: {error}
        </div>
      )}

      {loading ? (
        <div className="state-box">{t('audit.loading')}</div>
      ) : rows.length === 0 ? (
        <div className="state-box">{t('audit.no_results')}</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="audit-table">
            <thead>
              <tr>
                <th scope="col">{t('audit.col_ts')}</th>
                <th scope="col">{t('audit.col_user')}</th>
                <th scope="col">{t('audit.col_action')}</th>
                <th scope="col">{t('audit.col_table')}</th>
                <th scope="col">{t('audit.col_country')}</th>
                <th scope="col">{t('audit.col_row_id')}</th>
                <th scope="col">{t('audit.col_session')}</th>
                <th scope="col">{t('audit.col_diff')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtTs(r.ts)}</td>
                  <td>{r.user_email || '—'}</td>
                  <td>
                    <span className={`audit-badge audit-badge--${r.action.toLowerCase()}`}>
                      {t(`audit.action.${r.action}`)}
                    </span>
                  </td>
                  <td>{r.table_name}</td>
                  <td>{r.country || '—'}</td>
                  <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{r.row_id || '—'}</td>
                  <td title={r.user_agent || ''} style={{ fontFamily: 'monospace', fontSize: 11 }}>
                    {r.session_id ? r.session_id.slice(0, 8) : '—'}
                  </td>
                  <td>
                    <Button
                      type="button"
                      variant="link"
                      className="h-auto p-0 text-xs text-blue-600 underline"
                      onClick={() => setDiff(r)}
                    >
                      {t('audit.view_diff')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {diff && <DiffModal row={diff} onClose={() => setDiff(null)} t={t} />}

      <style>{`
        .audit-input {
          display: block; width: 100%; margin-top: 2px;
          padding: 6px 8px; border: 1px solid #cbd5e1; border-radius: 4px;
          font-size: 13px;
        }
        .audit-table {
          width: 100%; border-collapse: collapse; font-size: 13px;
        }
        .audit-table th, .audit-table td {
          padding: 8px 10px; border-bottom: 1px solid #e2e8f0; text-align: left;
        }
        .audit-table th { background: #f8fafc; font-weight: 600; font-size: 12px; }
        .audit-badge {
          display: inline-block; padding: 2px 8px; border-radius: 4px;
          font-size: 11px; font-weight: 600;
        }
        .audit-badge--insert { background: #dcfce7; color: #166534; }
        .audit-badge--update { background: #dbeafe; color: #1e40af; }
        .audit-badge--delete { background: #fee2e2; color: #991b1b; }
      `}</style>
    </div>
  )
}

// ── Modal con diff old/new ────────────────────────────────────────────

function DiffModal({ row, onClose, t }) {
  const oldData = useMemo(() => row.old_data || {}, [row.old_data])
  const newData = useMemo(() => row.new_data || {}, [row.new_data])

  // Calcular qué campos cambiaron (solo para UPDATE)
  const changedKeys = useMemo(() => {
    if (row.action !== 'UPDATE') return new Set(Object.keys({ ...oldData, ...newData }))
    const keys = new Set()
    for (const k of new Set([...Object.keys(oldData), ...Object.keys(newData)])) {
      if (JSON.stringify(oldData[k]) !== JSON.stringify(newData[k])) keys.add(k)
    }
    return keys
  }, [oldData, newData, row.action])

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'white',
          borderRadius: 8,
          padding: 24,
          maxWidth: 900,
          width: '90%',
          maxHeight: '85vh',
          overflowY: 'auto',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>
            {row.action} · {row.table_name} · {row.row_id}
          </h3>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-auto w-auto p-1 text-xl leading-none"
            onClick={onClose}
          >
            ×
          </Button>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 16,
            fontSize: 12,
            fontFamily: 'monospace',
          }}
        >
          <div>
            <div style={{ fontWeight: 700, marginBottom: 6, color: '#991b1b' }}>
              {t('audit.diff_old')}
            </div>
            <pre
              style={{
                background: '#fef2f2',
                padding: 12,
                borderRadius: 4,
                maxHeight: 400,
                overflow: 'auto',
                margin: 0,
              }}
            >
              {Object.keys(oldData).length === 0
                ? '∅'
                : Object.entries(oldData)
                    .map(
                      ([k, v]) => `${changedKeys.has(k) ? '★ ' : '  '}${k}: ${JSON.stringify(v)}`
                    )
                    .join('\n')}
            </pre>
          </div>
          <div>
            <div style={{ fontWeight: 700, marginBottom: 6, color: '#166534' }}>
              {t('audit.diff_new')}
            </div>
            <pre
              style={{
                background: '#f0fdf4',
                padding: 12,
                borderRadius: 4,
                maxHeight: 400,
                overflow: 'auto',
                margin: 0,
              }}
            >
              {Object.keys(newData).length === 0
                ? '∅'
                : Object.entries(newData)
                    .map(
                      ([k, v]) => `${changedKeys.has(k) ? '★ ' : '  '}${k}: ${JSON.stringify(v)}`
                    )
                    .join('\n')}
            </pre>
          </div>
        </div>

        <div style={{ marginTop: 16, textAlign: 'right' }}>
          <Button
            type="button"
            variant="outline"
            className="border-slate-300 bg-slate-100 text-foreground"
            onClick={onClose}
          >
            {t('audit.diff_close')}
          </Button>
        </div>
      </div>
    </div>
  )
}
