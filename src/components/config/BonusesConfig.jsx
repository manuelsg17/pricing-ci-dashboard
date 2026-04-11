import { useState } from 'react'
import { useCompetitorBonuses } from '../../hooks/useCompetitorBonuses'
import { DB_CITIES, COMPETITOR_COLORS } from '../../lib/constants'

const CITY_OPTIONS = [{ value: '', label: 'Todas' }, ...DB_CITIES.map(c => ({ value: c, label: c }))]
const ALL_COMPETITORS = Object.keys(COMPETITOR_COLORS)
const TYPE_OPTIONS = [
  { value: 'viajes', label: 'Viajes' },
  { value: 'horas',  label: 'Horas' },
  { value: 'zona',   label: 'Zona' },
]

export default function BonusesConfig() {
  const { allRows, loading, saveBonus, deleteBonus, addRow } = useCompetitorBonuses()
  const [saving, setSaving] = useState(false)
  const [msg,    setMsg]    = useState(null)
  const [edits,  setEdits]  = useState({})

  function getField(row, field) {
    return edits[row.id]?.[field] ?? row[field] ?? ''
  }
  function setField(id, field, val) {
    setEdits(prev => ({ ...prev, [id]: { ...prev[id], [field]: val } }))
  }
  function getActive(row) {
    return edits[row.id]?.is_active ?? row.is_active ?? true
  }

  async function handleSave(row) {
    setSaving(true); setMsg(null)
    const merged = { ...row, ...edits[row.id] }
    const ok = await saveBonus(merged)
    if (ok) {
      setEdits(prev => { const n = { ...prev }; delete n[row.id]; return n })
      setMsg({ type: 'ok', text: 'Guardado ✓' })
    } else {
      setMsg({ type: 'err', text: 'Error al guardar.' })
    }
    setSaving(false)
  }

  async function handleDelete(id) {
    await deleteBonus(id)
  }

  if (loading) return <div className="config-loading">Cargando bonos…</div>

  return (
    <div className="config-section">
      <h2>Bonos por Competidor</h2>
      <p style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 12 }}>
        Define los bonos que ofrece cada app. Tipos: <strong>Viajes</strong> (bono al alcanzar N viajes/semana),
        <strong> Horas</strong> (bono al conducir N horas/semana), <strong>Zona</strong> (bono informativo por zona, no suma automáticamente).
      </p>

      {msg && (
        <div className={msg.type === 'ok' ? 'save-msg save-msg--ok' : 'save-msg save-msg--err'}>
          {msg.text}
        </div>
      )}

      <div style={{ overflowX: 'auto' }}>
        <table className="config-table">
          <thead>
            <tr>
              <th>Competidor</th>
              <th>Ciudad</th>
              <th>Tipo</th>
              <th>Umbral</th>
              <th>Monto S/</th>
              <th>Descripción</th>
              <th>Activo</th>
              <th>Orden</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {allRows.map(row => (
              <tr key={row.id}>
                <td>
                  <select
                    value={getField(row, 'competitor_name') || ''}
                    onChange={e => setField(row.id, 'competitor_name', e.target.value)}
                    style={{ width: 140 }}
                  >
                    <option value="">— Seleccionar —</option>
                    {ALL_COMPETITORS.map(c => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
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
                  <select
                    value={getField(row, 'bonus_type') || 'viajes'}
                    onChange={e => setField(row.id, 'bonus_type', e.target.value)}
                  >
                    {TYPE_OPTIONS.map(o => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={getField(row, 'threshold')}
                    onChange={e => setField(row.id, 'threshold', e.target.value)}
                    style={{ width: 70, textAlign: 'right' }}
                    title="Número de viajes / horas para alcanzar el bono"
                  />
                </td>
                <td>
                  <input
                    type="number"
                    min="0"
                    step="0.5"
                    value={getField(row, 'bonus_amount')}
                    onChange={e => setField(row.id, 'bonus_amount', e.target.value)}
                    style={{ width: 80, textAlign: 'right' }}
                  />
                </td>
                <td>
                  <input
                    type="text"
                    value={getField(row, 'description') || ''}
                    onChange={e => setField(row.id, 'description', e.target.value)}
                    placeholder="Ej: Bono semanal"
                    style={{ width: 150 }}
                  />
                </td>
                <td style={{ textAlign: 'center' }}>
                  <input
                    type="checkbox"
                    checked={getActive(row)}
                    onChange={e => setField(row.id, 'is_active', e.target.checked)}
                    style={{ accentColor: 'var(--color-yango)', width: 15, height: 15 }}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={getField(row, 'sort_order') || 0}
                    onChange={e => setField(row.id, 'sort_order', e.target.value)}
                    style={{ width: 52, textAlign: 'right' }}
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
      </div>

      <button className="btn-add-row" onClick={addRow} style={{ marginTop: 10 }}>
        + Agregar bono
      </button>
    </div>
  )
}
