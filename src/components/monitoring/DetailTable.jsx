import { useI18n } from '../../context/LanguageContext'

// Detalle ciudad × fecha × hub — restyle de la tabla que ya existía inline en
// Monitoring.jsx.
export default function DetailTable({ detail }) {
  const { t, locale } = useI18n()
  const fmtDate = (d) => (d ? new Date(d + 'T00:00:00').toLocaleDateString(locale) : '—')

  return (
    <div className="mon-panel">
      <div className="mon-panel__head">
        <h2>{t('monitoring.detail')}</h2>
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
                <td style={{ color: 'var(--color-muted)', fontSize: 11 }}>{r.uploaded_by}</td>
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
    </div>
  )
}
