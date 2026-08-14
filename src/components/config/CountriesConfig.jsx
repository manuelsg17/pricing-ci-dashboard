import { useState, useEffect, useCallback } from 'react'
import { sb } from '../../lib/supabase'
import { COUNTRY_CONFIG, COMPETITOR_COLORS, CURRENCY_PRESETS } from '../../lib/constants'
import { CATALOG_CATEGORIES } from '../../lib/catalogs'
import { useCountry } from '../../context/CountryContext'
import { useConfirm } from '../ui/ConfirmDialog'
import CountryWizard from './CountryWizard'
import { Button } from '../ui/shadcn/button'
import { Eye, EyeOff, StickyNote } from 'lucide-react'
import { useI18n } from '../../context/LanguageContext'

const CONST_KEYS = Object.keys(COUNTRY_CONFIG)
const ALL_COMPETITORS = Object.keys(COMPETITOR_COLORS)

// COMPETITOR_COLORS mezcla, a propósito (ver constants.js), 3 grupos:
// competidores normales (Uber, Didi, InDrive...), tiers exclusivos del
// negocio B2B "Corp" de Perú (YangoEconomy/Premier/XL/Plus, CabifyLite/
// ExtraComfort/XL), y formas legacy con espacio pre-mig-72 (retrocompat
// para leer reportes viejos, nunca válidas para elegir de nuevo). El
// dropdown de "agregar competidor" no debe ofrecer ninguno de los dos
// últimos grupos salvo que se esté editando la ciudad "Corp" de Perú —
// si no, cualquier país nuevo ve una lista de 29 opciones sin sentido
// para su caso (bug reportado onboardeando Bolivia).
const LEGACY_SPACE_FORM_COMPETITORS = new Set([
  'Yango Economy',
  'Yango Comfort',
  'Yango Comfort+',
  'Yango Premier',
  'Yango XL',
  'Cabify Lite',
  'Cabify Extra Comfort',
  'Cabify XL',
])
const CORP_ONLY_COMPETITORS = new Set([
  'YangoEconomy',
  'YangoComfort+',
  'YangoPremier',
  'YangoXL',
  'YangoPlus',
  'CabifyLite',
  'CabifyExtraComfort',
  'CabifyXL',
])

// ── Style helpers ─────────────────────────────────────────────────────

const fieldLabelStyle = {
  display: 'block',
  fontSize: 10,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  color: 'var(--color-muted)',
  marginBottom: 3,
  marginTop: 8,
}

function inputStyle(disabled) {
  return {
    width: '100%',
    padding: '4px 6px',
    border: '1.5px solid var(--color-border)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 12,
    background: disabled ? 'var(--color-bg)' : 'var(--color-panel)',
    color: disabled ? 'var(--color-muted)' : 'var(--color-text)',
    boxSizing: 'border-box',
    outline: 'none',
  }
}

const competitorTagStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '2px 8px',
  fontSize: 11,
  background: 'rgba(229,57,53,0.08)',
  border: '1px solid rgba(229,57,53,0.25)',
  borderRadius: 12,
  color: '#b71c1c',
  fontWeight: 600,
}

// ── Sub-component: add-competitor dropdown ────────────────────────────

