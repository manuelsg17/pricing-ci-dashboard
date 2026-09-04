import { useState, useMemo, useEffect } from 'react'
import { sb } from '../../../lib/supabase'
import { getBotRulesTemplate } from '../../../lib/catalogs'
import { CURRENCY_PRESETS, BRACKETS } from '../../../lib/constants'
import { stripAccents, toDbKey } from '../../../lib/normalize'
import { useConfirm } from '../../ui/ConfirmDialog'
import { useI18n } from '../../../context/LanguageContext'
import { dbErrorText } from '../../../lib/dbErrorText'
import { STEPS, WIZARD_DRAFT_KEY, emptyWizardDraft, weightsSumOk } from './wizardConstants'

// Estado y acciones del wizard de alta de país. Los componentes de cada
// paso reciben de acá lo que necesitan; el orquestador (CountryWizard.jsx)
// solo arma el stepper y el footer.
export default function useCountryWizard({ onClose, onCreated }) {
  const confirm = useConfirm()
  const { t } = useI18n()
  const [step, setStep] = useState(0)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState(null)
  const [validation, setValidation] = useState(null)

  const [draft, setDraft] = useState(() => {
    try {
      const cached = localStorage.getItem(WIZARD_DRAFT_KEY)
      if (cached) return JSON.parse(cached)
    } catch {}
    return emptyWizardDraft()
  })

  // Persistir cada cambio
  useEffect(() => {
    try {
      localStorage.setItem(WIZARD_DRAFT_KEY, JSON.stringify(draft))
    } catch {}
  }, [draft])

  function update(field, value) {
    setDraft((d) => ({ ...d, [field]: value }))
  }

  function setCurrency(curr) {
    setDraft((d) => {
      const preset = CURRENCY_PRESETS[curr] || CURRENCY_PRESETS.USD
      return {
        ...d,
        currency: curr,
        locale: preset.locale,
        outlier_threshold: preset.outlier_threshold,
        max_price: preset.max_price,
      }
    })
  }

  // ── Ciudades ───────────────────────────────────────────────────────
  function addCity() {
    setDraft((d) => ({
      ...d,
      cities: [
        ...d.cities,
        { uiName: '', dbName: '', botKey: '', isVirtual: false, categories: [] },
      ],
    }))
  }
  function updateCity(idx, field, val) {
    setDraft((d) => {
      const cities = [...d.cities]
      cities[idx] = { ...cities[idx], [field]: val }
      // Auto-sugerir dbName y botKey desde uiName si están vacíos.
      // dbName preserva el case original ("Bogotá Norte" → "Bogota_Norte")
      // porque las dbCities históricas son CapCase. botKey usa toDbKey
      // (lowercase + sin acentos + snake_case) que es lo que el bot manda.
      if (field === 'uiName' && val) {
        if (!cities[idx].dbName) cities[idx].dbName = stripAccents(val).replace(/[\s-]+/g, '_')
        if (!cities[idx].botKey) cities[idx].botKey = toDbKey(val)
      }
      return { ...d, cities }
    })
  }
  function removeCity(idx) {
    setDraft((d) => ({ ...d, cities: d.cities.filter((_, i) => i !== idx) }))
  }

  // ── Categorías ─────────────────────────────────────────────────────
  function addCategoryToCity(cityIdx, categoryName) {
    setDraft((d) => {
      const cities = [...d.cities]
      const cat = cities[cityIdx].categories.find((c) => c.name === categoryName)
      if (cat) return d // ya existe
      cities[cityIdx] = {
        ...cities[cityIdx],
        categories: [
          ...cities[cityIdx].categories,
          {
            name: categoryName,
            dbName: categoryName,
            competitors: [],
            yangoDisplayName: 'Yango',
          },
        ],
      }
      return { ...d, cities }
    })
  }
  function removeCategoryFromCity(cityIdx, catIdx) {
    setDraft((d) => {
      const cities = [...d.cities]
      cities[cityIdx] = {
        ...cities[cityIdx],
        categories: cities[cityIdx].categories.filter((_, i) => i !== catIdx),
      }
      return { ...d, cities }
    })
  }

  // ── Competidores ───────────────────────────────────────────────────
  function toggleCompetitor(cityIdx, catIdx, compName) {
    setDraft((d) => {
      const cities = [...d.cities]
      const cat = cities[cityIdx].categories[catIdx]
      const comps = cat.competitors.includes(compName)
        ? cat.competitors.filter((c) => c !== compName)
        : [...cat.competitors, compName]
      cities[cityIdx].categories[catIdx] = { ...cat, competitors: comps }
      return { ...d, cities }
    })
  }

  // ── Pesos ──────────────────────────────────────────────────────────
  function updateWeight(bracket, val) {
    setDraft((d) => ({ ...d, weights: { ...d.weights, [bracket]: parseFloat(val) || 0 } }))
  }
  const totalWeight = useMemo(
    () => BRACKETS.reduce((s, b) => s + (draft.weights[b] || 0), 0),
    [draft.weights]
  )

  // ── Bot Rules ──────────────────────────────────────────────────────
  function updateBotRule(idx, field, value) {
    setDraft((d) => {
      const br = [...d.botRules]
      br[idx] = { ...br[idx], [field]: value }
      return { ...d, botRules: br }
    })
  }
  function removeBotRule(idx) {
    setDraft((d) => ({ ...d, botRules: d.botRules.filter((_, j) => j !== idx) }))
  }
  function addBotRule() {
    setDraft((d) => ({
      ...d,
      botRules: [
        ...d.botRules,
        {
          app: '',
          vc: '',
          ovc: '*',
          competition_name: 'Yango',
          category: 'Economy',
          _new: true,
        },
      ],
    }))
  }

  // Pre-rellenar al elegir currency en paso 2
  useEffect(() => {
    if (draft.botRules.length === 0 && draft.currency) {
      const template = getBotRulesTemplate(draft.currency)
      if (template.length > 0) {
        setDraft((d) => ({ ...d, botRules: template.map((r) => ({ ...r, _new: true })) }))
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.currency])

  // ── Validación por paso ────────────────────────────────────────────
  const stepErrors = useMemo(() => {
    const errs = []
    if (
      step >= 0 &&
      (!draft.country_key.trim() || !/^[A-Z][A-Za-z0-9]+$/.test(draft.country_key))
    ) {
      if (step === 0) errs.push(t('config.country_wizard.err_country_key'))
    }
    if (step >= 0 && !draft.label.trim()) {
      if (step === 0) errs.push(t('config.country_wizard.err_label'))
    }
    if (step >= 1 && !draft.currency.trim()) {
      if (step === 1) errs.push(t('config.country_wizard.err_currency'))
    }
    return errs
  }, [step, draft, t])

  const canAdvance = stepErrors.length === 0

  // ── Guardar país (al final del wizard) ─────────────────────────────
  // Antes eran 8 escrituras sueltas desde el cliente (country_config,
  // bracket_weights, bot_rules, distance_thresholds, price_validation_rules,
  // semaforo_config, rush_hour_windows, indrive_config): si una fallaba a
  // mitad de camino el país quedaba a medio crear. Ahora va todo en UNA
  // transacción del lado de la base (mig 240, create_country_setup): o queda
  // todo o no queda nada. Los defaults sembrados (umbrales, semáforo, hora
  // pico, outlier) los decide la RPC, no el cliente.
  async function handleFinish() {
    setSaving(true)
    setMsg(null)
    try {
      const payload = {
        country_key: draft.country_key,
        label: draft.label,
        currency: draft.currency,
        locale: draft.locale,
        iso2: draft.iso2 || null,
        native_label: draft.native_label || draft.label,
        outlier_threshold: Number(draft.outlier_threshold),
        max_price: Number(draft.max_price),
        cities: draft.cities,
        botRules: draft.botRules.map(({ _new, ...r }) => r),
        // Igual que antes: los pesos solo se guardan si suman 100.
        weights: weightsSumOk(totalWeight) ? draft.weights : null,
      }
      const { data: created, error: rpcErr } = await sb.rpc('create_country_setup', {
        p_payload: payload,
      })
      if (rpcErr) throw rpcErr

      // Validar setup
      const { data: vData } = await sb.rpc('validate_country_setup', {
        p_country: draft.country_key,
      })
      setValidation(vData || [])

      setMsg({
        type: 'ok',
        text:
          t('config.country_wizard.created_toast', { label: draft.label }) +
          ' ' +
          t('config.country_wizard.created_summary', {
            thresholds: created?.distance_thresholds ?? 0,
            semaforo: created?.semaforo_config ?? 0,
            rush: created?.rush_hour_windows ?? 0,
            rules: created?.bot_rules ?? 0,
            weights: created?.bracket_weights ?? 0,
          }) +
          // La siembra de indrive_config es best-effort dentro de la RPC: si
          // falló, el país queda creado pero sin ajuste de InDrive y hay que
          // decirlo, no esconderlo bajo el toast de éxito.
          (created?.indrive_config_error ? ' ' + t('config.country_wizard.indrive_warning') : ''),
      })
      try {
        localStorage.removeItem(WIZARD_DRAFT_KEY)
      } catch {}
      if (onCreated) onCreated(draft.country_key)
    } catch (e) {
      // El mensaje crudo de la RPC nombra tablas internas y va solo en español
      // (§3/§6): se traduce por código de error.
      setMsg({ type: 'err', text: dbErrorText(t, e) })
    } finally {
      setSaving(false)
    }
  }

  async function handleCancel() {
    const ok = await confirm({
      title: t('config.country_wizard.cancel_title'),
      message: t('config.country_wizard.cancel_message'),
      confirmText: t('config.country_wizard.cancel_confirm_btn'),
      cancelText: t('config.country_wizard.cancel_back_btn'),
      danger: true,
    })
    if (!ok) return
    try {
      localStorage.removeItem(WIZARD_DRAFT_KEY)
    } catch {}
    if (onClose) onClose()
  }

  return {
    t,
    steps: STEPS,
    step,
    setStep,
    activeStep: STEPS[step],
    draft,
    saving,
    msg,
    setMsg,
    validation,
    stepErrors,
    canAdvance,
    totalWeight,
    update,
    setCurrency,
    addCity,
    updateCity,
    removeCity,
    addCategoryToCity,
    removeCategoryFromCity,
    toggleCompetitor,
    updateWeight,
    updateBotRule,
    removeBotRule,
    addBotRule,
    handleFinish,
    handleCancel,
  }
}
