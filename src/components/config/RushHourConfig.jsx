import { useState, useEffect } from 'react'
import { sb } from '../../lib/supabase'
import { DB_CITIES } from '../../lib/constants'

const ALL_CITIES = ['all', ...DB_CITIES]

export default function RushHourConfig() {
  const [windows, setWindows] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving,  setSaving]  = useState(false)
  const [msg,     setMsg]     = useState(null)

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    const { data } = await sb.from('rush_hour_windows').select('*').order('city').order('start_time')
    setWindows(data || [])
    setLoading(false)
  }

  function update(id, field, val) {
    setWindows(prev => prev.map(w => w.id === id ? { ...w, [field]: val } : w))
  }

  function addWindow() {
    const tempId = `new_${Date.now()}`
    setWindows(prev => [...prev, { id: tempId, city: 'all', label: '', start_time: '07:00', end_time: '09:00', _new: true }])
  }

  async function saveWindow(w) {
    setSaving(true)
    setMsg(null)
    const payload = {
      city:       w.city,
      label:      w.label || null,
      start_time: w.start_time,
      end_time:   w.end_time,
    }
    let err
    if (w._new) {
      ;({ error: err } = await sb.from('rush_hour_windows').insert(payload))
    } else {
      ;({ error: err } = await sb.from('rush_hour_windows').update(payload).eq('id', w.id))
    }
    if (err) setMsg({ type: 'err', text: err.message })
    else { setMsg({ type: 'ok', text: 'Guardado ✓' }); await load() }
    setSaving(false)
  }

  async function deleteWindow(id) {
    if (String(id).startsWith('new_')) { setWindows(prev => prev.filter(w => w.id !== id)); return }
    const { error } = await sb.from('rush_hour_windows').delete().eq('id', id)
    if (!error) load()
  }

  if (loading) return <div className="config-loading">Cargando horarios…</div>

  return (
    <div className="config-section">
      <h2>Horarios Rush Hour</h2>
      <p style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 12 }}>
        Define las franjas horarias que se consideran "rush hour" al subir data.
        Usa <strong>all</strong> para aplicar a todas las ciudades, o especifica una ciudad
        para sobrescribir el horario global en esa ciudad.
        Formato: <strong>HH:MM</strong> en 24 horas.
      </p>

      {msg && (
        <div className={msg.type === 'ok' ? 'save-msg save-msg--ok' : 'save-msg save-msg--err'}>
          {msg.text}
        </div>
      )}

      <table className="config-table">
        <thead>
          <tr>
            <th>Ciudad</th>
            <th>Etiqueta</th>
            <th>Desde</th>
            <th>Hasta</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {windows.map(w => (
            <tr key={w.id}>
              <td>
                <select value={w.city} onChange={e => update(w.id, 'city', e.target.value)}>
                  {ALL_CITIES.map(c => <option key={c} value={c}>{c === 'all' ? 'Todas las ciudades' : c}</option>)}
                </select>
              </td>
              <td>
                <input
                  type="text"
                  value={w.label || ''}
                  onChange={e => update(w.id, 'label', e.target.value)}
                  placeholder="Ej: Mañana"
                  style={{ width: 90 }}
                />
              </td>
              <td>
                <input
                  type="time"
                  value={w.start_time?.slice(0, 5) || ''}
                  onChange={e => update(w.id, 'start_time', e.target.value)}
                  style={{ width: 90 }}
                />
              </td>
              <td>
                <input
                  type="time"
                  value={w.end_time?.slice(0, 5) || ''}
                  onChange={e => update(w.id, 'end_time', e.target.value)}
                  style={{ width: 90 }}
                />
              </td>
              <td style={{ display: 'flex', gap: 6 }}>
                <button className="btn-save-sm" onClick={() => saveWindow(w)} disabled={saving}>Guardar</button>
                <button className="btn-delete-sm" onClick={() => deleteWindow(w.id)}>✕</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <button className="btn-add-row" onClick={addWindow} style={{ marginTop: 10 }}>
        + Agregar franja horaria
      </button>
    </div>
  )
}
