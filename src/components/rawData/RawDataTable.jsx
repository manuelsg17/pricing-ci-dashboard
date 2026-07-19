import { BRACKET_LABELS } from '../../lib/constants'
import { Button } from '../ui/shadcn/button'
import { useI18n } from '../../context/LanguageContext'

function fmt(val, decimals = 2) {
  if (val === null || val === undefined || val === '') return '—'
  const n = parseFloat(val)
  return isNaN(n) ? String(val) : n.toFixed(decimals)
}

const isYangoRow = (r) => r.competition_name && r.competition_name.toLowerCase().startsWith('yango')

export default function RawDataTable({
  rows,
  loading,
  config,
  outlierThreshold,
  editingId,
  editField,
  editValue,
  setEditValue,
  startEdit,
  cancelEdit,
  handleEditKeyDown,
  handleDelete,
  exporting,
}) {
  const { t } = useI18n()
  const isOutlierRow = (r) =>
    parseFloat(r.price_without_discount) > outlierThreshold ||
    parseFloat(r.price_with_discount) > outlierThreshold ||
    parseFloat(r.recommended_price) > outlierThreshold ||
    parseFloat(r.minimal_bid) > outlierThreshold

  const renderEditable = (r, field, decimals = 2) => {
    if (editingId === r.id && editField === field) {
      return (
        <input
          autoFocus
          type="number"
          step="any"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={(e) => handleEditKeyDown(e, r.id, field)}
          onBlur={cancelEdit}
          style={{ width: '60px', padding: '2px' }}
        />
      )
    }
    return (
      <span
        onDoubleClick={() => startEdit(r.id, field, r[field])}
        style={{ cursor: 'pointer' }}
        title={t('rawdata.edit_hint_title')}
      >
        {fmt(r[field], decimals)}
      </span>
    )
  }

  return (
    <div className="raw-data__table-wrap">
      <table className="raw-data__table">
        <thead>
          {/* Column group headers */}
          <tr>
            <th colSpan={2} className="col-year">
              {t('rawdata.col_group_time')}
            </th>
            <th colSpan={2} className="col-date">
              {t('rawdata.col_group_datetime')}
            </th>
            <th colSpan={2} className="col-rush">
              {t('rawdata.col_group_flags')}
            </th>
            <th colSpan={2} className="col-cat">
              {t('rawdata.col_group_service')}
            </th>
            <th className="col-source">{t('filter.source')}</th>
            <th colSpan={3} className="col-bracket">
              {t('rawdata.col_group_route')}
            </th>
            <th colSpan={2} className="col-point">
              {t('rawdata.col_group_points')}
            </th>
            <th colSpan={4} className="col-price">
              {t('rawdata.col_group_prices', { currency: config.currency })}
            </th>
            <th colSpan={3} className="col-bid">
              {t('rawdata.col_group_bids')}
            </th>
            <th className="col-eta">{t('rawdata.col_eta')}</th>
            <th className="col-actions"></th>
          </tr>
          {/* Column labels */}
          <tr>
            <th className="col-year">{t('rawdata.col_year')}</th>
            <th className="col-week">{t('rawdata.col_week')}</th>
            <th className="col-date">{t('dataentry.date')}</th>
            <th className="col-time">{t('rawdata.col_time')}</th>
            <th className="col-rush">{t('rawdata.col_rush')}</th>
            <th className="col-surge">{t('filter.surge')}</th>
            <th className="col-cat">{t('filter.category')}</th>
            <th className="col-comp">{t('rawdata.col_competitor')}</th>
            <th className="col-source">{t('filter.source')}</th>
            <th className="col-bracket">{t('rawdata.col_bracket')}</th>
            <th className="col-zone">{t('filter.zone')}</th>
            <th className="col-price">{t('rawdata.col_dist_km')}</th>
            <th className="col-point">{t('dataentry.col_point_a')}</th>
            <th className="col-point">{t('dataentry.col_point_b')}</th>
            <th className="col-price">{t('rawdata.col_price_no_disc')}</th>
            <th className="col-price">{t('rawdata.col_price_disc')}</th>
            <th className="col-price">{t('rawdata.col_recommended')}</th>
            <th className="col-price">{t('rawdata.col_min_bid')}</th>
            <th className="col-bid">{t('rawdata.col_bid_1')}</th>
            <th className="col-bid">{t('rawdata.col_bid_2')}</th>
            <th className="col-bid">{t('rawdata.col_bid_3')}</th>
            <th className="col-eta">{t('rawdata.col_eta_min')}</th>
            <th className="col-actions"></th>
          </tr>
        </thead>
        <tbody>
          {loading && rows.length === 0 && (
            <tr>
              <td colSpan={26} className="raw-data__state">
                {t('rawdata.loading_data')}
              </td>
            </tr>
          )}
          {!loading && rows.length === 0 && (
            <tr>
              <td colSpan={26} className="raw-data__state">
                {t('rawdata.no_rows')}
              </td>
            </tr>
          )}
          {rows.map((r, i) => (
            <tr
              key={r.id ?? i}
              className={[
                isYangoRow(r) ? 'raw-data__row--yango' : '',
                isOutlierRow(r) ? 'raw-data__row--outlier' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <td className="col-year">{r.year ?? '—'}</td>
              <td className="col-week">{r.week ?? '—'}</td>
              <td className="col-date">{r.observed_date ?? '—'}</td>
              <td className="col-time">{r.observed_time ? r.observed_time.slice(0, 5) : '—'}</td>
              <td className="col-rush">
                {r.rush_hour === true ? (
                  <span className="badge-rush">{t('rawdata.col_rush')}</span>
                ) : r.rush_hour === false ? (
                  <span className="badge-no">—</span>
                ) : (
                  '?'
                )}
              </td>
              <td className="col-surge">
                {r.surge === true ? (
                  <span className="badge-surge">{t('filter.yes')}</span>
                ) : r.surge === false ? (
                  <span className="badge-no">{t('filter.no')}</span>
                ) : (
                  <span className="badge-no">—</span>
                )}
              </td>
              <td className="col-cat">{r.category ?? '—'}</td>
              <td
                className="col-comp"
                style={isYangoRow(r) ? { color: 'var(--color-yango)', fontWeight: 600 } : {}}
              >
                {r.competition_name ?? '—'}
              </td>
              <td className="col-source">
                {r.data_source === 'bot' ? (
                  <span className="badge-bot">{t('filter.source_bot')}</span>
                ) : (
                  <span className="badge-hub">{t('rawdata.badge_hub')}</span>
                )}
              </td>
              <td className="col-bracket">
                {r.distance_bracket ? (
                  <span className="bracket-pill">
                    {BRACKET_LABELS[r.distance_bracket] ?? r.distance_bracket}
                  </span>
                ) : (
                  <span className="badge-no">—</span>
                )}
              </td>
              <td className="col-zone">{r.zone ?? '—'}</td>
              <td className="col-price">{fmt(r.distance_km, 1)}</td>
              <td className="col-point" title={r.point_a ?? ''}>
                {r.point_a ?? '—'}
              </td>
              <td className="col-point" title={r.point_b ?? ''}>
                {r.point_b ?? '—'}
              </td>
              <td
                className={`col-price${parseFloat(r.price_without_discount) > outlierThreshold ? ' cell-outlier' : ''}`}
              >
                {renderEditable(r, 'price_without_discount')}
              </td>
              <td
                className={`col-price${parseFloat(r.price_with_discount) > outlierThreshold ? ' cell-outlier' : ''}`}
              >
                {renderEditable(r, 'price_with_discount')}
              </td>
              <td
                className={`col-price${parseFloat(r.recommended_price) > outlierThreshold ? ' cell-outlier' : ''}`}
              >
                {renderEditable(r, 'recommended_price')}
              </td>
              <td
                className={`col-price${parseFloat(r.minimal_bid) > outlierThreshold ? ' cell-outlier' : ''}`}
              >
                {renderEditable(r, 'minimal_bid')}
              </td>
              <td className="col-bid">{renderEditable(r, 'bid_1')}</td>
              <td className="col-bid">{renderEditable(r, 'bid_2')}</td>
              <td className="col-bid">{renderEditable(r, 'bid_3')}</td>
              <td className="col-eta">{fmt(r.eta_min, 1)}</td>
              <td className="col-actions">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-auto w-auto rounded-[3px] px-1 py-0.5 text-[13px] opacity-40 hover:bg-red-100 hover:opacity-100"
                  onClick={() => handleDelete(r.id)}
                  disabled={exporting}
                  title={exporting ? t('rawdata.delete_title_wait') : t('rawdata.delete_row_title')}
                >
                  🗑
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
