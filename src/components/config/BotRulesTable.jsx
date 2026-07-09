import { useEffect, useMemo, useState } from 'react'
import { Bot, Plus, Trash2, AlertTriangle, Save } from 'lucide-react'
import { sb } from '../../lib/supabase'
import { getCountryConfig, COMPETITOR_COLORS } from '../../lib/constants'
import { CATALOG_CATEGORIES, CATALOG_COMPETITORS } from '../../lib/catalogs'
import { useStaleWhileRevalidate } from '../../hooks/useStaleWhileRevalidate'
import { MultiCombobox } from '../ui/shadcn/multi-combobox'
import { Combobox } from '../ui/shadcn/combobox'
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
    Object.values(config.categoriesByCity || {}).forEach((list) => list.forEach((c) => cats.add(c)))
    CATALOG_CATEGORIES.forEach((c) => cats.add(c.value))
    return Array.from(cats).sort()
  }, [config])

  const allCompetitors = useMemo(() => {
    const comps = new Set()
    Object.values(config.competitorsByDbCityCategory || {}).forEach((byCat) =>
      Object.values(byCat).forEach((list) => list.forEach((c) => comps.add(c)))
    )
    CATALOG_COMPETITORS.forEach((c) => comps.add(c.value))
    return Array.from(comps).sort()
  }, [config])

  // Ciudades válidas del país — misma fuente canónica que el resto del
  // dashboard (Config→Comisiones, InDrive, etc). Ya NO se puede tipear una
  // ciudad a mano: solo se elige de esta lista, así un typo no rompe el
  // matching del bot en silencio.
  const cityItems = useMemo(() => config.dbCities.map((c) => ({ value: c, label: c })), [config])

  // Items para los Combobox de Competidor/Categoría — el competidor lleva
  // su color de marca (COMPETITOR_COLORS) para el dot en el dropdown.
  const competitorItems = useMemo(
    () => allCompetitors.map((c) => ({ value: c, label: c, color: COMPETITOR_COLORS[c] })),
    [allCompetitors]
  )
  const categoryItems = useMemo(
    () => allCategories.map((c) => ({ value: c, label: c })),
    [allCategories]
  )

  const {
    data: serverRules,
    loading,
    reload: reloadRules,
  } = useStaleWhileRevalidate({
    key: `cfg.bot_rules.${country}`,
    enabled: !!country,
    liveSyncTable: 'bot_rules',
    fetcher: async () => {
      const { data, error } = await sb
        .from('bot_rules')
        .select('*')
        .eq('country', country)
        .order('app')
        .order('vc')
        .order('ovc')
      if (error) throw error
      return data || []
    },
  })

  const [rules, setRules] = useState([])
  const [original, setOriginal] = useState([])
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState(null)
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
    const orig = snapshot.find((o) => o.id === r.id)
    if (!orig) return true
    return (
      r.app !== orig.app ||
      r.vc !== orig.vc ||
      r.ovc !== orig.ovc ||
      r.competition_name !== orig.competition_name ||
      r.category !== orig.category ||
      r.active !== orig.active ||
      JSON.stringify(r.cities || []) !== JSON.stringify(orig.cities || [])
    )
  }

  // Sincronizar server → state local cuando llega data fresca.
  // Preservamos filas dirty (_new o con cambios sin guardar) para no
  // pisar trabajo del usuario si otra sesión escribe mientras edita.
  useEffect(() => {
    if (!serverRules) return
    setRules((prev) => {
      const dirtyRows = prev.filter((r) => isRowDirtyAgainst(r, original))
      const dirtyIds = new Set(dirtyRows.map((r) => r.id))
      const cleanFromServer = serverRules.filter((s) => !dirtyIds.has(s.id))
      return [...cleanFromServer, ...dirtyRows]
    })
    setOriginal(serverRules.map((r) => ({ ...r })))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverRules])

  // Fetch de unmatched combos en mount y al cambiar de país.
  useEffect(() => {
    let cancel = false
    ;(async () => {
      const { data: combos } = await sb.rpc('list_unmatched_combos', {
        p_country: country,
        p_days: 7,
      })
      if (!cancel) setUnmatched(combos || [])
    })()
    return () => {
      cancel = true
    }
  }, [country])

  // Después de un save/delete local, refrescamos rules (SWR) y unmatched.
  async function load() {
    await reloadRules()
    const { data: combos } = await sb.rpc('list_unmatched_combos', {
      p_country: country,
      p_days: 7,
    })
    setUnmatched(combos || [])
  }

  function updateRule(id, field, val) {
    setMsg(null)
    setRules((prev) => prev.map((r) => (r.id === id ? { ...r, [field]: val } : r)))
  }

  function addRule(prefill = {}) {
    const tempId = `new_${Date.now()}_${Math.random()}`
    setMsg(null)
    setRules((prev) => [
      ...prev,
      {
        id: tempId,
        app: prefill.app || '',
        vc: prefill.vc || '',
        ovc: prefill.ovc || '*',
        competition_name: prefill.competition_name || allCompetitors[0] || 'Yango',
        category: prefill.category || allCategories[0] || 'Economy',
        cities: prefill.cities || [],
        active: true,
        _new: true,
      },
    ])
    setShowUnmatched(false)
  }

  function addFromUnmatched(combo) {
    // Heurística: inferir competidor desde el app (yango_api → Yango, etc.)
    // y categoría desde el vc (moto → Bike, economy → Economy, ...).
    const appLc = (combo.app || '').toLowerCase()
    const vcLc = (combo.vc || '').toLowerCase()
    let inferredComp =
      allCompetitors.find((c) =>
        c.toLowerCase().includes(appLc.replace('_api', '').replace('drive', ''))
      ) || ''
    if (!inferredComp && appLc.includes('yango')) inferredComp = 'Yango'
    if (!inferredComp && appLc.includes('indrive')) inferredComp = 'InDrive'
    if (!inferredComp && appLc.includes('didi')) inferredComp = 'Didi'
    if (!inferredComp && appLc.includes('uber')) inferredComp = 'Uber'
    if (!inferredComp && appLc.includes('picap')) inferredComp = 'Picap'
    let inferredCat = ''
    if (vcLc.includes('moto') || vcLc.includes('bike')) inferredCat = 'Bike'
    else if (vcLc.includes('comfort')) inferredCat = 'Comfort'
    else if (vcLc.includes('economy')) inferredCat = 'Economy'
    addRule({
      app: combo.app || '',
      vc: combo.vc || '',
      ovc: combo.ovc || '*',
      competition_name: inferredComp,
      category: inferredCat,
      // Si combo.db_city no está en config.dbCities (país mal configurado,
      // ciudad nueva sin dar de alta, etc.), el MultiCombobox lo muestra
      // como chip rojo "⚠" en vez de perderlo en silencio.
      cities: combo.db_city ? [combo.db_city] : [],
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
      app: rule.app.toLowerCase().trim(),
      vc: rule.vc.toLowerCase().trim(),
      ovc: (rule.ovc || '*').toLowerCase().trim(),
      competition_name: rule.competition_name,
      category: rule.category,
      cities: rule.cities || [],
      active: !!rule.active,
    }
    let err
    if (rule._new) {
      ;({ error: err } = await sb.from('bot_rules').insert(payload))
    } else {
      ;({ error: err } = await sb
        .from('bot_rules')
        .update({ ...payload, updated_at: new Date().toISOString() })
        .eq('id', rule.id))
    }
    if (err) {
      setMsg({ type: 'err', text: 'Error al guardar: ' + err.message })
    } else {
      setMsg({
        type: 'ok',
        text: `Regla guardada: ${payload.app} / ${payload.vc} / ${payload.ovc} → ${payload.competition_name} / ${payload.category}`,
      })
      // Sacar la fila local recién guardada para que el sync effect
      // tras el reload la reemplace por la versión canónica del server
      // (con id real si era _new, updated_at fresco, etc.). Sin esto,
      // el dirty-tracking la dejaría marcada como dirty/duplicada.
      setRules((prev) => prev.filter((r) => r.id !== rule.id))
      await load()
    }
    setSaving(false)
  }

  async function deleteRule(id) {
    if (String(id).startsWith('new_')) {
      setRules((prev) => prev.filter((r) => r.id !== id))
      return
    }
    const ok = await confirm({
      title: 'Eliminar regla bot',
      message:
        '¿Eliminar esta regla? Filas del bot que matchaban esta regla dejarán de procesarse.',
      danger: true,
      confirmText: 'Eliminar',
    })
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
    background: '#fef3c7',
    borderColor: '#f59e0b',
    fontWeight: 600,
    boxShadow: '0 0 0 2px rgba(245, 158, 11, 0.2)',
  }

  // Variante sin boxShadow para triggers de Combobox/MultiCombobox: el
  // boxShadow inline estático taparía siempre el anillo de :focus-visible
  // (Tailwind, también box-shadow) — con esta variante el fondo/borde
  // amarillo sigue marcando "dirty" pero el foco de teclado sigue visible.
  const dirtyTriggerStyle = {
    background: dirtyCellStyle.background,
    borderColor: dirtyCellStyle.borderColor,
    fontWeight: dirtyCellStyle.fontWeight,
  }

  // app/vc/ovc son valores técnicos crudos que manda el scraper — monospace
  // los distingue visualmente de los dropdowns validados (Competidor/Categoría).
  const monoInputStyle = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }

  return (
    <div className="config-section">
      <h2 className="with-icon">
        <Bot size={15} />
        Reglas del Bot — {country}
      </h2>
      <p style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 8 }}>
        El bot scrapea precios y los manda con sus propios nombres técnicos. Estas reglas son el{' '}
        <strong>traductor</strong>: le dicen al sistema “cuando llegue esto del bot, guardalo como
        este competidor y esta categoría”.{' '}
        <strong>Si un precio del bot no matchea ninguna regla, se descarta</strong> — por eso el
        botón amarillo de abajo te avisa si está llegando data que se está perdiendo.
      </p>
      <div
        style={{
          fontSize: 11,
          color: 'var(--color-muted)',
          marginBottom: 12,
          padding: '8px 10px',
          background: '#f8fafc',
          border: '1px solid var(--color-border, #e2e8f0)',
          borderRadius: 6,
        }}
      >
        <strong>Ejemplo:</strong> el bot manda <code>app=uber_api · vc=comfort · ovc=*</code> → la
        regla lo traduce a <strong>Uber / Comfort</strong>. El <code>*</code> significa “cualquier
        valor”. Ciudades vacío = aplica a todo el país.
      </div>

      <SaveStatusBanner status={msg} onDismiss={() => setMsg(null)} />

      <div style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center' }}>
        <button
          className="btn-add-row"
          onClick={() => addRule()}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
        >
          <Plus size={13} />
          Nueva regla
        </button>
        {unmatched.length > 0 && (
          <button
            onClick={() => setShowUnmatched((v) => !v)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 12px',
              borderRadius: 6,
              border: '1px solid #f59e0b',
              background: '#fffbeb',
              cursor: 'pointer',
              fontSize: 12,
              color: '#78350f',
            }}
          >
            <AlertTriangle size={13} />
            {unmatched.length} combos no matcheados ({showUnmatched ? 'ocultar' : 'ver'})
          </button>
        )}
      </div>

      {showUnmatched && unmatched.length > 0 && (
        <div
          style={{
            marginBottom: 16,
            padding: 12,
            borderRadius: 8,
            background: '#fef3c7',
            border: '1px solid #f59e0b',
            maxHeight: 240,
            overflowY: 'auto',
          }}
        >
          <div style={{ fontSize: 11, color: '#78350f', marginBottom: 8, fontWeight: 600 }}>
            Combinaciones (app, vc, ovc, city) que aparecen en el bot pero no matchean ninguna regla
            activa (últimos 7 días). Hacé clic en <strong>+ Agregar</strong> para crear una regla
            pre-rellenada.
          </div>
          <table className="config-table" style={{ fontSize: 11 }}>
            <thead>
              <tr>
                <th scope="col">app</th>
                <th scope="col">vc</th>
                <th scope="col">ovc</th>
                <th scope="col">db_city</th>
                <th style={{ textAlign: 'right' }}>n</th>
                <th scope="col"></th>
              </tr>
            </thead>
            <tbody>
              {unmatched.map((c, i) => (
                <tr key={i}>
                  <td>
                    <code>{c.app || '∅'}</code>
                  </td>
                  <td>
                    <code>{c.vc || '∅'}</code>
                  </td>
                  <td>
                    <code>{c.ovc || '*'}</code>
                  </td>
                  <td>{c.db_city || '∅'}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>
                    {Number(c.total_n).toLocaleString()}
                  </td>
                  <td>
                    <button
                      className="btn-save-sm"
                      onClick={() => addFromUnmatched(c)}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                    >
                      <Plus size={11} />
                      Agregar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <table className="config-table config-table--modern" style={{ marginTop: 4 }}>
        <thead>
          <tr>
            <th
              colSpan={3}
              style={{
                textAlign: 'center',
                fontSize: 10,
                color: 'var(--color-muted)',
                borderBottom: 'none',
                paddingBottom: 0,
              }}
            >
              LO QUE MANDA EL BOT
            </th>
            <th
              colSpan={2}
              style={{
                textAlign: 'center',
                fontSize: 10,
                color: 'var(--color-muted)',
                borderBottom: 'none',
                paddingBottom: 0,
              }}
            >
              → CÓMO LO VES EN EL DASHBOARD
            </th>
            <th colSpan={3} style={{ borderBottom: 'none' }}></th>
          </tr>
          <tr>
            <th scope="col" title="Identificador de la app en el scraper (ej: uber_api, yango_api)">
              app
            </th>
            <th scope="col" title="Categoría de vehículo según el bot (ej: economy, comfort)">
              vc
            </th>
            <th scope="col" title="Categoría original del competidor. * = cualquier valor">
              ovc
            </th>
            <th scope="col">Competidor</th>
            <th scope="col">Categoría</th>
            <th scope="col" title="Vacío = todas las ciudades del país">
              Ciudades
            </th>
            <th scope="col">Activa</th>
            <th scope="col"></th>
          </tr>
        </thead>
        <tbody>
          {rules.map((rule) => {
            const dirty = isRowDirty(rule)
            return (
              <tr key={rule.id} style={dirty ? { background: '#fffbeb' } : undefined}>
                <td>
                  <input
                    type="text"
                    value={rule.app || ''}
                    onChange={(e) => updateRule(rule.id, 'app', e.target.value)}
                    style={{ width: 100, ...monoInputStyle, ...(dirty ? dirtyCellStyle : {}) }}
                  />
                </td>
                <td>
                  <input
                    type="text"
                    value={rule.vc || ''}
                    onChange={(e) => updateRule(rule.id, 'vc', e.target.value)}
                    style={{ width: 100, ...monoInputStyle, ...(dirty ? dirtyCellStyle : {}) }}
                  />
                </td>
                <td>
                  <input
                    type="text"
                    value={rule.ovc || ''}
                    onChange={(e) => updateRule(rule.id, 'ovc', e.target.value)}
                    placeholder="*"
                    style={{ width: 100, ...monoInputStyle, ...(dirty ? dirtyCellStyle : {}) }}
                  />
                </td>
                <td style={{ textAlign: 'left', minWidth: 130 }}>
                  <Combobox
                    items={competitorItems}
                    value={rule.competition_name || ''}
                    onValueChange={(v) => updateRule(rule.id, 'competition_name', v)}
                    placeholder="— Elegir —"
                    searchPlaceholder="Buscar competidor…"
                    emptyText="Sin resultados."
                    triggerClassName="text-xs"
                    style={dirty ? dirtyTriggerStyle : undefined}
                  />
                </td>
                <td style={{ textAlign: 'left', minWidth: 120 }}>
                  <Combobox
                    items={categoryItems}
                    value={rule.category || ''}
                    onValueChange={(v) => updateRule(rule.id, 'category', v)}
                    placeholder="— Elegir —"
                    searchPlaceholder="Buscar categoría…"
                    emptyText="Sin resultados."
                    triggerClassName="text-xs"
                    style={dirty ? dirtyTriggerStyle : undefined}
                  />
                </td>
                <td style={{ textAlign: 'left', minWidth: 220 }}>
                  <div style={{ maxWidth: 380 }}>
                    <MultiCombobox
                      items={cityItems}
                      value={rule.cities || []}
                      onValueChange={(v) => updateRule(rule.id, 'cities', v)}
                      allLabel="Todas las ciudades"
                      searchPlaceholder="Buscar ciudad…"
                      emptyText="Ciudad no encontrada."
                      style={dirty ? dirtyTriggerStyle : undefined}
                      triggerClassName="text-xs"
                    />
                  </div>
                </td>
                <td style={{ textAlign: 'center' }}>
                  <label className="toggle-switch" title={rule.active ? 'Activa' : 'Inactiva'}>
                    <input
                      type="checkbox"
                      checked={!!rule.active}
                      onChange={(e) => updateRule(rule.id, 'active', e.target.checked)}
                    />
                    <span className="toggle-track" />
                  </label>
                </td>
                <td style={{ display: 'flex', gap: 6 }}>
                  <button
                    className="btn-save-sm"
                    onClick={() => saveRule(rule)}
                    disabled={saving || !dirty}
                    title={!dirty ? 'Sin cambios' : undefined}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                  >
                    <Save size={11} />
                    {rule._new ? 'Crear' : 'Guardar'}
                  </button>
                  <button
                    className="btn-delete-sm"
                    aria-label="Eliminar"
                    title="Eliminar"
                    onClick={() => deleteRule(rule.id)}
                  >
                    <Trash2 size={12} />
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
