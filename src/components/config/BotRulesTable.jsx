import { useEffect, useMemo, useState } from 'react'
import { sb } from '../../lib/supabase'
import { getCountryConfig } from '../../lib/constants'
import { CATALOG_CATEGORIES, CATALOG_COMPETITORS } from '../../lib/catalogs'
import { useStaleWhileRevalidate } from '../../hooks/useStaleWhileRevalidate'
import SaveStatusBanner from './SaveStatusBanner'
import { useConfirm } from '../ui/ConfirmDialog'

// Tabla CRUD de bot_rules. Cada fila mapea (app, vc, ovc, cities) →
// (competition_name, category) para que sync_bot_quotes pueda matchear
// las filas que emite el scraper externo.
//
// Patrón visual: espejo de PriceRulesTable. Sin framework de forms;
// dirty tracking por comparación con `original`.
//
// Live-sync: bot_rules pasa por useStaleWhileRevalidate → render
// instantáneo desde cache + refetch silencioso al editar desde otra
// sesión (audit_log → 'config:changed'). El sync effect preserva filas
// dirty del usuario actual para no pisar trabajo en progreso.
// `unmatched` (RPC list_unmatched_combos) se sigue cargando manualmente
// porque NO es config — es agregación de observaciones recientes y no
// se beneficia del cache estable.
export default function BotRulesTable({ country }) {
  const config = getCountryConfig(country)
  const confirm = useConfirm()

  // Unión: categorías/competidores del país + catálogo canónico.
  // Esto cubre el caso de país recién creado (sin config) — los dropdowns
  // muestran el catálogo entero. Para países maduros, las del país
  // aparecen primero y el catálogo solo agrega las que falten.
  const allCategories = useMemo(() => {
    const cats = new Set()
    Object.values(config.categoriesByCity || {}).forEach(list => list.forEach(c => cats.add(c)))
    CATALOG_CATEGORIES.forEach(c => cats.add(c.value))
    return Array.from(cats).sort()
  }, [config])

  const allCompetitors = useMemo(() => {
    const comps = new Set()
    Object.values(config.competitorsByDbCityCategory || {}).forEach(byCat =>
      Object.values(byCat).forEach(list => list.forEach(c => comps.add(c)))
    )
    CATALOG_COMPETITORS.forEach(c => comps.add(c.value))
    return Array.from(comps).sort()
  }, [config])

  const { data: serverRules, loading, reload: reloadRules } = useStaleWhileRevalidate({
    key: `cfg.bot_rules.${country}`,
    enabled: !!country,
    liveSyncTable: 'bot_rules',
    fetcher: async () => {
      const { data, error } = await sb.from('bot_rules')
        .select('*')
        .eq('country', country)
        .order('app').order('vc').order('ovc')
      if (error) throw error
      return data || []
    },
  })

  const [rules,    setRules]    = useState([])
  const [original, setOriginal] = useState([])
  const [saving,   setSaving]   = useState(false)
  const [msg,      setMsg]      = useState(null)
  // Combos no matcheados del último sync ok — sirven como sugerencias
  // click-to-add. Vienen de bot_sync_log.notes->dropped_combos. Se
  // cargan aparte del SWR de rules: es data observacional (no config)
  // y queremos refrescarla cada vez que el usuario abra la página.
  const [unmatched, setUnmatched] = useState([])
  const [showUnmatched, setShowUnmatched] = useState(false)

  // Helper de dirty-check contra un snapshot dado. Lo usa tanto el render
  // (vs `original`) como el sync effect (vs el `original` previo al merge).
  function isRowDirtyAgainst(r, snapshot) {
    if (r._new) return true
    const orig = snapshot.find(o => o.id === r.id)
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

  // Sincronizar server → state local cuando llega data fresca.
  // Preservamos filas dirty (_new o con cambios sin guardar) para no
  // pisar trabajo del usuario si otra sesión escribe mientras edita.
  useEffect(() => {
    if (!serverRules) return
    setRules(prev => {
      const dirtyRows = prev.filter(r => isRowDirtyAgainst(r, original))
      const dirtyIds = new Set(dirtyRows.map(r => r.id))
      const cleanFromServer = serverRules.filter(s => !dirtyIds.has(s.id))
      return [...cleanFromServer, ...dirtyRows]
    })
    setOriginal(serverRules.map(r => ({ ...r })))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverRules])

  // Fetch de unmatched combos en mount y al cambiar de país.
  useEffect(() => {
    let cancel = false
    ;(async () => {
      const { data: combos } = await sb.rpc('list_unmatched_combos', { p_country: country, p_days: 7 })
      if (!cancel) setUnmatched(combos || [])
    })()
    return () => { cancel = true }
  }, [country])

  // Después de un save/delete local, refrescamos rules (SWR) y unmatched.
  async function load() {
    await reloadRules()
    const { data: combos } = await sb.rpc('list_unmatched_combos', { p_country: country, p_days: 7 })
    setUnmatched(combos || [])
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

  const isRowDirty = (r) => isRowDirtyAgainst(r, original)

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
      // Sacar la fila local recién guardada para que el sync effect
      // tras el reload la reemplace por la versión canónica del server
      // (con id real si era _new, updated_at fresco, etc.). Sin esto,
      // el dirty-tracking la dejaría marcada como dirty/duplicada.
      setRules(prev => prev.filter(r => r.id !== rule.id))
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
                <th scope="col">app</th><th scope="col">vc</th><th scope="col">ovc</th><th scope="col">db_city</th>
                <th style={{ textAlign: 'right' }}>n</th><th scope="col"></th>
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
            <th scope="col">app</th>
            <th scope="col">vc</th>
            <th scope="col">ovc</th>
            <th scope="col">Competidor</th>
            <th scope="col">Categoría</th>
            <th scope="col">Ciudades</th>
            <th scope="col">Activa</th>
            <th scope="col"></th>
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
                  <button className="btn-delete-sm" aria-label="Eliminar" onClick={() => deleteRule(rule.id)}>✕</button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
