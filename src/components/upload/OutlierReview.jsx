import { useState, useMemo } from 'react'
import { Button } from '../ui/shadcn/button'
import { useI18n } from '../../context/LanguageContext'

/**
 * OutlierReview — muestra filas con precios sospechosos antes del insert.
 * El usuario puede corregir el precio o marcar la fila como "excluir".
 *
 * Props:
 *   suspects: [{ idx, row, field, value, threshold }]
 *   onConfirm(corrections): corrections = { [idx]: { price, exclude } }
 *   onCancel()
 */
export default function OutlierReview({ suspects, onConfirm, onCancel }) {
  const { t } = useI18n()
  // Estado local: { [idx]: { price: string, exclude: bool } }
  const [edits, setEdits] = useState(() => {
    const init = {}
    suspects.forEach((s) => {
      init[s.idx] = { price: String(s.value ?? ''), exclude: false }
    })
    return init
  })
  const [search, setSearch] = useState('')

  function setPrice(idx, val) {
    setEdits((prev) => ({ ...prev, [idx]: { ...prev[idx], price: val } }))
  }
  function toggleExclude(idx) {
    setEdits((prev) => ({ ...prev, [idx]: { ...prev[idx], exclude: !prev[idx].exclude } }))
  }
  function setAllExclude(exclude) {
    setEdits((prev) => {
      const next = { ...prev }
      for (const s of suspects) {
        next[s.idx] = { ...next[s.idx], exclude }
      }
      return next
    })
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return suspects
    return suspects.filter((s) => {
      const hay =
        `${s.row.city || ''} ${s.row.category || ''} ${s.row.competition_name || ''} ${s.row.observed_date || ''} ${s.row.distance_bracket || ''}`.toLowerCase()
      return hay.includes(q)
    })
  }, [suspects, search])

  const toInclude = suspects.filter((s) => !edits[s.idx]?.exclude).length
  const toExclude = suspects.filter((s) => edits[s.idx]?.exclude).length

  return (
    <div className="outlier-review">
      <div className="outlier-review__header">
        <div className="outlier-review__icon">⚠️</div>
        <div>
          <div className="outlier-review__title">{t('upload.outlier_title')}</div>
          <div className="outlier-review__sub">
            {t('upload.outlier_sub', { n: suspects.length, count: suspects.length })}
          </div>
        </div>
      </div>

      <div className="outlier-review__toolbar">
        <input
          type="search"
          className="outlier-review__search"
          placeholder={t('upload.outlier_search_placeholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="outlier-review__bulk">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setAllExclude(true)}
            title={t('upload.outlier_exclude_all_title')}
          >
            {t('upload.outlier_exclude_all')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setAllExclude(false)}
            title={t('upload.outlier_include_all_title')}
          >
            {t('upload.outlier_include_all')}
          </Button>
        </div>
      </div>

      <div className="outlier-review__table-wrap">
        <table className="outlier-review__table">
          <thead>
            <tr>
              <th>{t('filter.city')}</th>
              <th>{t('filter.category')}</th>
              <th>{t('rawdata.col_competitor')}</th>
              <th>{t('dataentry.date')}</th>
              <th>{t('rawdata.col_bracket')}</th>
              <th>{t('upload.outlier_col_current_price')}</th>
              <th>{t('upload.outlier_col_limit')}</th>
              <th>{t('upload.outlier_col_corrected_price')}</th>
              <th>{t('upload.outlier_col_exclude')}</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td
                  colSpan={9}
                  style={{ textAlign: 'center', padding: '24px 12px', color: 'var(--color-muted)' }}
                >
                  {t('upload.outlier_no_match', { search })}
                </td>
              </tr>
            )}
            {filtered.map((s) => {
              const edit = edits[s.idx]
              return (
                <tr key={s.idx} className={edit.exclude ? 'outlier-row--excluded' : ''}>
                  <td>{s.row.city}</td>
                  <td>{s.row.category}</td>
                  <td>{s.row.competition_name}</td>
                  <td>{s.row.observed_date}</td>
                  <td>{s.row.distance_bracket || '—'}</td>
                  <td className="outlier-value">{s.value}</td>
                  <td className="outlier-threshold">≤ {s.threshold}</td>
                  <td>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      className="outlier-input"
                      value={edit.price}
                      onChange={(e) => setPrice(s.idx, e.target.value)}
                      disabled={edit.exclude}
                      placeholder={t('upload.outlier_price_placeholder')}
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={edit.exclude}
                      onChange={() => toggleExclude(s.idx)}
                      className="outlier-checkbox"
                    />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="outlier-review__footer">
        <div className="outlier-review__summary">
          {t('upload.outlier_will_insert')} <strong>{toInclude}</strong>{' '}
          {t('upload.outlier_rows_corrected')} · {t('upload.outlier_will_exclude')}{' '}
          <strong>{toExclude}</strong> {t('upload.outlier_rows_suffix')}
        </div>
        <div className="outlier-review__actions">
          <Button
            variant="outline"
            className="hover:border-yango hover:bg-[var(--color-yango-light)] hover:text-yango"
            onClick={onCancel}
          >
            {t('app.cancel')}
          </Button>
          <Button className="bg-[#2e7d32] hover:bg-[#1b5e20]" onClick={() => onConfirm(edits)}>
            {t('upload.confirm_continue')}
          </Button>
        </div>
      </div>
    </div>
  )
}
