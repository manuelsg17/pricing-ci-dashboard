import { useState, useEffect } from 'react'
import { sb } from '../../lib/supabase'

export default function CITimeslotsConfig() {
  const [rows,    setRows]    = useState([])
  const [loading, setLoading] = useState(true)
  const [saving,  setSaving]  = useState(false)
  const [msg,     setMsg]     = useState(null)

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    const { data } = await sb.from('ci_timeslots').select('*').order('sort_order')
    setRows(data || [])
    setLoading(false)
  }

  function update(id, field, val) {
    setRows(prev => prev.map(r => r.id === id ? { ...r, [field]: val } : r))
  }

  function addRow() {
    const maxOrder = rows.reduce((m, r) => Math.max(m, r.sort_order || 0), 0)
    const tempId = `new_${Date.now()}`
    setRows(prev => [...prev, {
      id: tempId, label: '', start_time: '08:00', end_time: '10:00',
      is_active: true, sort_order: maxOrder + 1, _new: true,
    }])
  }

  async function saveRow(r) {
    if (!r.label?.trim()) { setMsg({ type: 'err', text: 'El label no puede estar vacío.' }); return }
    setSaving(true); setMsg(null)
    const payload = {
      label:      r.label.trim(),
      start_time: r.start_time,
      end_time:   r.end_time,
      is_active:  r.is_active,
      sort_order: Number(r.sort_order) || 0,
    }
    let err
    if (r._new) {
      ;({ error: err } = await sb.from('ci_timeslots').insert(payload))
    } else {
      ;({ error: err } = await sb.from('ci_timeslots').update(payload).eq('id', r.id))
    }
    if (err) setMsg({ type: 'err', text: err.message })
    else { setMsg({ type: 'ok', text: 'Guardado ✓' }); await load() }
    setSaving(false)
  }

  async function deleteRow(id) {
    if (String(id).startsWith('new_')) { setRows(prev => prev.filter(r => r.id !== id)); return }
    const { error } = await sb.from('ci_timeslots').delete().eq('id', id)
    if (!error) load()
    else setMsg({ type: 'err', text: error.message })
  }

  if (loading) return <div className="config-loading">Cargando timeslots…</div>

  return (
    <div className="config-section">
      <h2>Timeslots de CI</h2>
      <p style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 12 }}>
        Define los timeslots diarios que los hubs experts deben completar.
        El sistema repite las rutas de cada ciudad para cada timeslot activo.
        Usa el campo <strong>Orden</strong> para controlar la secuencia de aparición.
      </p>

      {msg && (
        <div className={msg.type === 'ok' ? 'save-msg save-msg--ok' : 'save-msg save-msg--err'}>
          {msg.text}
        </div>
      )}

      <table className="config-table">
        <thead>
          <tr>
            <th style={{ width: 30 }}>#</th>
            <th>Label</th>
            <th>Inicio</th>
            <th>Fin</th>
            <th>Activo</th>
            <th>Orden</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id}>
              <td style={{ color: 'var(--color-muted)', fontSize: 11 }}>{i + 1}</td>
              <td>
                <input
                  type="text"
                  value={r.label || ''}
                  onChange={e => update(r.id, 'label', e.target.value)}
                  placeholder="Ej: Mañana"
                  style={{ width: 100 }}
                />
              </td>
              <td>
                <input
                  type="time"
                  value={r.start_time?.slice(0, 5) || ''}
                  onChange={e => update(r.id, 'start_time', e.target.value)}
                  style={{ width: 90 }}
                />
              </td>
              <td>
                <input
                  type="time"
                  value={r.end_time?.slice(0, 5) || ''}
                  onChange={e => update(r.id, 'end_time', e.target.value)}
                  style={{ width: 90 }}
                />
              </td>
              <td>
                <input
                  type="checkbox"
                  checked={!!r.is_active}
                  onChange={e => update(r.id, 'is_active', e.target.checked)}
                  style={{ width: 16, height: 16, accentColor: 'var(--color-yango)', cursor: 'pointer' }}
                />
              </td>
              <td>
                <input
                  type="number"
                  value={r.sort_order ?? 0}
                  onChange={e => update(r.id, 'sort_order', e.target.value)}
                  style={{ width: 60 }}
                  min="0"
                />
              </td>
              <td style={{ display: 'flex', gap: 6 }}>
                <button className="btn-save-sm" onClick={() => saveRow(r)} disabled={saving}>Guardar</button>
                <button className="btn-delete-sm" onClick={() => deleteRow(r.id)}>✕</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <button className="btn-add-row" onClick={addRow} style={{ marginTop: 10 }}>
        + Agregar timeslot
      </button>
    </div>
  )
}
