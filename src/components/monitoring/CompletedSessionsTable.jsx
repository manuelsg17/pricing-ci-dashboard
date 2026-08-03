import { getCityLabel } from '../../lib/constants'
import { turnoBreakdownLabel } from '../../lib/timing'
import { useI18n } from '../../context/LanguageContext'

// Sesiones completadas (ci_sessions) — restyle de la tabla que ya existía en
// Monitoring.jsx, ahora mostrando el distrito TukTuk cuando aplica (columna
// `zone`, mig 144).
export default function CompletedSessionsTable({ sessions, total }) {
  const { t, locale } = useI18n()
  const fmtDate = (d) => (d ? new Date(d + 'T00:00:00').toLocaleDateString(locale) : '—')
  // Fecha corta + hora (no solo hora, pedido real 2026-07-25): la tabla ya
  // está ordenada por started_at DESC (useMonitoringData.js), pero la columna
  // FECHA muestra observed_date (la fecha de LOS DATOS, no de cuándo se
  // cerró la sesión) — pueden no coincidir. Mostrar la fecha real de
  // Inicio/Fin deja ver a simple vista que el orden descendente sí es
  // correcto, en vez de "parecer" desordenado por mirar solo observed_date.
  const fmtDateTime = (iso) =>
    iso
      ? new Date(iso).toLocaleString(locale, {
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        })
      : '—'

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
              <th title={t('monitoring.duration_hint')}>{t('dataentry.col_duration')}</th>
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
                <td>{fmtDateTime(s.started_at)}</td>
                <td>{fmtDateTime(s.ended_at)}</td>
                <td>
                  {/* null = no se pudo medir (ver sessionDuration.js): mismo
                      "—" que el resto de las columnas sin dato, nunca "0 min". */}
                  <strong>{s.duration_minutes == null ? '—' : `${s.duration_minutes} min`}</strong>
                  {s.turno_timings && typeof s.turno_timings === 'object' && (
                    <div className="de-history-note">{turnoBreakdownLabel(s.turno_timings)}</div>
                  )}
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
      {/* Truncado EXPLÍCITO (CLAUDE.md §5). El .limit(300) del hook cortaba la
          lista sin decirlo: con 90 días de rango, un hub de bajo volumen cuya
          única sesión quedó fuera del top-300 aparecía con Frescura "nunca" —
          un corte de paginación leído como un diagnóstico de gestión. */}
      {typeof total === 'number' && total > sessions.length && (
        <p className="mon-panel__note is-warn">
          {t('monitoring.sessions_truncated', { shown: sessions.length, total })}
        </p>
      )}
    </div>
  )
}
