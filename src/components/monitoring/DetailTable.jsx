import { useI18n } from '../../context/LanguageContext'

// Detalle ciudad × fecha × hub — restyle de la tabla que ya existía inline en
// Monitoring.jsx. Inicio/Fin/Filas-disponibles (mig 155) salen de ci_sessions
// vía get_hub_monitoring — NULL en sesiones previas a la migración o sin
// ci_sessions asociada (fila legacy sin dueño).
export default function DetailTable({ detail }) {
  const { t, locale } = useI18n()
  const fmtDate = (d) => (d ? new Date(d + 'T00:00:00').toLocaleDateString(locale) : '—')
  const fmtTime = (ts) =>
    ts ? new Date(ts).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) : '—'

  return (
    <div className="mon-panel">
      <div className="mon-panel__head">
        <h2>{t('monitoring.detail')}</h2>
      </div>
      <div className="mon-table-scroll">
        <table className="de-history-table">
          <thead>
            <tr>
              <th>{t('dataentry.col_date')}</th>
              <th>{t('dataentry.col_city')}</th>
              <th>{t('monitoring.col_hub')}</th>
              <th>{t('dataentry.col_start')}</th>
              <th>{t('dataentry.col_end')}</th>
              <th>{t('monitoring.col_rows')}</th>
              <th>{t('monitoring.col_available')}</th>
              <th>{t('monitoring.col_categories')}</th>
              <th>{t('monitoring.col_competitors')}</th>
            </tr>
          </thead>
          <tbody>
            {detail.map((r, i) => (
              <tr key={`${r.city}|${r.observed_date}|${r.uploaded_by}|${i}`}>
                <td>{fmtDate(r.observed_date)}</td>
                <td>{r.city}</td>
                <td style={{ color: 'var(--color-muted)', fontSize: 11 }}>{r.uploaded_by}</td>
                <td>{fmtTime(r.started_at)}</td>
                <td>{fmtTime(r.ended_at)}</td>
                <td>
                  <strong>{Number(r.n_rows) || 0}</strong>
                </td>
                <td style={{ color: 'var(--color-muted)', fontSize: 11 }}>
                  {r.total_expected != null ? Number(r.total_expected) : '—'}
                </td>
                <td>{Number(r.n_categories) || 0}</td>
                <td>{Number(r.n_competitors) || 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
