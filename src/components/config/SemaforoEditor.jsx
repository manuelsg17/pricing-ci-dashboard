import { useState, useEffect } from 'react'

const BAND_LABELS = { green: 'Verde', yellow: 'Amarillo', red: 'Rojo' }
const BAND_COLORS = { green: '#c8e6c9', yellow: '#fff9c4', red: '#ffcdd2' }

export default function SemaforoEditor({ semaforo, onSave, saving }) {
  const [rows,    setRows]    = useState([])
  const [saveMsg, setSaveMsg] = useState('')

  useEffect(() => {
    if (semaforo.length) setRows(semaforo.map(r => ({ ...r })))
  }, [semaforo])

  const handleChange = (idx, field, val) => {
    setRows(prev => prev.map((r, i) => i === idx ? { ...r, [field]: val } : r))
  }

  const handleSave = async () => {
    setSaveMsg('')
    const clean = rows.map(({ id, ...r }) => ({
      band:    r.band,
      min_pct: r.min_pct === '' || r.min_pct === null ? null : Number(r.min_pct),
      max_pct: r.max_pct === '' || r.max_pct === null ? null : Number(r.max_pct),
      note:    r.note || null,
    }))
    try {
      await onSave(clean)
      setSaveMsg('Guardado correctamente')
    } catch (e) {
      setSaveMsg('Error: ' + e.message)
    }
  }

  return (
    <div className="config-section">
      <h2>Semáforo — Bandas de color</h2>
      <p style={{ fontSize: 11, color: '#888', marginBottom: 10 }}>
        Define los rangos de Δ% vs Yango para cada color. Vacío = sin límite.
      </p>

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
                />
              </td>
              <td>
                <input
                  type="number"
                  step="0.01"
                  placeholder="∞"
                  value={row.max_pct ?? ''}
                  onChange={e => handleChange(idx, 'max_pct', e.target.value)}
                />
              </td>
              <td style={{ textAlign: 'left', padding: '3px 6px' }}>
                <input
                  type="text"
                  style={{ width: 200 }}
                  value={row.note || ''}
                  onChange={e => handleChange(idx, 'note', e.target.value)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="config-footer">
        <button className="btn-save" onClick={handleSave} disabled={saving}>
          {saving ? 'Guardando...' : 'Guardar semáforo'}
        </button>
        {saveMsg && (
          <span className={saveMsg.startsWith('Error') ? 'config-save-err' : 'config-save-ok'}>
            {saveMsg}
          </span>
        )}
      </div>
    </div>
  )
}