function CompetitorAdder({ existing, onAdd, allowCorpTiers }) {
  const { t } = useI18n()
  const [val, setVal] = useState('')
  const available = ALL_COMPETITORS.filter(
    (c) =>
      !existing.includes(c) &&
      !LEGACY_SPACE_FORM_COMPETITORS.has(c) &&
      (allowCorpTiers || !CORP_ONLY_COMPETITORS.has(c))
  )
  return (
    <div style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
      <select
        value={val}
        onChange={(e) => setVal(e.target.value)}
        style={{
          fontSize: 11,
          padding: '2px 4px',
          border: '1px dashed var(--color-border)',
          borderRadius: 'var(--radius-sm)',
          background: 'var(--color-panel)',
        }}
      >
        <option value="">{t('config.countries_config.add_adder_placeholder')}</option>
        {available.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      {val && (
        <Button
          size="sm"
          className="h-[22px] px-2 text-[10px]"
          onClick={() => {
            onAdd(val)
            setVal('')
          }}
        >
          OK
        </Button>
      )}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────

export default function CountriesConfig() {
  const { refreshConfigs } = useCountry()
  const confirm = useConfirm()
  const { t } = useI18n()

  const [dbRows, setDbRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [selectedKey, setSelectedKey] = useState(null)
  const [selectedCityIdx, setSelectedCityIdx] = useState(null)
  // Qué chip de competidor tiene abierto el editor de nota ahora mismo —
  // 'catIdx|competidor' o null. Un solo campo global alcanza: nunca hay dos
  // abiertos a la vez, y así no hace falta un mapa de estado por chip.
  const [editingNoteFor, setEditingNoteFor] = useState(null)
  const [draft, setDraft] = useState({})
  const [savingKey, setSavingKey] = useState(null)
  const [msg, setMsg] = useState(null)
  // Modo wizard vs avanzado. El wizard guía paso a paso; el modo
  // avanzado es el formulario flat de siempre (sin breaking change).
  const [showWizard, setShowWizard] = useState(false)
  // Conteo de bot_rules (tabla SQL, la que usa mapBotRows para el matching
  // real) por país — 0 significa que TODO lo que llegue del bot para ese
  // país se descarta en silencio hasta que se configuren reglas.
  const [botRuleCounts, setBotRuleCounts] = useState({})

  const loadRows = useCallback(async () => {
    setLoading(true)
    const { data } = await sb.from('country_config').select('*').order('sort_order')
    setDbRows(data || [])
    setLoading(false)
  }, [])

  const loadBotRuleCounts = useCallback(async () => {
    const { data } = await sb.from('bot_rules').select('country')
    const counts = {}
    for (const row of data || []) {
      counts[row.country] = (counts[row.country] || 0) + 1
    }
    setBotRuleCounts(counts)
  }, [])

  useEffect(() => {
    loadRows()
    loadBotRuleCounts()
  }, [loadRows, loadBotRuleCounts])

  // ── Derived helpers ───────────────────────────────────────────────

  const dbKeys = dbRows.map((r) => r.country_key)
  const dbOnlyKeys = dbKeys.filter((k) => !CONST_KEYS.includes(k))
  const allKeys = [...CONST_KEYS, ...dbOnlyKeys]

  const isDbManaged = (key) => dbRows.some((r) => r.country_key === key)
  const isReadOnly = (key) => CONST_KEYS.includes(key) && !isDbManaged(key)

  // Detecta si el draft difiere del row de DB. Útil para mostrar
  // indicadores visuales y para confirmar antes de descartar cambios.
  // Compara solo campos persistidos para evitar falsos positivos
  // (e.g. updated_at, id).
  function isDirty(key) {
    if (!draft[key]) return false
    const dbRow = dbRows.find((r) => r.country_key === key)
    if (!dbRow) return true // recién creado en memoria
    // FIELDS incluye los campos JSONB de mig 58 (bot_rules,
    // airport_subcategories_by_city) — sin ellos, editar reglas o
    // subcategorías no se reflejaba en el botón Guardar/Cancelar.
    const FIELDS = [
      'label',
      'currency',
      'locale',
      'outlier_threshold',
      'max_price',
      'sort_order',
      'cities',
      'iso2',
      'native_label',
      'status',
      'bot_rules',
      'airport_subcategories_by_city',
      // Mig 183 agregó `timezone` y la 216 `projects_risk_days`, pero ninguna
      // llegó a esta lista: editarlas no encendía el botón Guardar y el cambio
      // se perdía sin que la pantalla dijera nada.
      'timezone',
      'projects_risk_days',
    ]
    return FIELDS.some((f) => JSON.stringify(draft[key][f]) !== JSON.stringify(dbRow[f]))
  }

  // Descarta cambios sin guardar. Tres casos:
  //   1. País nuevo en memoria (NewCountry_*) sin save → eliminar entero
  //   2. País en DB con draft modificado → revertir draft a DB
  //   3. País sin cambios → no-op (botón estará disabled)
  async function handleCancel(key) {
    const dbRow = dbRows.find((r) => r.country_key === key)
    const isNewInMemory = !dbRow && key.startsWith('NewCountry_')

    if (isNewInMemory) {
      const ok = await confirm({
        title: t('config.countries_config.discard_new_title'),
        message: t('config.countries_config.discard_new_message', {
          label: draft[key]?.label || key,
        }),
        confirmText: t('config.country_wizard.cancel_confirm_btn'),
        cancelText: t('config.countries_config.keep_editing_btn'),
        danger: true,
      })
      if (!ok) return
      setDbRows((prev) => prev.filter((r) => r.country_key !== key))
      setDraft((prev) => {
        const n = { ...prev }
        delete n[key]
        return n
      })
      setSelectedKey(null)
      setSelectedCityIdx(null)
      setMsg({ type: 'ok', text: t('config.countries_config.discarded_toast') })
      return
    }

    if (!isDirty(key)) return // no-op defensivo

    const ok = await confirm({
      title: t('config.countries_config.discard_changes_title'),
      message: t('config.countries_config.discard_changes_message', {
        label: dbRow?.label || key,
      }),
      confirmText: t('config.country_wizard.cancel_confirm_btn'),
      cancelText: t('config.countries_config.keep_editing_btn'),
      danger: true,
    })
    if (!ok) return
    setDraft((prev) => {
      const n = { ...prev }
      delete n[key]
      return n
    })
    setSelectedCityIdx(null)
    setMsg({ type: 'ok', text: t('config.countries_config.discarded_changes_toast') })
  }

  // ── Draft helpers ─────────────────────────────────────────────────

  function getOrInitDraft(key) {
    if (draft[key]) return draft[key]
    const existing = dbRows.find((r) => r.country_key === key)
    if (existing) return JSON.parse(JSON.stringify(existing)) // deep clone
    return {
      country_key: key,
      label: key,
      currency: 'USD',
      locale: 'en-US',
      outlier_threshold: 100,
      max_price: 1000,
      timezone: 'UTC',
      projects_risk_days: 2,
      sort_order: dbRows.length,
      cities: [],
    }
  }

  function setDraftField(key, field, value) {
    const base = getOrInitDraft(key)
    setDraft((prev) => ({ ...prev, [key]: { ...base, [field]: value } }))
  }

  function setCity(key, cityIdx, cityObj) {
    const row = getOrInitDraft(key)
    const cities = [...(row.cities || [])]
    cities[cityIdx] = cityObj
    setDraft((prev) => ({ ...prev, [key]: { ...row, cities } }))
  }

  function addCity(key) {
    const row = getOrInitDraft(key)
    const cities = [
      ...(row.cities || []),
      { uiName: '', dbName: '', botKey: '', isVirtual: false, categories: [] },
    ]
    setDraft((prev) => ({ ...prev, [key]: { ...row, cities } }))
    setSelectedCityIdx(cities.length - 1)
  }

  function deleteCity(key, cityIdx) {
    const row = getOrInitDraft(key)
    const cities = row.cities.filter((_, i) => i !== cityIdx)
    setDraft((prev) => ({ ...prev, [key]: { ...row, cities } }))
    setSelectedCityIdx((prev) => (prev >= cities.length ? Math.max(0, cities.length - 1) : prev))
  }

  function addCategory(key, cityIdx) {
    const row = getOrInitDraft(key)
    const cities = row.cities.map((c, i) =>
      i !== cityIdx
        ? c
        : {
            ...c,
            categories: [
              ...(c.categories || []),
              { name: '', dbName: '', competitors: [], yangoDisplayName: 'Yango' },
            ],
          }
    )
    setDraft((prev) => ({ ...prev, [key]: { ...row, cities } }))
  }

  function deleteCategory(key, cityIdx, catIdx) {
    const row = getOrInitDraft(key)
    const cities = row.cities.map((c, i) =>
      i !== cityIdx ? c : { ...c, categories: c.categories.filter((_, ci) => ci !== catIdx) }
    )
    setDraft((prev) => ({ ...prev, [key]: { ...row, cities } }))
  }

  function setCategoryField(key, cityIdx, catIdx, field, value) {
    const row = getOrInitDraft(key)
    const cities = row.cities.map((c, i) => {
      if (i !== cityIdx) return c
      const categories = c.categories.map((cat, ci) =>
        ci !== catIdx ? cat : { ...cat, [field]: value }
      )
      return { ...c, categories }
    })
    setDraft((prev) => ({ ...prev, [key]: { ...row, cities } }))
  }

  function addCompetitor(key, cityIdx, catIdx, competitor) {
    const row = getOrInitDraft(key)
    const existing = row.cities[cityIdx].categories[catIdx].competitors
    if (competitor && !existing.includes(competitor)) {
      setCategoryField(key, cityIdx, catIdx, 'competitors', [...existing, competitor])
    }
  }

  function removeCompetitor(key, cityIdx, catIdx, competitor) {
    const row = getOrInitDraft(key)
    // Quitar el competidor de `competitors` Y de `ciHidden` en UNA sola
    // actualización (dos setCategoryField seguidos se pisaban: ambos leen el
    // mismo `row` del closure y el 2º reemplaza al 1º).
    const cities = row.cities.map((c, i) => {
      if (i !== cityIdx) return c
      const categories = c.categories.map((cat, ci) =>
        ci !== catIdx
          ? cat
          : {
              ...cat,
              competitors: (cat.competitors || []).filter((x) => x !== competitor),
              ciHidden: (cat.ciHidden || []).filter((x) => x !== competitor),
              competitorNotes: Object.fromEntries(
                Object.entries(cat.competitorNotes || {}).filter(([c]) => c !== competitor)
              ),
            }
      )
      return { ...c, categories }
    })
    setDraft((prev) => ({ ...prev, [key]: { ...row, cities } }))
  }

  // Marca/desmarca un competidor como "no ofrece esta categoría": se oculta SOLO
  // en Ingresar CI (lista paralela ciHidden), sigue en el dashboard/histórico.
  function toggleCiHidden(key, cityIdx, catIdx, competitor) {
    const row = getOrInitDraft(key)
    const existing = row.cities[cityIdx].categories[catIdx].ciHidden || []
    const next = existing.includes(competitor)
      ? existing.filter((c) => c !== competitor)
      : [...existing, competitor]
    setCategoryField(key, cityIdx, catIdx, 'ciHidden', next)
  }

  // Nota libre por competidor dentro de una categoría (caso real: Cabify tuvo
  // XL en Lima_Airport_A y dejó de actualizarse el 27-jul — sigue vivo en
  // Lima_Airport_B). No oculta nada, solo explica en la leyenda del
  // dashboard para que no se lea como un error de carga. Nota vacía = se
  // borra la entrada entera, no se deja un '' colgando en el JSON.
  function setCompetitorNote(key, cityIdx, catIdx, competitor, note) {
    const row = getOrInitDraft(key)
    const current = row.cities[cityIdx].categories[catIdx].competitorNotes || {}
    const next = { ...current }
    if (note && note.trim()) next[competitor] = note.trim()
    else delete next[competitor]
    setCategoryField(key, cityIdx, catIdx, 'competitorNotes', next)
  }

  // ── Save / Delete ─────────────────────────────────────────────────

  async function handleSave(key) {
    const row = draft[key] || dbRows.find((r) => r.country_key === key)
    if (!row) return
    setSavingKey(key)
    setMsg(null)
    const payload = {
      country_key: row.country_key,
      label: row.label,
      currency: row.currency,
      locale: row.locale,
      iso2: row.iso2 || null,
      native_label: row.native_label || row.label,
      status: row.status || 'active',
      outlier_threshold: Number(row.outlier_threshold),
      max_price: Number(row.max_price),
      // Las dos son nuevas en el payload. Un upsert de PostgREST no pisa las
      // columnas que no manda, así que hasta ahora simplemente NO había forma
      // de cambiarlas desde la app: quedaban en el valor que les puso la
      // migración, y un país creado por el wizard se quedaba en 'UTC' para
      // siempre — con "vence hoy" desfasado un día (§13.4).
      timezone: (row.timezone || 'UTC').trim(),
      projects_risk_days: Number(row.projects_risk_days ?? 2),
      sort_order: Number(row.sort_order ?? 0),
      cities: row.cities || [],
      // ★ Mig 58: preservar botRules y airport subcategorías si vinieron
      // del row de DB (no perderlos en el save).
      bot_rules: row.bot_rules || [],
      airport_subcategories_by_city: row.airport_subcategories_by_city || {},
      updated_at: new Date().toISOString(),
    }
    const { error } = await sb.from('country_config').upsert(payload, { onConflict: 'country_key' })
    if (!error) {
      // Limpiar draft del país recién guardado — evita que isDirty
      // siga true después del save.
      setDraft((prev) => {
        const n = { ...prev }
        delete n[key]
        return n
      })
      setMsg({ type: 'ok', text: t('config.countries_config.saved_toast') })
      await loadRows()
      refreshConfigs()
    } else {
      setMsg({
        type: 'err',
        text: t('config.countries_config.save_error', { error: error.message }),
      })
    }
    setSavingKey(null)
  }

  async function handleDeleteCountry(key) {
    const ok = await confirm({
      title: t('config.countries_config.delete_country_title'),
      message: t('config.countries_config.delete_country_message', { key }),
      danger: true,
      confirmText: t('app.delete'),
    })
    if (!ok) return
    await sb.from('country_config').delete().eq('country_key', key)
    setDbRows((prev) => prev.filter((r) => r.country_key !== key))
    setDraft((prev) => {
      const n = { ...prev }
      delete n[key]
      return n
    })
    if (selectedKey === key) {
      setSelectedKey(null)
      setSelectedCityIdx(null)
    }
    refreshConfigs()
  }

  function addNewCountry() {
    const key = `NewCountry_${Date.now()}`
    const preset = CURRENCY_PRESETS.USD
    const blank = {
      country_key: key,
      label: t('config.countries_config.new_country_label'),
      currency: 'USD',
      locale: preset.locale,
      outlier_threshold: preset.outlier_threshold,
      max_price: preset.max_price,
      sort_order: dbRows.length,
      cities: [],
    }
    setDbRows((prev) => [...prev, blank])
    setDraft((prev) => ({ ...prev, [key]: blank }))
    setSelectedKey(key)
    setSelectedCityIdx(null)
  }

  // Promociona un país hardcoded de constants.js a la DB country_config.
  // Esto lo desbloquea para edición. Después del save, el frontend
  // prioriza la fila de DB sobre el hardcoded de constants.js.
  async function makeEditable(key) {
    const hardcoded = COUNTRY_CONFIG[key]
    if (!hardcoded) {
      setMsg({ type: 'err', text: t('config.countries_config.not_in_constants_error', { key }) })
      return
    }

    // Check si ya existe row en DB — evita sobrescribir edits previos
    const existing = dbRows.find((r) => r.country_key === key)
    if (existing) {
      const reOk = await confirm({
        title: t('config.countries_config.repromote_title', { key }),
        message: t('config.countries_config.repromote_message'),
        confirmText: t('config.countries_config.repromote_confirm_btn'),
        cancelText: t('app.cancel'),
        danger: true,
      })
      if (!reOk) return
    } else {
      const ok = await confirm({
        title: t('config.countries_config.promote_title', { key }),
        message: t('config.countries_config.promote_message', { key }),
        confirmText: t('config.countries_config.promote_btn'),
        cancelText: t('app.cancel'),
      })
      if (!ok) return
    }

    // Reconstruir el shape de DB desde el config interno hardcoded.
    // El shape de DB tiene cities[] con categories[] anidadas — espejo
    // de getCountryConfig pero en sentido inverso.
    //
    // Edge case Peru: `Corp` aparece en dbCities pero NO en cities[] →
    // se marca isVirtual=true para que no aparezca en el selector UI.
    const dbCities = (hardcoded.dbCities || []).map((dbName) => {
      const uiIdx = (hardcoded.cities || []).indexOf(dbName)
      const isVirtual = uiIdx === -1 // no está en cities[] de UI
      const uiName = isVirtual ? dbName : hardcoded.cities[uiIdx] || dbName
      const categories = (hardcoded.categoriesByCity?.[dbName] || []).map((catName) => ({
        name: catName,
        dbName: catName,
        competitors: hardcoded.competitorsByDbCityCategory?.[dbName]?.[catName] || [],
        yangoDisplayName: hardcoded.yangoDisplayName?.[dbName]?.[catName] || 'Yango',
      }))
      // Buscar botKey en botCityMap (primer alias que mapee al dbName)
      const botKey =
        Object.entries(hardcoded.botCityMap || {}).find(([, v]) => v === dbName)?.[0] ||
        dbName.toLowerCase()
      return {
        uiName,
        dbName,
        botKey,
        isVirtual,
        categories,
      }
    })

    const row = {
      country_key: key,
      label: hardcoded.label || key,
      currency: hardcoded.currency || 'USD',
      locale: hardcoded.locale || 'es-PE',
      outlier_threshold: Number(hardcoded.outlierThreshold ?? 100),
      max_price: Number(hardcoded.maxPrice ?? 1000),
      iso2: hardcoded.iso2 || null,
      native_label: hardcoded.nativeLabel || hardcoded.label || key,
      // ★ Si row ya existe, preservar status y sort_order para no resetearlos
      status: existing?.status ?? 'active',
      sort_order: existing?.sort_order ?? dbRows.length,
      cities: dbCities,
      // ★ Mig 58: persistir botRules y airport subcategorías para no
      // perderlos en el upload manual CSV / dropdown aeropuerto.
      bot_rules: hardcoded.botRules || [],
      airport_subcategories_by_city: hardcoded.aeropuertoSubcategoriesByCity || {},
    }

    setSavingKey(key)
    const { error } = await sb.from('country_config').upsert(row, { onConflict: 'country_key' })
    setSavingKey(null)

    if (error) {
      setMsg({
        type: 'err',
        text: t('config.countries_config.promote_error', { key, error: error.message }),
      })
      return
    }

    // Limpiar draft del país recién promovido — evita que un draft stale
    // sobrescriba los datos recién hidratados de DB en el próximo save.
    setDraft((prev) => {
      const n = { ...prev }
      delete n[key]
      return n
    })

    setMsg({ type: 'ok', text: t('config.countries_config.promoted_toast', { key }) })
    await loadRows()
    refreshConfigs()
    setSelectedKey(key)
  }

  // Cuando el usuario cambia currency, si los valores actuales coinciden
  // con un preset previo (i.e. no fueron tocados manualmente), aplicar
  // el preset nuevo. Si el usuario ya editó manualmente, mantener sus
  // valores y solo cambiar el currency/locale.
  function setCurrency(key, newCurrency) {
    const row = getOrInitDraft(key)
    const preset = CURRENCY_PRESETS[newCurrency]
    if (!preset) {
      setDraftField(key, 'currency', newCurrency)
      return
    }
    // Detectar si el row actual usa los defaults de algún preset conocido
    const isUntouched = Object.values(CURRENCY_PRESETS).some(
      (p) =>
        Number(row.outlier_threshold) === p.outlier_threshold &&
        Number(row.max_price) === p.max_price
    )
    if (isUntouched) {
      setDraft((prev) => ({
        ...prev,
        [key]: {
          ...row,
          currency: newCurrency,
          locale: preset.locale,
          outlier_threshold: preset.outlier_threshold,
          max_price: preset.max_price,
        },
      }))
    } else {
      setDraftField(key, 'currency', newCurrency)
    }
  }

  // ── Derived active values ─────────────────────────────────────────

  const activeRow = selectedKey ? getOrInitDraft(selectedKey) : null
  const activeCities = activeRow?.cities || []
  const activeCity = selectedCityIdx != null ? activeCities[selectedCityIdx] : null
  const readonly = selectedKey ? isReadOnly(selectedKey) : false
  const activeRuleCount = selectedKey ? (botRuleCounts[selectedKey] ?? 0) : 0

  // ── Render ────────────────────────────────────────────────────────

  if (loading) return <div className="config-loading">{t('config.countries_config.loading')}</div>

  // Wizard mode: pantalla completa para no perder al usuario en pasos
  if (showWizard) {
    return (
      <CountryWizard
        onClose={() => setShowWizard(false)}
        onCreated={(key) => {
          setShowWizard(false)
          refreshConfigs()
          loadRows()
          setSelectedKey(key)
        }}
      />
    )
  }

  return (
    <div
      style={{
        display: 'flex',
        gap: 0,
        height: 'calc(100vh - 160px)',
        overflow: 'hidden',
        borderTop: '1px solid var(--color-border)',
      }}
    >
      {/* ── Panel 1: Country list ──────────────────────────────── */}
      <div
        style={{
          width: 210,
          borderRight: '1px solid var(--color-border)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          flexShrink: 0,
        }}
      >
        <div
          style={{
            padding: '10px 12px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid var(--color-border)',
          }}
        >
          <span
            style={{
              fontWeight: 700,
              fontSize: 11,
              textTransform: 'uppercase',
              letterSpacing: 0.5,
              color: 'var(--color-muted)',
            }}
          >
            {t('config.countries_config.panel_title')}
          </span>
          <div style={{ display: 'flex', gap: 4 }}>
            <Button
              variant="outline"
              size="sm"
              className="h-6 rounded-[4px] border-blue-600 bg-blue-100 px-2 text-[10px] font-semibold text-blue-900 hover:bg-blue-200"
              onClick={() => setShowWizard(true)}
              title={t('config.countries_config.wizard_btn_title')}
            >
              ✨ {t('config.countries_config.wizard_btn')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-6 rounded-sm border-dashed bg-transparent px-2.5 font-semibold text-muted hover:border-yango hover:bg-transparent hover:text-yango"
              onClick={addNewCountry}
              title={t('config.countries_config.advanced_add_title')}
            >
              +
            </Button>
          </div>
        </div>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {allKeys.map((key) => {
            const dbRow = dbRows.find((r) => r.country_key === key)
            const label = draft[key]?.label ?? dbRow?.label ?? key
            const isActive = selectedKey === key
            const ro = isReadOnly(key)
            return (
              <div
                key={key}
                onClick={() => {
                  setSelectedKey(key)
                  setSelectedCityIdx(null)
                }}
                style={{
                  padding: '8px 12px',
                  cursor: 'pointer',
                  fontSize: 13,
                  background: isActive ? 'rgba(229,57,53,0.07)' : 'transparent',
                  borderLeft: isActive ? '3px solid #e53935' : '3px solid transparent',
                  color: ro ? 'var(--color-muted)' : 'var(--color-text)',
                  fontStyle: ro ? 'italic' : 'normal',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 6,
                }}
              >
                <span
                  style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {label}
                </span>
                {ro && (
                  <span
                    title={t('config.countries_config.readonly_lock_title')}
                    style={{ fontSize: 9, flexShrink: 0 }}
                  >
                    🔒
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Panel 2: Country settings + City list ─────────────── */}
      <div
        style={{
          width: 290,
          borderRight: '1px solid var(--color-border)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          flexShrink: 0,
        }}
      >
        {!selectedKey ? (
          <div style={{ padding: 20, color: 'var(--color-muted)', fontSize: 13 }}>
            {t('config.countries_config.select_country_placeholder')}
          </div>
        ) : (
          <>
            {/* Country settings */}
            <div
              style={{
                padding: '12px 14px',
                borderBottom: '1px solid var(--color-border)',
                overflowY: 'auto',
              }}
            >
              <div
                style={{
                  fontWeight: 700,
                  fontSize: 11,
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                  color: 'var(--color-muted)',
                  marginBottom: 6,
                }}
              >
                {readonly
                  ? t('config.countries_config.readonly_preview_heading')
                  : t('config.countries_config.editable_heading')}
              </div>

              {readonly && (
                <div
                  style={{
                    marginBottom: 12,
                    padding: '8px 10px',
                    borderRadius: 6,
                    background: '#dbeafe',
                    border: '1px solid #93c5fd',
                    fontSize: 11,
                    color: '#1e3a8a',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                  }}
                >
                  <span>{t('config.countries_config.readonly_banner_text')}</span>
                  <Button
                    size="sm"
                    onClick={() => makeEditable(selectedKey)}
                    disabled={savingKey === selectedKey}
                    className="h-auto whitespace-nowrap rounded-[4px] bg-blue-600 px-2.5 py-1 text-[11px] hover:bg-blue-700"
                    title={t('config.countries_config.make_editable_btn_title')}
                  >
                    {savingKey === selectedKey
                      ? t('config.countries_config.promoting_btn')
                      : `📥 ${t('config.countries_config.promote_btn')}`}
                  </Button>
                </div>
              )}

              <label style={fieldLabelStyle}>{t('config.countries_config.name_label_label')}</label>
              <input
                style={inputStyle(readonly)}
                value={activeRow?.label || ''}
                disabled={readonly}
                onChange={(e) => setDraftField(selectedKey, 'label', e.target.value)}
              />

              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <label style={fieldLabelStyle}>
                    {t('config.countries_config.currency_label')}
                  </label>
                  <input
                    style={inputStyle(readonly)}
                    disabled={readonly}
                    value={activeRow?.currency || ''}
                    onChange={(e) => setCurrency(selectedKey, e.target.value)}
                    placeholder="USD"
                    list="currency-presets-list"
                    title={t('config.countries_config.currency_title_hint')}
                  />
                  <datalist id="currency-presets-list">
                    {Object.keys(CURRENCY_PRESETS).map((c) => (
                      <option key={c} value={c} />
                    ))}
                  </datalist>
                </div>
                <div style={{ flex: 1 }}>
                  <label style={fieldLabelStyle}>{t('config.country_wizard.locale_label')}</label>
                  <input
                    style={inputStyle(readonly)}
                    disabled={readonly}
                    value={activeRow?.locale || ''}
                    onChange={(e) => setDraftField(selectedKey, 'locale', e.target.value)}
                    placeholder="en-US"
                  />
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <label style={fieldLabelStyle}>
                    {t('config.countries_config.outlier_label')}
                  </label>
                  <input
                    type="number"
                    style={inputStyle(readonly)}
                    disabled={readonly}
                    value={activeRow?.outlier_threshold ?? 100}
                    onChange={(e) =>
                      setDraftField(selectedKey, 'outlier_threshold', e.target.value)
                    }
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={fieldLabelStyle}>
                    {t('config.countries_config.max_price_label')}
                  </label>
                  <input
                    type="number"
                    style={inputStyle(readonly)}
                    disabled={readonly}
                    value={activeRow?.max_price ?? 1000}
                    onChange={(e) => setDraftField(selectedKey, 'max_price', e.target.value)}
                  />
                </div>
              </div>

              {/* Zona horaria y umbral de riesgo. Las dos columnas existían en
                  la base (migs 183 y 216) sin forma de editarlas: un país
                  onboardeado por el wizard quedaba en 'UTC' para siempre, y con
                  eso "vence hoy" en Proyectos se desfasaba un día. */}
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <label style={fieldLabelStyle}>
                    {t('config.countries_config.timezone_label')}{' '}
                    <span
                      title={t('config.countries_config.timezone_tooltip')}
                      style={{ cursor: 'help', opacity: 0.6, textTransform: 'none' }}
                    >
                      ⓘ
                    </span>
                  </label>
                  <input
                    style={inputStyle(readonly)}
                    disabled={readonly}
                    placeholder="America/Lima"
                    value={activeRow?.timezone ?? 'UTC'}
                    onChange={(e) => setDraftField(selectedKey, 'timezone', e.target.value)}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={fieldLabelStyle}>
                    {t('config.countries_config.risk_days_label')}{' '}
                    <span
                      title={t('config.countries_config.risk_days_tooltip')}
                      style={{ cursor: 'help', opacity: 0.6, textTransform: 'none' }}
                    >
                      ⓘ
                    </span>
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={30}
                    style={inputStyle(readonly)}
                    disabled={readonly}
                    value={activeRow?.projects_risk_days ?? 2}
                    onChange={(e) =>
                      setDraftField(selectedKey, 'projects_risk_days', e.target.value)
                    }
                  />
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <label style={fieldLabelStyle}>
                    {t('config.countries_config.status_label')}{' '}
                    <span
                      title={t('config.countries_config.status_tooltip')}
                      style={{ cursor: 'help', opacity: 0.6, textTransform: 'none' }}
                    >
                      ⓘ
                    </span>
                  </label>
                  <select
                    style={inputStyle(readonly)}
                    disabled={readonly}
                    value={activeRow?.status || 'active'}
                    onChange={(e) => setDraftField(selectedKey, 'status', e.target.value)}
                  >
                    <option value="draft">
                      {t('config.countries_config.status_draft_option')}
                    </option>
                    <option value="active">
                      {t('config.countries_config.status_active_option')}
                    </option>
                  </select>
                </div>
                <div style={{ flex: 1 }}>
                  <label style={fieldLabelStyle}>
                    {t('config.countries_config.bot_rules_label')}{' '}
                    <span
                      title={t('config.countries_config.bot_rules_tooltip')}
                      style={{ cursor: 'help', opacity: 0.6, textTransform: 'none' }}
                    >
                      ⓘ
                    </span>
                  </label>
                  <div
                    style={{
                      ...inputStyle(true),
                      display: 'flex',
                      alignItems: 'center',
                      fontWeight: 600,
                      color:
                        activeRuleCount === 0 ? 'var(--color-warning-fg)' : 'var(--color-text)',
                    }}
                  >
                    {activeRuleCount === 0
                      ? t('config.countries_config.bot_rules_zero')
                      : t('config.countries_config.bot_rules_count', {
                          n: activeRuleCount,
                          count: activeRuleCount,
                        })}
                  </div>
                </div>
              </div>

              {!readonly && (
                <div
                  style={{
                    marginTop: 10,
                    display: 'flex',
                    gap: 8,
                    alignItems: 'center',
                    flexWrap: 'wrap',
                  }}
                >
                  <Button
                    size="sm"
                    disabled={savingKey === selectedKey}
                    onClick={() => handleSave(selectedKey)}
                  >
                    {savingKey === selectedKey
                      ? t('account.saving')
                      : t('config.countries_config.save_country_btn')}
                  </Button>
                  {/* Cancelar — descarta cambios o el país en memoria.
                      Disabled si no hay nada que cancelar (defensivo). */}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleCancel(selectedKey)}
                    disabled={!isDirty(selectedKey) && !selectedKey.startsWith('NewCountry_')}
                    title={
                      selectedKey.startsWith('NewCountry_')
                        ? t('config.countries_config.cancel_new_title')
                        : isDirty(selectedKey)
                          ? t('config.countries_config.cancel_dirty_title')
                          : t('config.countries_config.cancel_clean_title')
                    }
                  >
                    {t('app.cancel')}
                  </Button>
                  {isDbManaged(selectedKey) && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="border-red-300 text-red-600 hover:bg-red-100"
                      onClick={() => handleDeleteCountry(selectedKey)}
                    >
                      {t('app.delete')}
                    </Button>
                  )}
                  {msg && (
                    <span
                      style={{
                        fontSize: 11,
                        color: msg.type === 'ok' ? '#16a34a' : '#dc2626',
                      }}
                    >
                      {msg.text}
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* City list */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div
                style={{
                  padding: '8px 12px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  borderBottom: '1px solid var(--color-border)',
                }}
              >
                <span
                  style={{
                    fontWeight: 700,
                    fontSize: 11,
                    textTransform: 'uppercase',
                    letterSpacing: 0.5,
                    color: 'var(--color-muted)',
                  }}
                >
                  {t('config.countries_config.cities_heading')}
                </span>
                {!readonly && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 rounded-sm border-dashed bg-transparent px-2.5 font-semibold text-muted hover:border-yango hover:bg-transparent hover:text-yango"
                    onClick={() => addCity(selectedKey)}
                    title={t('config.country_wizard.add_city_btn')}
                  >
                    +
                  </Button>
                )}
              </div>
              <div style={{ overflowY: 'auto', flex: 1 }}>
                {activeCities.length === 0 && (
                  <div style={{ padding: '12px 14px', color: 'var(--color-muted)', fontSize: 12 }}>
                    {t('config.countries_config.no_cities_text')}{' '}
                    {!readonly && t('config.countries_config.no_cities_hint')}
                  </div>
                )}
                {activeCities.map((city, idx) => (
                  <div
                    key={idx}
                    onClick={() => setSelectedCityIdx(idx)}
                    style={{
                      padding: '7px 12px',
                      cursor: 'pointer',
                      fontSize: 13,
                      background: selectedCityIdx === idx ? 'rgba(229,57,53,0.07)' : 'transparent',
                      borderLeft:
                        selectedCityIdx === idx ? '3px solid #e53935' : '3px solid transparent',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                  >
                    <span
                      style={{
                        flex: 1,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {city.uiName || (
                        <em style={{ color: 'var(--color-muted)' }}>
                          {t('config.countries_config.unnamed_city')}
                        </em>
                      )}
                    </span>
                    {city.isVirtual && (
                      <span style={{ fontSize: 9, color: 'var(--color-muted)', flexShrink: 0 }}>
                        {t('config.countries_config.virtual_badge')}
                      </span>
                    )}
                    {!readonly && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-[18px] shrink-0 rounded-sm border-red-300 px-1.5 text-[10px] text-red-600 hover:bg-red-100"
                        onClick={(e) => {
                          e.stopPropagation()
                          deleteCity(selectedKey, idx)
                        }}
                        title={t('config.countries_config.delete_city_title')}
                      >
                        ✕
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>

      {/* ── Panel 3: City detail — fields + categories/competitors ── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 18px', minWidth: 0 }}>
        {!activeCity ? (
          <div style={{ color: 'var(--color-muted)', fontSize: 13, paddingTop: 20 }}>
            {t('config.countries_config.select_city_placeholder')}
          </div>
        ) : (
          <>
            {/* City fields */}
            <div className="config-section" style={{ marginBottom: 14 }}>
              <h2 style={{ marginBottom: 8 }}>{t('config.countries_config.city_data_heading')}</h2>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div style={{ minWidth: 130 }}>
                  <label style={fieldLabelStyle}>
                    {t('config.countries_config.ui_name_city_label')}
                  </label>
                  <input
                    style={inputStyle(readonly)}
                    disabled={readonly}
                    placeholder="Ej: Lima"
                    value={activeCity.uiName || ''}
                    onChange={(e) =>
                      setCity(selectedKey, selectedCityIdx, {
                        ...activeCity,
                        uiName: e.target.value,
                      })
                    }
                  />
                </div>
                <div style={{ minWidth: 130 }}>
                  <label style={fieldLabelStyle}>
                    {t('config.countries_config.db_name_city_label')}
                  </label>
                  <input
                    style={inputStyle(readonly)}
                    disabled={readonly}
                    placeholder="Ej: Lima"
                    value={activeCity.dbName || ''}
                    onChange={(e) =>
                      setCity(selectedKey, selectedCityIdx, {
                        ...activeCity,
                        dbName: e.target.value,
                      })
                    }
                  />
                </div>
                <div style={{ minWidth: 120 }}>
                  <label style={fieldLabelStyle}>
                    {t('config.countries_config.bot_key_label')}
                  </label>
                  <input
                    style={inputStyle(readonly)}
                    disabled={readonly}
                    placeholder="Ej: lima"
                    value={activeCity.botKey || ''}
                    onChange={(e) =>
                      setCity(selectedKey, selectedCityIdx, {
                        ...activeCity,
                        botKey: e.target.value,
                      })
                    }
                  />
                </div>
                <label
                  style={{
                    display: 'flex',
                    gap: 6,
                    fontSize: 12,
                    color: 'var(--color-muted)',
                    alignItems: 'center',
                    paddingBottom: 6,
                    cursor: readonly ? 'default' : 'pointer',
                  }}
                >
                  <input
                    type="checkbox"
                    disabled={readonly}
                    checked={!!activeCity.isVirtual}
                    onChange={(e) =>
                      setCity(selectedKey, selectedCityIdx, {
                        ...activeCity,
                        isVirtual: e.target.checked,
                      })
                    }
                    style={{ accentColor: '#e53935' }}
                  />
                  {t('config.countries_config.virtual_city_label')}
                  <span
                    title={t('config.countries_config.virtual_city_tooltip')}
                    style={{ cursor: 'help', opacity: 0.6 }}
                  >
                    ⓘ
                  </span>
                </label>
              </div>
            </div>

            {/* Categories + competitors */}
            <div className="config-section">
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: 12,
                }}
              >
                <h2 style={{ margin: 0 }}>
                  {t('config.countries_config.categories_competitors_heading')}
                </h2>
                {!readonly && (
                  <Button
                    variant="outline"
                    className="border-dashed bg-transparent font-semibold text-muted hover:border-yango hover:bg-transparent hover:text-yango"
                    onClick={() => addCategory(selectedKey, selectedCityIdx)}
                  >
                    {t('config.countries_config.add_category_btn')}
                  </Button>
                )}
              </div>

              {(!activeCity.categories || activeCity.categories.length === 0) && (
                <div style={{ color: 'var(--color-muted)', fontSize: 12, padding: '8px 0' }}>
                  {t('config.countries_config.no_categories_text')}{' '}
                  {!readonly && t('config.countries_config.no_categories_hint')}
                </div>
              )}

              {activeCity.categories?.map((cat, catIdx) => (
                <div
                  key={catIdx}
                  style={{
                    border: '1px solid var(--color-border-soft)',
                    borderRadius: 'var(--radius-sm)',
                    padding: '10px 14px',
                    marginBottom: 10,
                    background: 'var(--color-bg)',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      gap: 10,
                      flexWrap: 'wrap',
                      alignItems: 'flex-end',
                      marginBottom: 10,
                    }}
                  >
                    <div style={{ minWidth: 110 }}>
                      <label style={fieldLabelStyle}>
                        {t('config.country_wizard.ui_name_label')}
                      </label>
                      <input
                        style={{ ...inputStyle(readonly), width: 120 }}
                        placeholder="Economy"
                        list="cat-catalog-list"
                        disabled={readonly}
                        value={cat.name || ''}
                        onChange={(e) =>
                          setCategoryField(
                            selectedKey,
                            selectedCityIdx,
                            catIdx,
                            'name',
                            e.target.value
                          )
                        }
                        title={t('config.countries_config.cat_datalist_title')}
                      />
                      <datalist id="cat-catalog-list">
                        {CATALOG_CATEGORIES.map((c) => (
                          <option key={c.value} value={c.value} />
                        ))}
                      </datalist>
                    </div>
                    <div style={{ minWidth: 110 }}>
                      <label style={fieldLabelStyle}>
                        {t('config.countries_config.cat_db_name_label')}
                      </label>
                      <input
                        style={{ ...inputStyle(readonly), width: 120 }}
                        placeholder="Economy"
                        list="cat-catalog-list"
                        disabled={readonly}
                        value={cat.dbName || ''}
                        onChange={(e) =>
                          setCategoryField(
                            selectedKey,
                            selectedCityIdx,
                            catIdx,
                            'dbName',
                            e.target.value
                          )
                        }
                      />
                    </div>
                    <div style={{ minWidth: 130 }}>
                      <label style={fieldLabelStyle}>
                        {t('config.countries_config.yango_display_name_label')}
                      </label>
                      <input
                        style={{ ...inputStyle(readonly), width: 150 }}
                        placeholder="Yango"
                        disabled={readonly}
                        value={cat.yangoDisplayName || ''}
                        onChange={(e) =>
                          setCategoryField(
                            selectedKey,
                            selectedCityIdx,
                            catIdx,
                            'yangoDisplayName',
                            e.target.value
                          )
                        }
                      />
                    </div>
                    {!readonly && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="mb-px border-red-300 text-red-600 hover:bg-red-100"
                        onClick={() => deleteCategory(selectedKey, selectedCityIdx, catIdx)}
                      >
                        ✕ {t('app.delete')}
                      </Button>
                    )}
                  </div>

                  <label style={fieldLabelStyle}>
                    {t('config.countries_config.competitors_label')}
                  </label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 5 }}>
                    {cat.competitors.map((comp) => {
                      const hidden = (cat.ciHidden || []).includes(comp)
                      const note = cat.competitorNotes?.[comp] || ''
                      const noteKey = `${catIdx}|${comp}`
                      const editingNote = editingNoteFor === noteKey
                      return (
                        <span
                          key={comp}
                          style={{
                            ...competitorTagStyle,
                            ...(hidden
                              ? {
                                  opacity: 0.55,
                                  textDecoration: 'line-through',
                                  textDecorationColor: 'rgba(183,28,28,0.5)',
                                }
                              : {}),
                          }}
                          title={
                            hidden
                              ? t('config.countries_config.ci_hidden_tag_title', { comp })
                              : undefined
                          }
                        >
                          {comp}
                          {!readonly && (
                            <>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="ml-1 h-auto w-auto p-0.5 leading-none text-slate-500 hover:bg-transparent hover:text-yango"
                                onClick={() =>
                                  toggleCiHidden(selectedKey, selectedCityIdx, catIdx, comp)
                                }
                                title={
                                  hidden
                                    ? t('config.countries_config.ci_offer_title', { comp })
                                    : t('config.countries_config.ci_hide_title', { comp })
                                }
                              >
                                {hidden ? <EyeOff size={12} /> : <Eye size={12} />}
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="ml-0.5 h-auto w-auto p-0.5 leading-none text-slate-500 hover:bg-transparent hover:text-yango"
                                onClick={() => setEditingNoteFor(editingNote ? null : noteKey)}
                                title={
                                  note
                                    ? t('config.countries_config.competitor_note_edit_title', {
                                        comp,
                                      })
                                    : t('config.countries_config.competitor_note_add_title', {
                                        comp,
                                      })
                                }
                              >
                                <StickyNote size={12} fill={note ? 'currentColor' : 'none'} />
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="ml-0.5 h-auto w-auto p-0.5 text-xs font-bold leading-none text-red-600 hover:bg-transparent"
                                onClick={() =>
                                  removeCompetitor(selectedKey, selectedCityIdx, catIdx, comp)
                                }
                                title={t('config.countries_config.remove_competitor_title', {
                                  comp,
                                })}
                              >
                                ×
                              </Button>
                            </>
                          )}
                          {!hidden && !editingNote && note && (
                            <span
                              title={note}
                              style={{ marginLeft: 4, fontSize: 10, cursor: 'default' }}
                            >
                              📝
                            </span>
                          )}
                        </span>
                      )
                    })}
                    {!readonly && (
                      <CompetitorAdder
                        existing={cat.competitors}
                        onAdd={(comp) => addCompetitor(selectedKey, selectedCityIdx, catIdx, comp)}
                        allowCorpTiers={selectedKey === 'Peru' && activeCity.dbName === 'Corp'}
                      />
                    )}
                  </div>
                  {editingNoteFor?.startsWith(`${catIdx}|`) &&
                    (() => {
                      // split con límite 2: si el nombre del competidor tuviera un
                      // '|' (no pasa hoy, pero no cuesta nada ser robusto) se
                      // conserva entero en la segunda mitad.
                      const comp = editingNoteFor.split(/\|(.*)/s)[1]
                      return (
                        <div
                          style={{ marginTop: 6, display: 'flex', gap: 6, alignItems: 'center' }}
                        >
                          <label style={{ ...fieldLabelStyle, marginBottom: 0, minWidth: 'auto' }}>
                            {t('config.countries_config.competitor_note_label', { comp })}
                          </label>
                          <input
                            autoFocus
                            style={{ ...inputStyle(false), flex: 1 }}
                            placeholder={t('config.countries_config.competitor_note_placeholder')}
                            value={cat.competitorNotes?.[comp] || ''}
                            onChange={(e) =>
                              setCompetitorNote(
                                selectedKey,
                                selectedCityIdx,
                                catIdx,
                                comp,
                                e.target.value
                              )
                            }
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === 'Escape') setEditingNoteFor(null)
                            }}
                          />
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setEditingNoteFor(null)}
                          >
                            {t('app.close')}
                          </Button>
                        </div>
                      )
                    })()}
                  {(cat.ciHidden || []).length > 0 && (
                    <div
                      style={{ fontSize: 10, color: '#94a3b8', marginTop: 4, fontStyle: 'italic' }}
                    >
                      {t('config.countries_config.ci_hidden_note', {
                        list: (cat.ciHidden || []).join(', '),
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
