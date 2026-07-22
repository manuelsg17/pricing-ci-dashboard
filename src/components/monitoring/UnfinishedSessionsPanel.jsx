import { getCityLabel } from '../../lib/constants'
import { useI18n } from '../../context/LanguageContext'

// Progreso guardado ("Guardar Progreso") sin sesión Terminada — RPC
// get_unfinished_ci_sessions (mig 147). Diagnóstico BEST-EFFORT (ver
// comentario de la migración): sirve para saber a quién preguntarle, no como
// fuente de verdad absoluta (zona legacy mezclada en datos viejos puede
// generar algún falso positivo/negativo puntual).
export default function UnfinishedSessionsPanel({ rows }) {
  const { t, locale } = useI18n()
  const fmtDate = (d) => (d ? new Date(d + 'T00:00:00').toLocaleDateString(locale) : '—')

  return (
    <div className="mon-panel">
      <div className="mon-panel__head">
        <h2>{t('monitoring.unfinished_title')}</h2>
      </div>
      <div className="mon-panel__subtitle">{t('monitoring.unfinished_subtitle')}</div>

      {rows.length === 0 ? (
        <div className="mon-empty">{t('monitoring.unfinished_empty')}</div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="de-history-table">
            <thead>
              <tr>
                <th>{t('dataentry.col_date')}</th>
                <th>{t('dataentry.col_city')}</th>
                <th>{t('monitoring.col_zone')}</th>
                <th>{t('monitoring.col_hub')}</th>
                <th>{t('monitoring.col_rows')}</th>
                <th>{t('monitoring.col_categories')}</th>
                <th>{t('monitoring.col_competitors')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.city}|${r.zone || ''}|${r.observed_date}|${r.uploaded_by}|${i}`}>
                  <td>{fmtDate(r.observed_date)}</td>
                  <td>{getCityLabel(r.city)}</td>
                  <td style={{ color: 'var(--color-muted)', fontSize: 11 }}>{r.zone || '—'}</td>
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
      )}
    </div>
  )
}
