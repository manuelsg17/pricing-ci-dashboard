import { useState, useEffect } from 'react'
import SaveStatusBanner from './SaveStatusBanner'

const BAND_LABELS = { green: 'Verde', yellow: 'Amarillo', red: 'Rojo' }
const BAND_COLORS = { green: '#c8e6c9', yellow: '#fff9c4', red: '#ffcdd2' }

const rowsEqual = (a, b) => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (String(a[i].min_pct ?? '') !== String(b[i].min_pct ?? '')) return false
    if (String(a[i].max_pct ?? '') !== String(b[i].max_pct ?? '')) return false
    if (String(a[i].note    ?? '') !== String(b[i].note    ?? '')) return false
  }
  return true
}

export default function SemaforoEditor({ semaforo, onSave, saving }) {
  const [rows,    setRows]    = useState([])
  const [saveMsg, setSaveMsg] = useState(null)

  useEffect(() => {
    if (semaforo.length) setRows(semaforo.map(r => ({ ...r })))
  }, [semaforo])

  const hasUnsavedChanges = rows.length > 0 && semaforo.length > 0 && !rowsEqual(rows, semaforo)

  const handleChange = (idx, field, val) => {
    setSaveMsg(null)
    setRows(prev => prev.map((r, i) => i === idx ? { ...r, [field]: val } : r))
  }

  const handleDiscard = () => {
    setSaveMsg(null)
    setRows(semaforo.map(r => ({ ...r })))
  }

  const isDirty = (idx, field) => {
    const cur = rows[idx]?.[field]
    const orig = semaforo[idx]?.[field]
    return String(cur ?? '') !== String(orig ?? '')
  }

  const handleSave = async () => {
    setSaveMsg(null)
    const clean = rows.map(({ id, ...r }) => ({
      band:    r.band,
      min_pct: r.min_pct === '' || r.min_pct === null ? null : Number(r.min_pct),
      max_pct: r.max_pct === '' || r.max_pct === null ? null : Number(r.max_pct),
      note:    r.note || null,
    }))
    try {
      await onSave(clean)
      setSaveMsg({ type: 'ok', text: 'Semáforo guardado. Los colores del dashboard reflejarán estas bandas.' })
    } catch (e) {
      setSaveMsg({ type: 'err', text: 'Error al guardar: ' + e.message })
    }
  }

  const dirtyInputStyle = {
    background:  '#fef3c7',
    borderColor: '#f59e0b',
    fontWeight:  600,
    boxShadow:   '0 0 0 2px rgba(245, 158, 11, 0.2)',
  }

  return (
    <div className="config-section">
      <h2>Semáforo — Bandas de color</h2>
      <p style={{ fontSize: 11, color: '#888', marginBottom: 10 }}>
        Define los rangos de Δ% vs Yango para cada color. Vacío = sin límite.
      </p>

      {hasUnsavedChanges && (
        <div style={{
          marginTop: 8, marginBottom: 12,
          padding: '10px 14px', borderRadius: 6,
          background: '#fef3c7', border: '1px solid #f59e0b',
          color: '#78350f', fontSize: 13, fontWeight: 500,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
        }}>
          <span>⚠ Hay cambios sin guardar</span>
          <button type="button" onClick={handleDiscard} style={{
            background: 'transparent', border: '1px solid #b45309', color: '#78350f',
            padding: '4px 10px', borderRadius: 4, fontSize: 12, cursor: 'pointer',
          }}>
            Descartar
          </button>
        </div>
      )}

      <table className="config-table">
        <thead>
          <tr>
            <th style={{ textAlign: 'left' }}>Color</th>
            <th>Δ% mínimo</th>
            <th>Δ% máximo</th>
            <th style={{ textAlign: 'left' }}>Nota</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => (
            <tr key={idx} style={{ background: BAND_COLORS[row.band] }}>
              <td style={{ fontWeight: 700 }}>{BAND_LABELS[row.band] || row.band}</td>
              <td>
                <input
                  type="number"
                  step="0.01"
                  placeholder="∞"
                  value={row.min_pct ?? ''}
                  onChange={e => handleChange(idx, 'min_pct', e.target.value)}
                  style={isDirty(idx, 'min_pct') ? dirtyInputStyle : undefined}
                />
              </td>
              <td>
                <input
                  type="number"
                  step="0.01"
                  placeholder="∞"
                  value={row.max_pct ?? ''}
                  onChange={e => handleChange(idx, 'max_pct', e.target.value)}
                  style={isDirty(idx, 'max_pct') ? dirtyInputStyle : undefined}
                />
              </td>
              <td style={{ textAlign: 'left', padding: '3px 6px' }}>
                <input
                  type="text"
                  style={{ width: 200, ...(isDirty(idx, 'note') ? dirtyInputStyle : {}) }}
                  value={row.note || ''}
                  onChange={e => handleChange(idx, 'note', e.target.value)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="config-footer" style={{ marginTop: 14 }}>
        <button
          className="btn-save"
          onClick={handleSave}
          disabled={saving || !hasUnsavedChanges}
          title={!hasUnsavedChanges ? 'No hay cambios para guardar' : undefined}
        >
          {saving ? 'Guardando…' : 'Guardar semáforo'}
        </button>
        <SaveStatusBanner status={saveMsg} onDismiss={() => setSaveMsg(null)} />
      </div>
    </div>
  )
}
