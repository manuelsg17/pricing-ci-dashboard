import { useState, useEffect } from 'react'
import SaveStatusBanner from './SaveStatusBanner'
import UnsavedChangesBanner from './UnsavedChangesBanner'
import { dbErrorText } from '../../lib/dbErrorText'
import { useI18n } from '../../context/LanguageContext'
import { Button } from '../ui/shadcn/button'

const BAND_COLORS = { green: '#c8e6c9', yellow: '#fff9c4', red: '#ffcdd2' }

function bandLabel(band, t) {
  const key = `config.semaforo.band_${band}`
  const label = t(key)
  return label === key ? band : label
}

const rowsEqual = (a, b) => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (String(a[i].min_pct ?? '') !== String(b[i].min_pct ?? '')) return false
    if (String(a[i].max_pct ?? '') !== String(b[i].max_pct ?? '')) return false
    if (String(a[i].note ?? '') !== String(b[i].note ?? '')) return false
  }
  return true
}

export default function SemaforoEditor({ semaforo, onSave, saving, country }) {
  const [rows, setRows] = useState([])
  const [saveMsg, setSaveMsg] = useState(null)
  const { t } = useI18n()

  // Se resetea SIEMPRE que cambian las filas o el país — también cuando el
  // país nuevo no tiene bandas. Antes `if (semaforo.length)` dejaba las
  // bandas del país anterior en pantalla y "Guardar" las sembraba en el
  // país nuevo (auditoría Config 2026-09-03, B3).
  useEffect(() => {
    setRows(semaforo.map((r) => ({ ...r })))
    setSaveMsg(null)
  }, [semaforo, country])

  const hasUnsavedChanges = rows.length > 0 && !rowsEqual(rows, semaforo)
  const invalidRow = rows.find(
    (r) =>
      r.min_pct !== '' &&
      r.min_pct != null &&
      r.max_pct !== '' &&
      r.max_pct != null &&
      Number(r.min_pct) > Number(r.max_pct)
  )

  const handleChange = (idx, field, val) => {
    setSaveMsg(null)
    setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, [field]: val } : r)))
  }

  const handleDiscard = () => {
    setSaveMsg(null)
    setRows(semaforo.map((r) => ({ ...r })))
  }

  const isDirty = (idx, field) => {
    const cur = rows[idx]?.[field]
    const orig = semaforo[idx]?.[field]
    return String(cur ?? '') !== String(orig ?? '')
  }

  const handleSave = async () => {
    setSaveMsg(null)
    const clean = rows.map(({ id: _id, ...r }) => ({
      band: r.band,
      min_pct: r.min_pct === '' || r.min_pct === null ? null : Number(r.min_pct),
      max_pct: r.max_pct === '' || r.max_pct === null ? null : Number(r.max_pct),
      note: r.note || null,
    }))
    try {
      await onSave(clean)
      setSaveMsg({
        type: 'ok',
        text: t('config.semaforo.save_success'),
      })
    } catch (e) {
      setSaveMsg({ type: 'err', text: t('app.error_prefix') + dbErrorText(t, e) })
    }
  }

  return (
    <div className="config-section">
      <h2>{t('config.semaforo.title')}</h2>
      <p style={{ fontSize: 11, color: '#888', marginBottom: 10 }}>
        {t('config.semaforo.subtitle')}
      </p>

      {hasUnsavedChanges && (
        <UnsavedChangesBanner onDiscard={handleDiscard}>
          {t('config.semaforo.unsaved_warning')}
        </UnsavedChangesBanner>
      )}

      <table className="config-table">
        <thead>
          <tr>
            <th style={{ textAlign: 'left' }}>{t('config.semaforo.col_color')}</th>
            <th scope="col">{t('config.semaforo.col_min')}</th>
            <th scope="col">{t('config.semaforo.col_max')}</th>
            <th style={{ textAlign: 'left' }}>{t('config.semaforo.col_note')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => (
            <tr key={idx} style={{ background: BAND_COLORS[row.band] }}>
              <td style={{ fontWeight: 700 }}>{bandLabel(row.band, t)}</td>
              <td>
                <input
                  type="number"
                  step="0.01"
                  placeholder="∞"
                  value={row.min_pct ?? ''}
                  onChange={(e) => handleChange(idx, 'min_pct', e.target.value)}
                  className={isDirty(idx, 'min_pct') ? 'config-dirty' : undefined}
                />
              </td>
              <td>
                <input
                  type="number"
                  step="0.01"
                  placeholder="∞"
                  value={row.max_pct ?? ''}
                  onChange={(e) => handleChange(idx, 'max_pct', e.target.value)}
                  className={isDirty(idx, 'max_pct') ? 'config-dirty' : undefined}
                />
              </td>
              <td style={{ textAlign: 'left', padding: '3px 6px' }}>
                <input
                  type="text"
                  className={isDirty(idx, 'note') ? 'config-dirty' : undefined}
                  style={{ width: 200 }}
                  value={row.note || ''}
                  onChange={(e) => handleChange(idx, 'note', e.target.value)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="config-footer" style={{ marginTop: 14 }}>
        <Button
          onClick={handleSave}
          disabled={saving || !hasUnsavedChanges || !!invalidRow}
          title={
            !hasUnsavedChanges
              ? t('config.semaforo.no_changes_title')
              : invalidRow
                ? t('config.semaforo.min_gt_max_error')
                : undefined
          }
        >
          {saving ? t('account.saving') : t('config.semaforo.save_btn')}
        </Button>
        <SaveStatusBanner status={saveMsg} onDismiss={() => setSaveMsg(null)} />
      </div>
    </div>
  )
}
