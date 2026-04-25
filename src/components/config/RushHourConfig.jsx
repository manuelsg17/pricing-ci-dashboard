import { useState, useEffect } from 'react'
import { sb } from '../../lib/supabase'
import { getCountryConfig } from '../../lib/constants'
import SaveStatusBanner from './SaveStatusBanner'

export default function RushHourConfig({ country }) {
  const config = getCountryConfig(country)
  const allCities = ['all', ...config.dbCities]

  const [windows, setWindows] = useState([])
  const [original, setOriginal] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving,  setSaving]  = useState(false)
  const [msg,     setMsg]     = useState(null)

  useEffect(() => { load() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [country])

  async function load() {
    setLoading(true)
    const { data } = await sb
      .from('rush_hour_windows')
      .select('*')
      .eq('country', country)
      .in('city', allCities)
      .order('city').order('start_time')
    setWindows(data || [])
    setOriginal((data || []).map(r => ({ ...r })))
    setLoading(false)
  }

  function update(id, field, val) {
    setMsg(null)
    setWindows(prev => prev.map(w => w.id === id ? { ...w, [field]: val } : w))
  }

  function addWindow() {
    const tempId = `new_${Date.now()}`
    setMsg(null)
    setWindows(prev => [...prev, {
      id: tempId, city: 'all', label: '', start_time: '07:00', end_time: '09:00', _new: true,
    }])
  }

  const isRowDirty = (w) => {
    if (w._new) return true
    const orig = original.find(o => o.id === w.id)
    if (!orig) return true
    return (
      String(w.city       ?? '') !== String(orig.city       ?? '') ||
      String(w.label      ?? '') !== String(orig.label      ?? '') ||
      String(w.start_time ?? '') !== String(orig.start_time ?? '') ||
      String(w.end_time   ?? '') !== String(orig.end_time   ?? '')
    )
  }

  async function saveWindow(w) {
    setSaving(true)
    setMsg(null)
    const payload = {
      country,
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
    if (err) {
      setMsg({ type: 'err', text: 'Error al guardar: ' + err.message })
    } else {
      setMsg({ type: 'ok', text: `Franja guardada: ${payload.city === 'all' ? 'Todas las ciudades' : payload.city} ${payload.start_time}–${payload.end_time}` })
      await load()
    }
    setSaving(false)
  }

  async function deleteWindow(id) {
    if (String(id).startsWith('new_')) {
      setWindows(prev => prev.filter(w => w.id !== id))
      return
    }
    if (!confirm('¿Eliminar esta franja rush hour?')) return
    const { error } = await sb.from('rush_hour_windows').delete().eq('id', id)
    if (!error) {
      setMsg({ type: 'ok', text: 'Franja eliminada.' })
      await load()
    } else {
      setMsg({ type: 'err', text: 'Error al eliminar: ' + error.message })
    }
  }

  if (loading) return <div className="config-loading">Cargando horarios…</div>

  const dirtyCellStyle = {
    background:  '#fef3c7',
    borderColor: '#f59e0b',
    fontWeight:  600,
    boxShadow:   '0 0 0 2px rgba(245, 158, 11, 0.2)',
  }

  return (
    <div className="config-section">
      <h2>Horarios Rush Hour</h2>
      <p style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 12 }}>
        Define las franjas horarias que se consideran "rush hour" al subir data.
        Usa <strong>all</strong> para aplicar a todas las ciudades, o especifica una ciudad
        para sobrescribir el horario global en esa ciudad.
        Formato: <strong>HH:MM</strong> en 24 horas.
      </p>

      <SaveStatusBanner status={msg} onDismiss={() => setMsg(null)} />

      <table className="config-table" style={{ marginTop: 10 }}>
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
          {windows.map(w => {
            const dirty = isRowDirty(w)
            return (
              <tr key={w.id} style={dirty ? { background: '#fffbeb' } : undefined}>
                <td>
                  <select
                    value={w.city}
                    onChange={e => update(w.id, 'city', e.target.value)}
                    style={dirty ? dirtyCellStyle : undefined}
                  >
                    {allCities.map(c => <option key={c} value={c}>{c === 'all' ? 'Todas las ciudades' : c}</option>)}
                  </select>
                </td>
                <td>
                  <input
                    type="text"
                    value={w.label || ''}
                    onChange={e => update(w.id, 'label', e.target.value)}
                    placeholder="Ej: Mañana"
                    style={{ width: 90, ...(dirty ? dirtyCellStyle : {}) }}
                  />
                </td>
                <td>
                  <input
                    type="time"
                    value={w.start_time?.slice(0, 5) || ''}
                    onChange={e => update(w.id, 'start_time', e.target.value)}
                    style={{ width: 90, ...(dirty ? dirtyCellStyle : {}) }}
                  />
                </td>
                <td>
                  <input
                    type="time"
                    value={w.end_time?.slice(0, 5) || ''}
                    onChange={e => update(w.id, 'end_time', e.target.value)}
                    style={{ width: 90, ...(dirty ? dirtyCellStyle : {}) }}
                  />
                </td>
                <td style={{ display: 'flex', gap: 6 }}>
                  <button
                    className="btn-save-sm"
                    onClick={() => saveWindow(w)}
                    disabled={saving || !dirty}
                    title={!dirty ? 'Sin cambios' : 'Guardar franja'}
                  >
                    {w._new ? 'Crear' : 'Guardar'}
                  </button>
                  <button className="btn-delete-sm" onClick={() => deleteWindow(w.id)}>✕</button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <button className="btn-add-row" onClick={addWindow} style={{ marginTop: 10 }}>
        + Agregar franja horaria
      </button>
    </div>
  )
}
