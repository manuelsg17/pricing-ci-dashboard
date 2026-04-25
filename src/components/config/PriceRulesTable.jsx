import { useState, useEffect, useMemo } from 'react'
import { sb } from '../../lib/supabase'
import { getCountryConfig } from '../../lib/constants'
import SaveStatusBanner from './SaveStatusBanner'

export default function PriceRulesTable({ country }) {
  const config = getCountryConfig(country)
  const defaultCity = config.dbCities[0] || 'Lima'

  const allCategories = useMemo(() => {
    const cats = new Set()
    Object.values(config.categoriesByCity || {}).forEach(list => list.forEach(c => cats.add(c)))
    return ['all', ...Array.from(cats).sort()]
  }, [config])

  const allCompetitors = useMemo(() => {
    const comps = new Set()
    Object.values(config.competitorsByDbCityCategory || {}).forEach(byCat =>
      Object.values(byCat).forEach(list => list.forEach(c => comps.add(c)))
    )
    return ['all', ...Array.from(comps).sort()]
  }, [config])

  const [rules,    setRules]    = useState([])
  const [original, setOriginal] = useState([])
  const [loading,  setLoading]  = useState(true)
  const [saving,   setSaving]   = useState(false)
  const [msg,      setMsg]      = useState(null)

  useEffect(() => { load() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [country])

  async function load() {
    setLoading(true)
    const { data } = await sb
      .from('price_validation_rules')
      .select('*')
      .eq('country', country)
      .in('city', config.dbCities)
      .order('city').order('category').order('competition')
    setRules(data || [])
    setOriginal((data || []).map(r => ({ ...r })))
    setLoading(false)
  }

  function updateRule(id, field, val) {
    setMsg(null)
    setRules(prev => prev.map(r => r.id === id ? { ...r, [field]: val } : r))
  }

  function addRule() {
    const tempId = `new_${Date.now()}`
    setMsg(null)
    setRules(prev => [...prev, {
      id: tempId, city: defaultCity, category: 'all',
      competition: 'all', max_price: 120, _new: true,
    }])
  }

  const isRowDirty = (r) => {
    if (r._new) return true
    const orig = original.find(o => o.id === r.id)
    if (!orig) return true
    return (
      r.city !== orig.city ||
      r.category !== orig.category ||
      r.competition !== orig.competition ||
      String(r.max_price) !== String(orig.max_price)
    )
  }

  async function saveRule(rule) {
    setSaving(true)
    setMsg(null)
    const payload = {
      country,
      city: rule.city,
      category: rule.category || 'all',
      competition: rule.competition || 'all',
      max_price: parseFloat(rule.max_price) || 120,
    }
    let err
    if (rule._new) {
      ;({ error: err } = await sb.from('price_validation_rules').insert(payload))
    } else {
      ;({ error: err } = await sb.from('price_validation_rules')
        .update({ ...payload, updated_at: new Date().toISOString() })
        .eq('id', rule.id))
    }
    if (err) {
      setMsg({ type: 'err', text: 'Error al guardar: ' + err.message })
    } else {
      setMsg({ type: 'ok', text: `Regla guardada: ${payload.city} / ${payload.category} / ${payload.competition} ≤ ${config.currency} ${payload.max_price}` })
      await load()
    }
    setSaving(false)
  }

  async function deleteRule(id) {
    if (String(id).startsWith('new_')) {
      setRules(prev => prev.filter(r => r.id !== id))
      return
    }
    if (!confirm('¿Eliminar esta regla de límite de precio?')) return
    const { error } = await sb.from('price_validation_rules').delete().eq('id', id)
    if (!error) {
      setMsg({ type: 'ok', text: 'Regla eliminada.' })
      await load()
    } else {
      setMsg({ type: 'err', text: 'Error al eliminar: ' + error.message })
    }
  }

  if (loading) return <div className="config-loading">Cargando reglas…</div>

  const dirtyCellStyle = {
    background:  '#fef3c7',
    borderColor: '#f59e0b',
    fontWeight:  600,
    boxShadow:   '0 0 0 2px rgba(245, 158, 11, 0.2)',
  }

  return (
    <div className="config-section">
      <h2>Límites de Precio por Validación</h2>
      <p style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 12 }}>
        Al subir data, cualquier precio mayor al límite configurado será marcado como sospechoso
        y requerirá confirmación manual antes de insertarse.
        Usa <strong>all</strong> en categoría o competidor para aplicar a todos.
      </p>

      <SaveStatusBanner status={msg} onDismiss={() => setMsg(null)} />

      <table className="config-table" style={{ marginTop: 10 }}>
        <thead>
          <tr>
            <th>Ciudad</th>
            <th>Categoría</th>
            <th>Competidor</th>
            <th>Precio máx ({config.currency})</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rules.map(rule => {
            const dirty = isRowDirty(rule)
            return (
              <tr key={rule.id} style={dirty ? { background: '#fffbeb' } : undefined}>
                <td>
                  <select
                    value={rule.city}
                    onChange={e => updateRule(rule.id, 'city', e.target.value)}
                    style={dirty ? dirtyCellStyle : undefined}
                  >
                    {config.dbCities.map(c => <option key={c}>{c}</option>)}
                  </select>
                </td>
                <td>
                  <select
                    value={rule.category || 'all'}
                    onChange={e => updateRule(rule.id, 'category', e.target.value)}
                    style={dirty ? dirtyCellStyle : undefined}
                  >
                    {allCategories.map(c => <option key={c}>{c}</option>)}
                  </select>
                </td>
                <td>
                  <select
                    value={rule.competition || 'all'}
                    onChange={e => updateRule(rule.id, 'competition', e.target.value)}
                    style={dirty ? dirtyCellStyle : undefined}
                  >
                    {allCompetitors.map(c => <option key={c}>{c}</option>)}
                  </select>
                </td>
                <td>
                  <input
                    type="number"
                    value={rule.max_price}
                    min="0"
                    step="1"
                    onChange={e => updateRule(rule.id, 'max_price', e.target.value)}
                    style={{ width: 80, ...(dirty ? dirtyCellStyle : {}) }}
                  />
                </td>
                <td style={{ display: 'flex', gap: 6 }}>
                  <button
                    className="btn-save-sm"
                    onClick={() => saveRule(rule)}
                    disabled={saving || !dirty}
                    title={!dirty ? 'Sin cambios' : undefined}
                  >
                    {rule._new ? 'Crear' : 'Guardar'}
                  </button>
                  <button className="btn-delete-sm" onClick={() => deleteRule(rule.id)}>✕</button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <button className="btn-add-row" onClick={addRule} style={{ marginTop: 10 }}>
        + Agregar regla
      </button>
    </div>
  )
}
