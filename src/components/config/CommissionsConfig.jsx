import { useState } from 'react'
import { useCompetitorCommissions } from '../../hooks/useCompetitorCommissions'
import { getCountryConfig, COMPETITOR_COLORS } from '../../lib/constants'
import SaveStatusBanner from './SaveStatusBanner'
import { useConfirm } from '../ui/ConfirmDialog'

const ALL_COMPETITORS = Object.keys(COMPETITOR_COLORS)

const DIRTY_STYLE = {
  background:  '#fef3c7',
  borderColor: '#f59e0b',
  fontWeight:  600,
  boxShadow:   '0 0 0 2px rgba(245, 158, 11, 0.2)',
}

export default function CommissionsConfig({ country }) {
  const config = getCountryConfig(country)
  const confirm = useConfirm()
  const CITY_OPTIONS = [{ value: '', label: 'Todas las ciudades' }, ...config.dbCities.map(c => ({ value: c, label: c }))]

  const { allRows, loading, saveCommission, deleteCommission, addRow } = useCompetitorCommissions(null, country)
  const [saving, setSaving] = useState(false)
  const [msg,    setMsg]    = useState(null)
  const [edits,  setEdits]  = useState({})

  function getField(row, field) {
    return edits[row.id]?.[field] ?? row[field] ?? ''
  }
  function setField(id, field, val) {
    setMsg(null)
    setEdits(prev => ({ ...prev, [id]: { ...prev[id], [field]: val } }))
  }
  const isDirty = (id) => !!edits[id] && Object.keys(edits[id]).length > 0
  const isNew   = (row) => String(row.id).startsWith('new_')

  async function handleSave(row) {
    setSaving(true); setMsg(null)
    const merged = { ...row, ...edits[row.id] }
    const ok = await saveCommission(merged)
    if (ok) {
      setEdits(prev => { const n = { ...prev }; delete n[row.id]; return n })
      const cityLabel = merged.city || 'Todas las ciudades'
      setMsg({ type: 'ok', text: `Guardado: ${merged.competitor_name} (${cityLabel}) — ${merged.commission_pct}%` })
    } else {
      setMsg({ type: 'err', text: 'Error al guardar. Verifica que el competidor no esté duplicado en la misma ciudad.' })
    }
    setSaving(false)
  }

  async function handleDelete(row) {
    if (!String(row.id).startsWith('new_')) {
      const confirmed = await confirm({ title: 'Eliminar comisión', message: '¿Eliminar esta comisión?', danger: true, confirmText: 'Eliminar' })
      if (!confirmed) return
    }
    const ok = await deleteCommission(row.id)
    if (!ok) setMsg({ type: 'err', text: 'No se pudo eliminar.' })
    else if (!String(row.id).startsWith('new_')) setMsg({ type: 'ok', text: 'Comisión eliminada.' })
  }

  if (loading) return <div className="config-loading">Cargando comisiones…</div>

  return (
    <div className="config-section">
      <h2>Comisiones por Competidor</h2>
      <p style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 12 }}>
        Define el porcentaje de comisión que cobra cada app al conductor.
        Puedes tener un valor global (Todas las ciudades) o sobrescribirlo por ciudad.
      </p>

      <SaveStatusBanner status={msg} onDismiss={() => setMsg(null)} />

      <table className="config-table" style={{ marginTop: 10 }}>
        <thead>
          <tr>
            <th>Competidor</th>
            <th>Ciudad</th>
            <th>Comisión %</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {allRows.map(row => {
            const dirty = isDirty(row.id) || isNew(row)
            const cellStyle = dirty ? DIRTY_STYLE : undefined
            return (
              <tr key={row.id} style={dirty ? { background: '#fffbeb' } : undefined}>
                <td>
                  <select
                    value={getField(row, 'competitor_name') || ''}
                    onChange={e => setField(row.id, 'competitor_name', e.target.value)}
                    style={{ width: 155, ...(cellStyle || {}) }}
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
                    style={cellStyle}
                  >
                    {CITY_OPTIONS.map(o => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    type="number" min="0" max="100" step="0.5"
                    value={getField(row, 'commission_pct')}
                    onChange={e => setField(row.id, 'commission_pct', e.target.value)}
                    style={{ width: 80, textAlign: 'right', ...(cellStyle || {}) }}
                  />
                </td>
                <td style={{ display: 'flex', gap: 6 }}>
                  <button
                    className="btn-save-sm"
                    onClick={() => handleSave(row)}
                    disabled={saving || !dirty}
                    title={!dirty ? 'Sin cambios' : undefined}
                  >
                    {isNew(row) ? 'Crear' : 'Guardar'}
                  </button>
                  <button className="btn-delete-sm" onClick={() => handleDelete(row)}>✕</button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <button className="btn-add-row" onClick={addRow} style={{ marginTop: 10 }}>
        + Agregar comisión
      </button>
    </div>
  )
}
