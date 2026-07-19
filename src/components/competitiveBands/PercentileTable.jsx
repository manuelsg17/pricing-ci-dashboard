import { useI18n } from '../../context/LanguageContext'

// Tabla de percentiles P10-P90 del Δ% (Yango vs rival) + promedio.
export default function PercentileTable({ summary }) {
  const { t } = useI18n()
  if (!summary || !summary.total_observations) return null
  const cols = [
    ['P10', summary.p10],
    ['P25', summary.p25],
    [t('competitiveBands.p50_median'), summary.p50],
    ['P75', summary.p75],
    ['P90', summary.p90],
  ]

  return (
    <div className="config-section" style={{ marginBottom: 16 }}>
      <h2 style={{ margin: 0, marginBottom: 10 }}>
        {t('competitiveBands.percentile_table.title')}
      </h2>
      <table className="config-table config-table--modern">
        <thead>
          <tr>
            {cols.map(([label]) => (
              <th key={label} scope="col">
                {label}
              </th>
            ))}
            <th scope="col">{t('competitiveBands.percentile_table.col_average')}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            {cols.map(([label, val]) => (
              <td key={label} style={{ fontWeight: 700 }}>
                {val != null ? `${val}%` : '—'}
              </td>
            ))}
            <td style={{ fontWeight: 700 }}>
              {summary.avg_pct_diff != null ? `${summary.avg_pct_diff}%` : '—'}
            </td>
          </tr>
        </tbody>
      </table>
      <p style={{ fontSize: 11, color: 'var(--color-muted)', marginTop: 8, marginBottom: 0 }}>
        {t('competitiveBands.percentile_table.footer_note')}
      </p>
    </div>
  )
}
