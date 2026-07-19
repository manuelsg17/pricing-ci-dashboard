import { useI18n } from '../../context/LanguageContext'

// Columnas a mostrar en el preview (subconjunto de las 45 columnas)
const PREVIEW_COLS = [
  { key: 'observed_date', labelKey: 'dataentry.date' },
  { key: 'city', labelKey: 'filter.city' },
  { key: 'category', labelKey: 'filter.category' },
  { key: 'zone', labelKey: 'filter.zone' },
  { key: 'competition_name', labelKey: 'rawdata.col_competitor' },
  { key: 'distance_km', labelKey: 'rawdata.col_dist_km' },
  { key: '_bracket_computed', labelKey: 'upload.preview_col_bracket', computed: true },
  { key: 'timeslot', labelKey: 'upload.col_timeslot' },
  { key: 'surge', labelKey: 'filter.surge' },
  { key: 'price_without_discount', labelKey: 'upload.preview_col_price_no_disc' },
  { key: 'bid_1', labelKey: 'rawdata.col_bid_1' },
  { key: 'bid_2', labelKey: 'rawdata.col_bid_2' },
  { key: 'bid_3', labelKey: 'rawdata.col_bid_3' },
  { key: '_effective_price', labelKey: 'upload.preview_col_effective_price', computed: true },
]

export default function PreviewTable({ rows }) {
  const { t } = useI18n()
  if (!rows || rows.length === 0) return null

  return (
    <div className="preview-section">
      <h2>{t('upload.preview_title', { n: rows.length })}</h2>
      <div className="preview-wrap">
        <table className="preview-table">
          <thead>
            <tr>
              {PREVIEW_COLS.map((c) => (
                <th key={c.key} className={c.computed ? 'col-computed' : ''}>
                  {t(c.labelKey)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                {PREVIEW_COLS.map((c) => (
                  <td key={c.key} className={c.computed ? 'col-computed' : ''}>
                    {row[c.key] !== null && row[c.key] !== undefined ? String(row[c.key]) : '—'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
