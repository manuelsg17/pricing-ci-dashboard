import { getCityLabel } from '../../lib/constants'
import { useI18n } from '../../context/LanguageContext'

// Sesiones completadas (ci_sessions) — restyle de la tabla que ya existía en
// Monitoring.jsx, ahora mostrando el distrito TukTuk cuando aplica (columna
// `zone`, mig 144).
export default function CompletedSessionsTable({ sessions }) {
  const { t, locale } = useI18n()
  const fmtDate = (d) => (d ? new Date(d + 'T00:00:00').toLocaleDateString(locale) : '—')
  const fmtTime = (iso) =>
    iso ? new Date(iso).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) : '—'

  return (
    <div className="mon-panel">
      <div className="mon-panel__head">
        <h2>{t('monitoring.sessions')}</h2>
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
                <td>
                  {getCityLabel(s.city)}
                  {s.zone ? ` · ${s.zone}` : ''}
                </td>
                <td style={{ color: 'var(--color-muted)', fontSize: 11 }}>{s.user_email || '—'}</td>
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
                <td colSpan={7} style={{ color: 'var(--color-muted)', fontSize: 13 }}>
                  {t('monitoring.no_sessions')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
