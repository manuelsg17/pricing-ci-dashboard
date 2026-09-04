import { useState, useEffect, useCallback } from 'react'
import { sb } from '../../../lib/supabase'
import { COUNTRY_CONFIG, CURRENCY_PRESETS } from '../../../lib/constants'
import { useCountry } from '../../../context/CountryContext'
import { useConfirm } from '../../ui/ConfirmDialog'
import { useI18n } from '../../../context/LanguageContext'

const CONST_KEYS = Object.keys(COUNTRY_CONFIG)

// Campos persistidos que decide si un draft difiere del row de DB. Compara
// solo estos para evitar falsos positivos (updated_at, id). Incluye los
// JSONB de mig 58 (bot_rules, airport_subcategories_by_city) — sin ellos,
// editar reglas o subcategorías no se reflejaba en Guardar/Cancelar. Mig 183
// agregó `timezone` y la 216 `projects_risk_days`, pero ninguna llegó a esta
// lista: editarlas no encendía Guardar y el cambio se perdía en silencio.
const DIRTY_FIELDS = [
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
  'timezone',
  'projects_risk_days',
]

// Estado y acciones de la pantalla Países: filas de DB, draft por país,
// selección, guardado, borrado, promoción desde constants.js. Los paneles
// (CountryList / CountryEditor / CityList / CityEditor) reciben de acá lo
// que necesitan; CountriesConfig.jsx solo los ubica.
export default function useCountryDraft() {
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
    const { data, error } = await sb.from('country_config').select('*').order('sort_order')
    // Antes se ignoraba `error`: un rebote de RLS/red se veía como "sin países".
    if (error) setMsg({ type: 'err', text: t('config.load_error', { msg: error.message }) })
    setDbRows(data || [])
    setLoading(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  function isDirty(key) {
    if (!draft[key]) return false
    const dbRow = dbRows.find((r) => r.country_key === key)
    if (!dbRow) return true // recién creado en memoria
    return DIRTY_FIELDS.some((f) => JSON.stringify(draft[key][f]) !== JSON.stringify(dbRow[f]))
  }

  function dropDraft(key) {
    setDraft((prev) => {
      const n = { ...prev }
      delete n[key]
      return n
    })
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
      dropDraft(key)
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
    dropDraft(key)
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
      dropDraft(key)
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
    dropDraft(key)
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
    dropDraft(key)

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

  // Callback del wizard: cerrar, refrescar y seleccionar el país creado.
  // Recarga también el conteo de bot_rules: la RPC recién las sembró y, sin
  // esto, el país nuevo aparecía con "0 configuradas" hasta un F5.
  function handleWizardCreated(key) {
    setShowWizard(false)
    refreshConfigs()
    loadRows()
    loadBotRuleCounts()
    setSelectedKey(key)
  }

  function selectCountry(key) {
    setSelectedKey(key)
    setSelectedCityIdx(null)
  }

  // ── Derived active values ─────────────────────────────────────────

  const activeRow = selectedKey ? getOrInitDraft(selectedKey) : null
  const activeCities = activeRow?.cities || []
  const activeCity = selectedCityIdx != null ? activeCities[selectedCityIdx] : null
  const readonly = selectedKey ? isReadOnly(selectedKey) : false
  const activeRuleCount = selectedKey ? (botRuleCounts[selectedKey] ?? 0) : 0

  return {
    t,
    loading,
    dbRows,
    draft,
    allKeys,
    selectedKey,
    selectCountry,
    selectedCityIdx,
    setSelectedCityIdx,
    editingNoteFor,
    setEditingNoteFor,
    savingKey,
    msg,
    showWizard,
    setShowWizard,
    handleWizardCreated,
    isDbManaged,
    isReadOnly,
    isDirty,
    activeRow,
    activeCities,
    activeCity,
    readonly,
    activeRuleCount,
    setDraftField,
    setCurrency,
    setCity,
    addCity,
    deleteCity,
    addCategory,
    deleteCategory,
    setCategoryField,
    addCompetitor,
    removeCompetitor,
    toggleCiHidden,
    setCompetitorNote,
    handleSave,
    handleCancel,
    handleDeleteCountry,
    addNewCountry,
    makeEditable,
  }
}
