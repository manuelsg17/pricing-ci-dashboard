import { useState, useEffect } from 'react'
import SaveStatusBanner from './SaveStatusBanner'
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

export default function SemaforoEditor({ semaforo, onSave, saving }) {
  const [rows, setRows] = useState([])
  const [saveMsg, setSaveMsg] = useState(null)
  const { t } = useI18n()

  useEffect(() => {
    if (semaforo.length) setRows(semaforo.map((r) => ({ ...r })))
  }, [semaforo])

  const hasUnsavedChanges = rows.length > 0 && semaforo.length > 0 && !rowsEqual(rows, semaforo)

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
      setSaveMsg({ type: 'err', text: t('app.error_prefix') + e.message })
    }
  }

  const dirtyInputStyle = {
    background: '#fef3c7',
    borderColor: '#f59e0b',
    fontWeight: 600,
    boxShadow: '0 0 0 2px rgba(245, 158, 11, 0.2)',
  }

  return (
    <div className="config-section">
      <h2>{t('config.semaforo.title')}</h2>
      <p style={{ fontSize: 11, color: '#888', marginBottom: 10 }}>
        {t('config.semaforo.subtitle')}
      </p>

      {hasUnsavedChanges && (
        <div
          style={{
            marginTop: 8,
            marginBottom: 12,
            padding: '10px 14px',
            borderRadius: 6,
            background: '#fef3c7',
            border: '1px solid #f59e0b',
            color: '#78350f',
            fontSize: 13,
            fontWeight: 500,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <span>⚠ {t('config.semaforo.unsaved_warning')}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="bg-transparent border-[#b45309] text-[#78350f]"
            onClick={handleDiscard}
          >
            {t('config.discard_changes')}
          </Button>
        </div>
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
                  style={isDirty(idx, 'min_pct') ? dirtyInputStyle : undefined}
                />
              </td>
              <td>
                <input
                  type="number"
                  step="0.01"
                  placeholder="∞"
                  value={row.max_pct ?? ''}
                  onChange={(e) => handleChange(idx, 'max_pct', e.target.value)}
                  style={isDirty(idx, 'max_pct') ? dirtyInputStyle : undefined}
                />
              </td>
              <td style={{ textAlign: 'left', padding: '3px 6px' }}>
                <input
                  type="text"
                  style={{ width: 200, ...(isDirty(idx, 'note') ? dirtyInputStyle : {}) }}
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
          disabled={saving || !hasUnsavedChanges}
          title={!hasUnsavedChanges ? t('config.semaforo.no_changes_title') : undefined}
        >
          {saving ? t('account.saving') : t('config.semaforo.save_btn')}
        </Button>
        <SaveStatusBanner status={saveMsg} onDismiss={() => setSaveMsg(null)} />
      </div>
    </div>
  )
}
