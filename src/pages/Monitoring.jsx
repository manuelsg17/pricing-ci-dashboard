import { useState, useEffect, useCallback, useMemo } from 'react'
import { sb } from '../lib/supabase'
import { useCountry } from '../context/CountryContext'
import { useI18n } from '../context/LanguageContext'
import { Button } from '../components/ui/shadcn/button'
import '../styles/data-entry.css'

// Monitoreo de la carga de hubs — SOLO admin. La seguridad real está en la RPC
// get_hub_monitoring (IF NOT is_admin RAISE) y en la RLS de ci_sessions (mig 140);
// esta página además se renderiza solo si isAdmin (ver App.jsx). Muestra, para un
// rango de fechas: (1) actividad por hub (filas/categorías/competidores cargados),
// (2) sesiones recientes (quién/ciudad/fecha/duración). Si la RPC falla (no admin
// / sin acceso al país) queda inerte.

function daysAgo(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}
function today() {
  return new Date().toISOString().slice(0, 10)
}

export default function Monitoring() {
  const { country } = useCountry()
  const { t, locale } = useI18n()

  const [from, setFrom] = useState(() => daysAgo(7))
  const [to, setTo] = useState(() => today())
  const [rows, setRows] = useState([])
  const [sessions, setSessions] = useState([])
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setFailed(false)
    try {
      const [{ data: mon, error: monErr }, { data: sess }] = await Promise.all([
        sb.rpc('get_hub_monitoring', { p_country: country, p_from: from, p_to: to }),
        sb
          .from('ci_sessions')
          .select('*')
          .eq('country', country)
          .gte('observed_date', from)
          .lte('observed_date', to)
          .order('started_at', { ascending: false })
          .limit(300),
      ])
      if (monErr) {
        setFailed(true)
        setRows([])
        setSessions([])
        return
      }
      setRows(Array.isArray(mon) ? mon : [])
      setSessions(Array.isArray(sess) ? sess : [])
    } catch {
      setFailed(true)
      setRows([])
      setSessions([])
    } finally {
      setLoading(false)
    }
  }, [country, from, to])

  useEffect(() => {
    load()
  }, [load])

  // Resumen por hub: total de filas, ciudades y días distintos en el rango.
  const byHub = useMemo(() => {
    const m = {}
    for (const r of rows) {
      const key = r.uploaded_by || '(sin dueño)'
      if (!m[key]) m[key] = { hub: key, n_rows: 0, cities: new Set(), days: new Set() }
      m[key].n_rows += Number(r.n_rows) || 0
      m[key].cities.add(r.city)
      m[key].days.add(r.observed_date)
    }
    return Object.values(m)
      .map((h) => ({ hub: h.hub, n_rows: h.n_rows, n_cities: h.cities.size, n_days: h.days.size }))
      .sort((a, b) => b.n_rows - a.n_rows)
  }, [rows])

  const totalRows = useMemo(() => byHub.reduce((s, h) => s + h.n_rows, 0), [byHub])

  // Detalle (ciudad × fecha × hub) ordenado por fecha desc y filas desc.
  const detail = useMemo(
    () =>
      [...rows].sort(
        (a, b) =>
          String(b.observed_date).localeCompare(String(a.observed_date)) ||
          (Number(b.n_rows) || 0) - (Number(a.n_rows) || 0)
      ),
    [rows]
  )

  const fmtDate = (d) => (d ? new Date(d + 'T00:00:00').toLocaleDateString(locale) : '—')
  const fmtTime = (iso) =>
    iso ? new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) : '—'

  return (
    <div className="de-page">
      <div className="de-header">
        <div className="de-header__left">
          <h1>{t('monitoring.title')}</h1>
        </div>
      </div>

      <div className="de-session-bar" style={{ alignItems: 'flex-end' }}>
        <div className="de-session-controls">
          <label className="de-ctrl">
            <span>{t('filter.from')}</span>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="de-ctrl">
            <span>{t('filter.to')}</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <Button size="sm" onClick={load} disabled={loading}>
            {loading ? t('dataentry.searching') : t('dataentry.search')}
          </Button>
        </div>
      </div>

      {failed ? (
        <div className="de-msg de-msg--err">{t('monitoring.failed')}</div>
      ) : (
        <>
          {/* Resumen por hub */}
          <div style={{ margin: '14px 0 6px', fontWeight: 700, fontSize: 14 }}>
            {t('monitoring.by_hub')}{' '}
            <span style={{ color: '#94a3b8', fontWeight: 500, fontSize: 12 }}>
              {t('monitoring.total_rows', { n: totalRows })}
            </span>
          </div>
          {byHub.length === 0 ? (
            <div style={{ fontSize: 13, color: '#94a3b8', padding: '8px 0' }}>
              {t('monitoring.no_data')}
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table className="de-history-table">
                <thead>
                  <tr>
                    <th>{t('monitoring.col_hub')}</th>
                    <th>{t('monitoring.col_rows')}</th>
                    <th>{t('monitoring.col_cities')}</th>
                    <th>{t('monitoring.col_days')}</th>
                  </tr>
                </thead>
                <tbody>
                  {byHub.map((h) => (
                    <tr key={h.hub}>
                      <td>{h.hub}</td>
                      <td>
                        <strong>{h.n_rows}</strong>
                      </td>
                      <td>{h.n_cities}</td>
                      <td>{h.n_days}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Detalle ciudad × fecha × hub */}
          <div style={{ margin: '18px 0 6px', fontWeight: 700, fontSize: 14 }}>
            {t('monitoring.detail')}
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="de-history-table">
              <thead>
                <tr>
                  <th>{t('dataentry.col_date')}</th>
                  <th>{t('dataentry.col_city')}</th>
                  <th>{t('monitoring.col_hub')}</th>
                  <th>{t('monitoring.col_rows')}</th>
                  <th>{t('monitoring.col_categories')}</th>
                  <th>{t('monitoring.col_competitors')}</th>
                </tr>
              </thead>
              <tbody>
                {detail.map((r, i) => (
                  <tr key={`${r.city}|${r.observed_date}|${r.uploaded_by}|${i}`}>
                    <td>{fmtDate(r.observed_date)}</td>
                    <td>{r.city}</td>
                    <td style={{ color: '#64748b', fontSize: 11 }}>{r.uploaded_by}</td>
                    <td>
                      <strong>{Number(r.n_rows) || 0}</strong>
                    </td>
                    <td>{Number(r.n_categories) || 0}</td>
                    <td>{Number(r.n_competitors) || 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Sesiones recientes */}
          <div style={{ margin: '18px 0 6px', fontWeight: 700, fontSize: 14 }}>
            {t('monitoring.sessions')}
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="de-history-table">
              <thead>
                <tr>
                  <th>{t('dataentry.col_date')}</th>
                  <th>{t('dataentry.col_city')}</th>
                  <th>{t('dataentry.col_user')}</th>
                  <th>{t('dataentry.col_start')}</th>
                  <th>{t('dataentry.col_end')}</th>
                  <th>{t('dataentry.col_duration')}</th>
                  <th>{t('dataentry.col_obs')}</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id}>
                    <td>{fmtDate(s.observed_date)}</td>
                    <td>{s.city}</td>
                    <td style={{ color: '#64748b', fontSize: 11 }}>{s.user_email || '—'}</td>
                    <td>{fmtTime(s.started_at)}</td>
                    <td>{fmtTime(s.ended_at)}</td>
                    <td>
                      <strong>{s.duration_minutes} min</strong>
                    </td>
                    <td>{s.rows_saved}</td>
                  </tr>
                ))}
                {sessions.length === 0 && (
                  <tr>
                    <td colSpan={7} style={{ color: '#94a3b8', fontSize: 13 }}>
                      {t('monitoring.no_sessions')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
