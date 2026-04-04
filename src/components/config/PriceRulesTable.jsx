import { useState, useEffect } from 'react'
import { sb } from '../../lib/supabase'
import { DB_CITIES } from '../../lib/constants'

const DEFAULT_CITY = DB_CITIES[0]

export default function PriceRulesTable() {
  const [rules,   setRules]   = useState([])
  const [loading, setLoading] = useState(true)
  const [saving,  setSaving]  = useState(false)
  const [msg,     setMsg]     = useState(null)

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    const { data } = await sb.from('price_validation_rules').select('*').order('city').order('category').order('competition')
    setRules(data || [])
    setLoading(false)
  }

  function updateRule(id, field, val) {
    setRules(prev => prev.map(r => r.id === id ? { ...r, [field]: val } : r))
  }

  function addRule() {
    const tempId = `new_${Date.now()}`
    setRules(prev => [...prev, {
      id: tempId, city: DEFAULT_CITY, category: 'all',
      competition: 'all', max_price: 120, _new: true,
    }])
  }

  async function saveRule(rule) {
    setSaving(true)
    setMsg(null)
    const payload = {
      city: rule.city,
      category: rule.category || 'all',
      competition: rule.competition || 'all',
      max_price: parseFloat(rule.max_price) || 120,
    }
    let err
    if (rule._new) {
      ;({ error: err } = await sb.from('price_validation_rules').insert(payload))
    } else {
      ;({ error: err } = await sb.from('price_validation_rules').update({ ...payload, updated_at: new Date().toISOString() }).eq('id', rule.id))
    }
    if (err) setMsg({ type: 'err', text: err.message })
    else { setMsg({ type: 'ok', text: 'Guardado ✓' }); await load() }
    setSaving(false)
  }

  async function deleteRule(id) {
    if (String(id).startsWith('new_')) {
      setRules(prev => prev.filter(r => r.id !== id))
      return
    }
    const { error } = await sb.from('price_validation_rules').delete().eq('id', id)
    if (!error) load()
  }

  if (loading) return <div className="config-loading">Cargando reglas…</div>

  return (
    <div className="config-section">
      <h2>Límites de Precio por Validación</h2>
      <p style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 12 }}>
        Al subir data, cualquier precio mayor al límite configurado será marcado como sospechoso
        y requerirá confirmación manual antes de insertarse.
        Usa <strong>all</strong> en categoría o competidor para aplicar a todos.
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
            <th>Categoría</th>
            <th>Competidor</th>
            <th>Precio máx (S/.)</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rules.map(rule => (
            <tr key={rule.id}>
              <td>
                <select value={rule.city} onChange={e => updateRule(rule.id, 'city', e.target.value)}>
                  {DB_CITIES.map(c => <option key={c}>{c}</option>)}
                </select>
              </td>
              <td>
                <input
                  type="text"
                  value={rule.category}
                  onChange={e => updateRule(rule.id, 'category', e.target.value)}
                  style={{ width: 90 }}
                  placeholder="all"
                />
              </td>
              <td>
                <input
                  type="text"
                  value={rule.competition}
                  onChange={e => updateRule(rule.id, 'competition', e.target.value)}
                  style={{ width: 110 }}
                  placeholder="all"
                />
              </td>
              <td>
                <input
                  type="number"
                  value={rule.max_price}
                  min="0"
                  step="1"
                  onChange={e => updateRule(rule.id, 'max_price', e.target.value)}
                  style={{ width: 80 }}
                />
              </td>
              <td style={{ display: 'flex', gap: 6 }}>
                <button className="btn-save-sm" onClick={() => saveRule(rule)} disabled={saving}>
                  Guardar
                </button>
                <button className="btn-delete-sm" onClick={() => deleteRule(rule.id)}>
                  ✕
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <button className="btn-add-row" onClick={addRule} style={{ marginTop: 10 }}>
        + Agregar regla
      </button>
    </div>
  )
}
