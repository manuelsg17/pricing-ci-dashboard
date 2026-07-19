import { useEffect, useMemo, useState } from 'react'
import { Bot, Plus, Trash2, AlertTriangle, Save } from 'lucide-react'
import { sb } from '../../lib/supabase'
import { getCountryConfig, COMPETITOR_COLORS } from '../../lib/constants'
import { CATALOG_CATEGORIES, CATALOG_COMPETITORS } from '../../lib/catalogs'
import { useCountry } from '../../context/CountryContext'
import { useStaleWhileRevalidate } from '../../hooks/useStaleWhileRevalidate'
import { MultiCombobox } from '../ui/shadcn/multi-combobox'
import { Combobox } from '../ui/shadcn/combobox'
import SaveStatusBanner from './SaveStatusBanner'
import { useConfirm } from '../ui/ConfirmDialog'
import { useI18n } from '../../context/LanguageContext'
import { Button } from '../ui/shadcn/button'

// ovc admite variantes separadas por coma (misma convención que
// resolve_rule() en bot_sync_push.py y resolveByRules() en botMapping.js) —
// '*' (o lista vacía) sigue significando "cualquier valor" y absorbe
// cualquier otra variante que se le mezcle.
function normalizeOvc(raw) {
  const variants = [
    ...new Set(
      String(raw || '*')
        .toLowerCase()
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)
    ),
  ]
  if (variants.length === 0 || variants.includes('*')) return '*'
  return variants.join(', ')
}

