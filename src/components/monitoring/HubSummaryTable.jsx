import { useI18n } from '../../context/LanguageContext'

// Resumen por hub (filas/ciudades/días en el rango) + frescura: hace cuánto
// terminó su sesión completada más reciente (de `sessions`, ver
// useMonitoringData). null = nunca terminó una sesión en el rango elegido.
function freshnessLabel(lastEndedAt, t) {
  if (!lastEndedAt) return t('monitoring.freshness_never')
  const s = Math.max(0, Math.floor((Date.now() - lastEndedAt) / 1000))
  if (s < 60) return t('common.bot_freshness.time_ago_lt1min')
  const m = Math.floor(s / 60)
  if (m < 60) return t('common.bot_freshness.time_ago_min', { n: m })
  const h = Math.floor(m / 60)
  if (h < 24) return t('common.bot_freshness.time_ago_hours', { n: h })
  return t('common.bot_freshness.time_ago_days', { n: Math.floor(h / 24) })
}

export default function HubSummaryTable({ byHub, totalRows }) {
  const { t } = useI18n()

  return (
    <div className="mon-panel">
      <div className="mon-panel__head">
        <h2>{t('monitoring.by_hub')}</h2>
        <span className="mon-panel__hint">{t('monitoring.total_rows', { n: totalRows })}</span>
      </div>

      {byHub.length === 0 ? (
        <div className="mon-empty">{t('monitoring.no_data')}</div>
      ) : (
        <div className="mon-table-scroll">
          <table className="de-history-table">
            <thead>
              <tr>
                <th>{t('monitoring.col_hub')}</th>
                <th>{t('monitoring.col_rows')}</th>
                <th>{t('monitoring.col_cities')}</th>
                <th>{t('monitoring.col_days')}</th>
                <th>{t('monitoring.freshness_title')}</th>
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
                  <td style={{ color: 'var(--color-muted)', fontSize: 12 }}>
                    {freshnessLabel(h.lastEndedAt, t)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
