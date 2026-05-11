import { useEffect, useMemo, useState } from 'react'
import { sb } from '../../lib/supabase'
import { getCountryConfig } from '../../lib/constants'
import SaveStatusBanner from './SaveStatusBanner'
import { useConfirm } from '../ui/ConfirmDialog'

// Tabla CRUD de bot_rules. Cada fila mapea (app, vc, ovc, cities) →
// (competition_name, category) para que sync_bot_quotes pueda matchear
// las filas que emite el scraper externo.
//
// Patrón visual: espejo de PriceRulesTable. Sin framework de forms;
// dirty tracking por comparación con `original`.
export default function BotRulesTable({ country }) {
  const config = getCountryConfig(country)
  const confirm = useConfirm()

  const allCategories = useMemo(() => {
    const cats = new Set()
    Object.values(config.categoriesByCity || {}).forEach(list => list.forEach(c => cats.add(c)))
    return Array.from(cats).sort()
  }, [config])

  const allCompetitors = useMemo(() => {
    const comps = new Set()
    Object.values(config.competitorsByDbCityCategory || {}).forEach(byCat =>
      Object.values(byCat).forEach(list => list.forEach(c => comps.add(c)))
    )
    return Array.from(comps).sort()
  }, [config])

  const [rules,    setRules]    = useState([])
  const [original, setOriginal] = useState([])
  const [loading,  setLoading]  = useState(true)
  const [saving,   setSaving]   = useState(false)
  const [msg,      setMsg]      = useState(null)
  // Combos no matcheados del último sync ok — sirven como sugerencias
  // click-to-add. Vienen de bot_sync_log.notes->dropped_combos.
  const [unmatched, setUnmatched] = useState([])
  const [showUnmatched, setShowUnmatched] = useState(false)

  useEffect(() => { load() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [country])

  async function load() {
    setLoading(true)
    const [{ data: rulesData }, { data: combos }] = await Promise.all([
      sb.from('bot_rules')
        .select('*')
        .eq('country', country)
        .order('app').order('vc').order('ovc'),
      sb.rpc('list_unmatched_combos', { p_country: country, p_days: 7 }),
    ])
    setRules(rulesData || [])
    setOriginal((rulesData || []).map(r => ({ ...r })))
    setUnmatched(combos || [])
    setLoading(false)
  }

  function updateRule(id, field, val) {
    setMsg(null)
    setRules(prev => prev.map(r => r.id === id ? { ...r, [field]: val } : r))
  }

  function addRule(prefill = {}) {
    const tempId = `new_${Date.now()}_${Math.random()}`
    setMsg(null)
    setRules(prev => [...prev, {
      id: tempId,
      app:              prefill.app || '',
      vc:               prefill.vc  || '',
      ovc:              prefill.ovc || '*',
      competition_name: prefill.competition_name || (allCompetitors[0] || 'Yango'),
      category:         prefill.category || (allCategories[0] || 'Economy'),
      cities:           prefill.cities || [],
      active:           true,
      _new:             true,
    }])
    setShowUnmatched(false)
  }

  function addFromUnmatched(combo) {
    // Heurística: inferir competidor desde el app (yango_api → Yango, etc.)
    // y categoría desde el vc (moto → Bike, economy → Economy, ...).
    const appLc = (combo.app || '').toLowerCase()
    const vcLc  = (combo.vc  || '').toLowerCase()
    let inferredComp = allCompetitors.find(c => c.toLowerCase().includes(appLc.replace('_api', '').replace('drive', ''))) || ''
    if (!inferredComp && appLc.includes('yango'))   inferredComp = 'Yango'
    if (!inferredComp && appLc.includes('indrive')) inferredComp = 'InDrive'
    if (!inferredComp && appLc.includes('didi'))    inferredComp = 'Didi'
    if (!inferredComp && appLc.includes('uber'))    inferredComp = 'Uber'
    if (!inferredComp && appLc.includes('picap'))   inferredComp = 'Picap'
    let inferredCat = ''
    if (vcLc.includes('moto') || vcLc.includes('bike')) inferredCat = 'Bike'
    else if (vcLc.includes('comfort')) inferredCat = 'Comfort'
    else if (vcLc.includes('economy')) inferredCat = 'Economy'
    addRule({
      app:              combo.app || '',
      vc:               combo.vc  || '',
      ovc:              combo.ovc || '*',
      competition_name: inferredComp,
      category:         inferredCat,
      cities:           combo.db_city ? [combo.db_city] : [],
    })
  }

  const isRowDirty = (r) => {
    if (r._new) return true
    const orig = original.find(o => o.id === r.id)
    if (!orig) return true
    return (
      r.app              !== orig.app ||
      r.vc               !== orig.vc ||
      r.ovc              !== orig.ovc ||
      r.competition_name !== orig.competition_name ||
      r.category         !== orig.category ||
      r.active           !== orig.active ||
      JSON.stringify(r.cities || []) !== JSON.stringify(orig.cities || [])
    )
  }

  async function saveRule(rule) {
    if (!rule.app || !rule.vc || !rule.competition_name || !rule.category) {
      setMsg({ type: 'err', text: 'app, vc, competition_name y category son obligatorios' })
      return
    }
    setSaving(true)
    setMsg(null)
    const payload = {
      country,
      app:              rule.app.toLowerCase().trim(),
      vc:               rule.vc.toLowerCase().trim(),
      ovc:              (rule.ovc || '*').toLowerCase().trim(),
      competition_name: rule.competition_name,
      category:         rule.category,
      cities:           rule.cities || [],
      active:           !!rule.active,
    }
    let err
    if (rule._new) {
      ;({ error: err } = await sb.from('bot_rules').insert(payload))
    } else {
      ;({ error: err } = await sb.from('bot_rules')
        .update({ ...payload, updated_at: new Date().toISOString() })
        .eq('id', rule.id))
    }
    if (err) {
      setMsg({ type: 'err', text: 'Error al guardar: ' + err.message })
    } else {
      setMsg({ type: 'ok', text: `Regla guardada: ${payload.app} / ${payload.vc} / ${payload.ovc} → ${payload.competition_name} / ${payload.category}` })
      await load()
    }
    setSaving(false)
  }

  async function deleteRule(id) {
    if (String(id).startsWith('new_')) {
      setRules(prev => prev.filter(r => r.id !== id))
      return
    }
    const ok = await confirm({ title: 'Eliminar regla bot', message: '¿Eliminar esta regla? Filas del bot que matchaban esta regla dejarán de procesarse.', danger: true, confirmText: 'Eliminar' })
    if (!ok) return
    const { error } = await sb.from('bot_rules').delete().eq('id', id)
    if (!error) {
      setMsg({ type: 'ok', text: 'Regla eliminada.' })
      await load()
    } else {
      setMsg({ type: 'err', text: 'Error al eliminar: ' + error.message })
    }
  }

  if (loading) return <div className="config-loading">Cargando reglas del bot…</div>

  const dirtyCellStyle = {
    background:  '#fef3c7',
    borderColor: '#f59e0b',
    fontWeight:  600,
    boxShadow:   '0 0 0 2px rgba(245, 158, 11, 0.2)',
  }

  return (
    <div className="config-section">
      <h2>Reglas del Bot — {country}</h2>
      <p style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 12 }}>
        Cada regla mapea una tupla <code>(app, vc, ovc)</code> que el scraper emite a un{' '}
        <strong>(competidor, categoría)</strong> de tu taxonomía. Si una fila del bot no matchea
        ninguna regla, se descarta. Usa <code>*</code> en <code>ovc</code> como wildcard.
        Dejá <code>cities</code> vacío para aplicar a todas las ciudades del país.
      </p>

      <SaveStatusBanner status={msg} onDismiss={() => setMsg(null)} />

      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        <button className="btn-add-row" onClick={() => addRule()}>+ Nueva regla</button>
        {unmatched.length > 0 && (
          <button
            onClick={() => setShowUnmatched(v => !v)}
            style={{
              padding: '6px 12px', borderRadius: 6,
              border: '1px solid #f59e0b', background: '#fffbeb', cursor: 'pointer',
              fontSize: 12, color: '#78350f',
            }}
          >
            ⚠ {unmatched.length} combos no matcheados ({showUnmatched ? 'ocultar' : 'ver'})
          </button>
        )}
      </div>

      {showUnmatched && unmatched.length > 0 && (
        <div style={{
          marginBottom: 16, padding: 12, borderRadius: 8,
          background: '#fef3c7', border: '1px solid #f59e0b', maxHeight: 240, overflowY: 'auto',
        }}>
          <div style={{ fontSize: 11, color: '#78350f', marginBottom: 8, fontWeight: 600 }}>
            Combinaciones (app, vc, ovc, city) que aparecen en el bot pero no matchean ninguna regla activa
            (últimos 7 días). Hacé clic en <strong>+ Agregar</strong> para crear una regla pre-rellenada.
          </div>
          <table className="config-table" style={{ fontSize: 11 }}>
            <thead>
              <tr>
                <th>app</th><th>vc</th><th>ovc</th><th>db_city</th>
                <th style={{ textAlign: 'right' }}>n</th><th></th>
              </tr>
            </thead>
            <tbody>
              {unmatched.map((c, i) => (
                <tr key={i}>
                  <td><code>{c.app || '∅'}</code></td>
                  <td><code>{c.vc || '∅'}</code></td>
                  <td><code>{c.ovc || '*'}</code></td>
                  <td>{c.db_city || '∅'}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{Number(c.total_n).toLocaleString()}</td>
                  <td>
                    <button className="btn-save-sm" onClick={() => addFromUnmatched(c)}>+ Agregar</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <table className="config-table" style={{ marginTop: 4 }}>
        <thead>
          <tr>
            <th>app</th>
            <th>vc</th>
            <th>ovc</th>
            <th>Competidor</th>
            <th>Categoría</th>
            <th>Ciudades</th>
            <th>Activa</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rules.map(rule => {
            const dirty = isRowDirty(rule)
            return (
              <tr key={rule.id} style={dirty ? { background: '#fffbeb' } : undefined}>
                <td>
                  <input
                    type="text" value={rule.app || ''}
                    onChange={e => updateRule(rule.id, 'app', e.target.value)}
                    style={{ width: 100, ...(dirty ? dirtyCellStyle : {}) }}
                  />
                </td>
                <td>
                  <input
                    type="text" value={rule.vc || ''}
                    onChange={e => updateRule(rule.id, 'vc', e.target.value)}
                    style={{ width: 100, ...(dirty ? dirtyCellStyle : {}) }}
                  />
                </td>
                <td>
                  <input
                    type="text" value={rule.ovc || ''}
                    onChange={e => updateRule(rule.id, 'ovc', e.target.value)}
                    placeholder="*"
                    style={{ width: 100, ...(dirty ? dirtyCellStyle : {}) }}
                  />
                </td>
                <td>
                  <select
                    value={rule.competition_name || ''}
                    onChange={e => updateRule(rule.id, 'competition_name', e.target.value)}
                    style={dirty ? dirtyCellStyle : undefined}
                  >
                    <option value="">—</option>
                    {allCompetitors.map(c => <option key={c}>{c}</option>)}
                  </select>
                </td>
                <td>
                  <select
                    value={rule.category || ''}
                    onChange={e => updateRule(rule.id, 'category', e.target.value)}
                    style={dirty ? dirtyCellStyle : undefined}
                  >
                    <option value="">—</option>
                    {allCategories.map(c => <option key={c}>{c}</option>)}
                  </select>
                </td>
                <td style={{ fontSize: 11 }}>
                  <input
                    type="text"
                    value={(rule.cities || []).join(', ')}
                    onChange={e => updateRule(rule.id, 'cities', e.target.value
                      .split(',').map(s => s.trim()).filter(Boolean))}
                    placeholder="(todas)"
                    style={{ width: 140, ...(dirty ? dirtyCellStyle : {}) }}
                  />
                </td>
                <td style={{ textAlign: 'center' }}>
                  <input
                    type="checkbox"
                    checked={!!rule.active}
                    onChange={e => updateRule(rule.id, 'active', e.target.checked)}
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
    </div>
  )
}
