import { useState } from 'react'
import { useCompetitorBonuses } from '../../hooks/useCompetitorBonuses'
import { getCountryConfig, COMPETITOR_COLORS } from '../../lib/constants'
import SaveStatusBanner from './SaveStatusBanner'

const ALL_COMPETITORS = Object.keys(COMPETITOR_COLORS)
const TYPE_OPTIONS = [
  { value: 'viajes', label: 'Viajes' },
  { value: 'horas',  label: 'Horas' },
  { value: 'zona',   label: 'Zona' },
]

const DIRTY_STYLE = {
  background:  '#fef3c7',
  borderColor: '#f59e0b',
  fontWeight:  600,
  boxShadow:   '0 0 0 2px rgba(245, 158, 11, 0.2)',
}

export default function BonusesConfig({ country }) {
  const config = getCountryConfig(country)
  const CITY_OPTIONS = [{ value: '', label: 'Todas' }, ...config.dbCities.map(c => ({ value: c, label: c }))]

  const { allRows, loading, saveBonus, deleteBonus, addRow } = useCompetitorBonuses(null, country)
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
  function getActive(row) {
    return edits[row.id]?.is_active ?? row.is_active ?? true
  }

  const isDirty = (id) => !!edits[id] && Object.keys(edits[id]).length > 0
  const isNew   = (row) => String(row.id).startsWith('new_')

  async function handleSave(row) {
    setSaving(true); setMsg(null)
    const merged = { ...row, ...edits[row.id] }
    const ok = await saveBonus(merged)
    if (ok) {
      setEdits(prev => { const n = { ...prev }; delete n[row.id]; return n })
      const cityLabel = merged.city || 'Todas'
      setMsg({
        type: 'ok',
        text: `Bono guardado: ${merged.competitor_name} (${cityLabel}) / ${merged.bonus_type} @ ${merged.threshold} → ${config.currency} ${merged.bonus_amount}`,
      })
    } else {
      setMsg({ type: 'err', text: 'Error al guardar el bono.' })
    }
    setSaving(false)
  }

  async function handleDelete(row) {
    if (!String(row.id).startsWith('new_') && !confirm('¿Eliminar este bono?')) return
    const ok = await deleteBonus(row.id)
    if (!ok) setMsg({ type: 'err', text: 'No se pudo eliminar.' })
    else if (!String(row.id).startsWith('new_')) setMsg({ type: 'ok', text: 'Bono eliminado.' })
  }

  if (loading) return <div className="config-loading">Cargando bonos…</div>

  return (
    <div className="config-section">
      <h2>Bonos por Competidor</h2>
      <p style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 12 }}>
        Define los bonos que ofrece cada app. Tipos: <strong>Viajes</strong> (bono al alcanzar N viajes/semana),
        <strong> Horas</strong> (bono al conducir N horas/semana), <strong>Zona</strong> (bono informativo por zona).
      </p>

      <SaveStatusBanner status={msg} onDismiss={() => setMsg(null)} />

      <div style={{ overflowX: 'auto', marginTop: 10 }}>
        <table className="config-table">
          <thead>
            <tr>
              <th>Competidor</th>
              <th>Ciudad</th>
              <th>Tipo</th>
              <th>Umbral</th>
              <th>Monto {config.currency}</th>
              <th>Descripción</th>
              <th>Activo</th>
              <th>Orden</th>
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
                      style={{ width: 140, ...(cellStyle || {}) }}
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
                    <select
                      value={getField(row, 'bonus_type') || 'viajes'}
                      onChange={e => setField(row.id, 'bonus_type', e.target.value)}
                      style={cellStyle}
                    >
                      {TYPE_OPTIONS.map(o => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      type="number" min="0" step="1"
                      value={getField(row, 'threshold')}
                      onChange={e => setField(row.id, 'threshold', e.target.value)}
                      style={{ width: 70, textAlign: 'right', ...(cellStyle || {}) }}
                      title="Número de viajes / horas para alcanzar el bono"
                    />
                  </td>
                  <td>
                    <input
                      type="number" min="0" step="0.5"
                      value={getField(row, 'bonus_amount')}
                      onChange={e => setField(row.id, 'bonus_amount', e.target.value)}
                      style={{ width: 80, textAlign: 'right', ...(cellStyle || {}) }}
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      value={getField(row, 'description') || ''}
                      onChange={e => setField(row.id, 'description', e.target.value)}
                      placeholder="Ej: Bono semanal"
                      style={{ width: 150, ...(cellStyle || {}) }}
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
                      type="number" min="0" step="1"
                      value={getField(row, 'sort_order') || 0}
                      onChange={e => setField(row.id, 'sort_order', e.target.value)}
                      style={{ width: 52, textAlign: 'right', ...(cellStyle || {}) }}
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
      </div>

      <button className="btn-add-row" onClick={addRow} style={{ marginTop: 10 }}>
        + Agregar bono
      </button>
    </div>
  )
}
