import { useState } from 'react'
import { useCompetitorCommissions } from '../../hooks/useCompetitorCommissions'
import { DB_CITIES } from '../../lib/constants'

const CITY_OPTIONS = [{ value: '', label: 'Todas las ciudades' }, ...DB_CITIES.map(c => ({ value: c, label: c }))]

export default function CommissionsConfig() {
  const { allRows, loading, saveCommission, deleteCommission, addRow } = useCompetitorCommissions()
  const [saving, setSaving] = useState(false)
  const [msg,    setMsg]    = useState(null)
  const [edits,  setEdits]  = useState({})

  function getField(row, field) {
    return edits[row.id]?.[field] ?? row[field] ?? ''
  }
  function setField(id, field, val) {
    setEdits(prev => ({ ...prev, [id]: { ...prev[id], [field]: val } }))
  }

  async function handleSave(row) {
    setSaving(true); setMsg(null)
    const merged = { ...row, ...edits[row.id] }
    const ok = await saveCommission(merged)
    if (ok) {
      setEdits(prev => { const n = { ...prev }; delete n[row.id]; return n })
      setMsg({ type: 'ok', text: 'Guardado ✓' })
    } else {
      setMsg({ type: 'err', text: 'Error al guardar.' })
    }
    setSaving(false)
  }

  async function handleDelete(id) {
    await deleteCommission(id)
  }

  if (loading) return <div className="config-loading">Cargando comisiones…</div>

  return (
    <div className="config-section">
      <h2>Comisiones por Competidor</h2>
      <p style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 12 }}>
        Define el porcentaje de comisión que cobra cada app al conductor.
        Puedes tener un valor global (Todas las ciudades) o sobrescribirlo por ciudad.
      </p>

      {msg && (
        <div className={msg.type === 'ok' ? 'save-msg save-msg--ok' : 'save-msg save-msg--err'}>
          {msg.text}
        </div>
      )}

      <table className="config-table">
        <thead>
          <tr>
            <th>Competidor</th>
            <th>Ciudad</th>
            <th>Comisión %</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {allRows.map(row => (
            <tr key={row.id}>
              <td>
                <input
                  type="text"
                  value={getField(row, 'competitor_name')}
                  onChange={e => setField(row.id, 'competitor_name', e.target.value)}
                  placeholder="Ej: Uber"
                  style={{ width: 140 }}
                />
              </td>
              <td>
                <select
                  value={getField(row, 'city') || ''}
                  onChange={e => setField(row.id, 'city', e.target.value || null)}
                >
                  {CITY_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </td>
              <td>
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.5"
                  value={getField(row, 'commission_pct')}
                  onChange={e => setField(row.id, 'commission_pct', e.target.value)}
                  style={{ width: 80, textAlign: 'right' }}
                />
              </td>
              <td style={{ display: 'flex', gap: 6 }}>
                <button className="btn-save-sm" onClick={() => handleSave(row)} disabled={saving}>
                  Guardar
                </button>
                <button className="btn-delete-sm" onClick={() => handleDelete(row.id)}>✕</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <button className="btn-add-row" onClick={addRow} style={{ marginTop: 10 }}>
        + Agregar comisión
      </button>
    </div>
  )
}