function countOvcVariants(raw) {
  return String(raw || '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean).length
}

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
  // dbConfigs es obligatorio acá: países DB-only (Bolivia, Nepal, etc.)
  // tienen una entrada hardcoded "stub" en constants.js con solo la data
  // del scaffolding inicial (ej. Bolivia: solo 'Santa Cruz'). Sin pasar
  // dbConfigs, getCountryConfig() devuelve ese stub viejo y las ciudades
  // agregadas después desde Config → Países (ej. Cochabamba, La Paz) no
  // aparecen acá — bug real reportado onboardeando Bolivia.
  const { dbConfigs } = useCountry()
  const config = getCountryConfig(country, dbConfigs)
  const confirm = useConfirm()
  const { t } = useI18n()

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

  // Si ya existe una regla activa con el mismo app+vc (y compatible en
  // ciudades — si no, el problema real es la ciudad, no el ovc), el combo
  // no matcheado casi siempre es "la app mandó otro texto para lo mismo".
  // En ese caso conviene agregar la variante a esa regla en vez de crear
  // una fila nueva — es el pedido explícito del usuario.
  function findExistingRule(combo) {
    const appLc = (combo.app || '').toLowerCase()
    const vcLc = (combo.vc || '').toLowerCase()
    return rules.find((r) => {
      if (!r.active) return false
      if ((r.app || '').toLowerCase() !== appLc) return false
      if ((r.vc || '').toLowerCase() !== vcLc) return false
      const cities = r.cities || []
      if (cities.length > 0 && combo.db_city && !cities.includes(combo.db_city)) return false
      return true
    })
  }

  function appendVariantToExisting(combo) {
    const existing = findExistingRule(combo)
    if (!existing) return
    const merged = normalizeOvc(`${existing.ovc || ''}, ${combo.ovc || ''}`)
    updateRule(existing.id, 'ovc', merged)
    setMsg({
      type: 'ok',
      text: t('config.botrules.append_variant_msg', {
        ovc: combo.ovc || '*',
        app: existing.app,
        vc: existing.vc,
      }),
    })
    setShowUnmatched(false)
  }

  const isRowDirty = (r) => isRowDirtyAgainst(r, original)

  async function saveRule(rule) {
    if (!rule.app || !rule.vc || !rule.competition_name || !rule.category) {
      setMsg({ type: 'err', text: t('config.botrules.err_required') })
      return
    }
    setSaving(true)
    setMsg(null)
    const payload = {
      country,
      app: rule.app.toLowerCase().trim(),
      vc: rule.vc.toLowerCase().trim(),
      ovc: normalizeOvc(rule.ovc),
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
      setMsg({ type: 'err', text: t('config.thresholds.save_error', { msg: err.message }) })
    } else {
      setMsg({
        type: 'ok',
        text: t('config.botrules.saved_toast', {
          app: payload.app,
          vc: payload.vc,
          ovc: payload.ovc,
          competitor: payload.competition_name,
          category: payload.category,
        }),
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
      title: t('config.botrules.delete_confirm_title'),
      message: t('config.botrules.delete_confirm_message'),
      danger: true,
      confirmText: t('app.delete'),
    })
    if (!ok) return
    const { error } = await sb.from('bot_rules').delete().eq('id', id)
    if (!error) {
      setMsg({ type: 'ok', text: t('config.botrules.delete_success') })
      await load()
    } else {
      setMsg({ type: 'err', text: t('config.citimeslots.delete_error', { msg: error.message }) })
    }
  }

  if (loading) return <div className="config-loading">{t('config.botrules.loading')}</div>

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
        {t('config.botrules.title', { country })}
      </h2>
      <p style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 8 }}>
        {t('config.botrules.desc')}
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
        {t('config.botrules.example')}
      </div>

      <SaveStatusBanner status={msg} onDismiss={() => setMsg(null)} />

      <div style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center' }}>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="border-dashed border-border text-muted hover:border-yango hover:text-yango"
          onClick={() => addRule()}
        >
          <Plus size={13} />
          {t('config.botrules.add_btn')}
        </Button>
        {unmatched.length > 0 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="border-amber-500 bg-amber-50 text-amber-900 hover:bg-amber-100"
            onClick={() => setShowUnmatched((v) => !v)}
          >
            <AlertTriangle size={13} />
            {t('config.botrules.unmatched_count', {
              n: unmatched.length,
              count: unmatched.length,
            })}{' '}
            ({showUnmatched ? t('config.botrules.hide') : t('config.botrules.view')})
          </Button>
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
            {t('config.botrules.unmatched_desc')}
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
              {unmatched.map((c, i) => {
                const existing = findExistingRule(c)
                return (
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
                      {existing ? (
                        <Button type="button" size="sm" onClick={() => appendVariantToExisting(c)}>
                          <Plus size={11} />
                          {t('config.botrules.append_variant_btn')}
                        </Button>
                      ) : (
                        <Button type="button" size="sm" onClick={() => addFromUnmatched(c)}>
                          <Plus size={11} />
                          {t('config.botrules.add_short')}
                        </Button>
                      )}
                    </td>
                  </tr>
                )
              })}
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
              {t('config.botrules.section_bot_sends')}
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
              {t('config.botrules.section_dashboard_view')}
            </th>
            <th colSpan={3} style={{ borderBottom: 'none' }}></th>
          </tr>
          <tr>
            <th scope="col" title={t('config.botrules.app_title')}>
              app
            </th>
            <th scope="col" title={t('config.botrules.vc_title')}>
              vc
            </th>
            <th scope="col" title={t('config.botrules.ovc_title')}>
              ovc
            </th>
            <th scope="col">{t('config.commissions.col_competitor')}</th>
            <th scope="col">{t('filter.category')}</th>
            <th scope="col" title={t('config.botrules.cities_title')}>
              {t('config.botrules.col_cities')}
            </th>
            <th scope="col">{t('config.bands.col_active')}</th>
            <th scope="col"></th>
          </tr>
        </thead>
        <tbody>
          {rules.map((rule) => {
            const dirty = isRowDirty(rule)
            return (
              <tr
                key={rule.id}
                style={{ verticalAlign: 'top', ...(dirty ? { background: '#fffbeb' } : {}) }}
              >
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
                  {countOvcVariants(rule.ovc) > 1 && (
                    <div style={{ fontSize: 9, color: 'var(--color-muted)', marginTop: 2 }}>
                      {t('config.botrules.ovc_variants_hint', { n: countOvcVariants(rule.ovc) })}
                    </div>
                  )}
                </td>
                <td style={{ textAlign: 'left', minWidth: 130 }}>
                  <Combobox
                    items={competitorItems}
                    value={rule.competition_name || ''}
                    onValueChange={(v) => updateRule(rule.id, 'competition_name', v)}
                    placeholder={t('config.bands.select_placeholder')}
                    searchPlaceholder={t('config.commissions.search_competitor')}
                    emptyText={t('config.commissions.no_results')}
                    triggerClassName="text-xs"
                    style={dirty ? dirtyTriggerStyle : undefined}
                  />
                </td>
                <td style={{ textAlign: 'left', minWidth: 120 }}>
                  <Combobox
                    items={categoryItems}
                    value={rule.category || ''}
                    onValueChange={(v) => updateRule(rule.id, 'category', v)}
                    placeholder={t('config.bands.select_placeholder')}
                    searchPlaceholder={t('config.bands.search_category')}
                    emptyText={t('config.commissions.no_results')}
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
                      allLabel={t('config.commissions.all_cities')}
                      searchPlaceholder={t('config.commissions.search_city')}
                      emptyText={t('config.botrules.city_not_found')}
                      style={dirty ? dirtyTriggerStyle : undefined}
                      triggerClassName="text-xs"
                    />
                  </div>
                </td>
                <td style={{ textAlign: 'center' }}>
                  <label
                    className="toggle-switch"
                    title={
                      rule.active
                        ? t('config.bands.active_title')
                        : t('config.bands.inactive_title')
                    }
                  >
                    <input
                      type="checkbox"
                      checked={!!rule.active}
                      onChange={(e) => updateRule(rule.id, 'active', e.target.checked)}
                    />
                    <span className="toggle-track" />
                  </label>
                </td>
                <td>
                  {/* Envuelto en un div flex en vez de display:flex directo en
                      el <td> — con la fila estirada por el MultiCombobox de
                      ciudades (chips en varias líneas), un <td> con display:flex
                      deja de comportarse como celda de tabla y los botones
                      terminan sin renderizarse visibles. */}
                  <div style={{ display: 'flex', gap: 6 }}>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => saveRule(rule)}
                      disabled={saving || !dirty}
                      title={!dirty ? t('config.commissions.no_changes_title') : undefined}
                    >
                      <Save size={11} />
                      {rule._new ? t('config.commissions.create_btn') : t('app.save')}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="border-red-300 text-red-600 hover:bg-red-100"
                      aria-label={t('app.delete')}
                      title={t('app.delete')}
                      onClick={() => deleteRule(rule.id)}
                    >
                      <Trash2 size={12} />
                    </Button>
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
