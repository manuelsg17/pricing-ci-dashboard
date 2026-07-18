import { useState, useMemo, useEffect } from 'react'
import { sb } from '../../lib/supabase'
import { CATALOG_CATEGORIES, CATALOG_COMPETITORS, getBotRulesTemplate } from '../../lib/catalogs'
import { CURRENCY_PRESETS, DEFAULT_WEIGHTS_PCT, BRACKETS } from '../../lib/constants'
import { stripAccents, toDbKey } from '../../lib/normalize'
import { useConfirm } from '../ui/ConfirmDialog'
import SaveStatusBanner from './SaveStatusBanner'
import { Button } from '../ui/shadcn/button'

const ISO_CODES = [
  'PE',
  'CO',
  'BO',
  'VE',
  'NP',
  'ZM',
  'MX',
  'EC',
  'AR',
  'CL',
  'UY',
  'PY',
  'GT',
  'BR',
  'US',
]

// Umbrales de distancia por defecto (km máximo de cada bracket).
// Mismos para todas las monedas — la distancia geográfica no depende
// del país. very_long no tiene max_km (sin límite superior).
// Sin estos defaults, el dashboard cae a "very_long" por todo (mig 46)
// y se ve sesgado. Por eso es importante seedear desde el wizard.
const DEFAULT_DISTANCE_THRESHOLDS_KM = {
  very_short: 2,
  short: 4,
  median: 6,
  average: 8,
  long: 10,
  very_long: null,
}

// Pasos del wizard. Solo Identidad y Moneda son obligatorios para
// crear el país; el resto se puede completar después editando.
const STEPS = [
  { id: 'identity', label: '1. Identidad', required: true },
  { id: 'currency', label: '2. Moneda', required: true },
  { id: 'cities', label: '3. Ciudades', required: false },
  { id: 'categories', label: '4. Categorías', required: false },
  { id: 'competitors', label: '5. Competidores', required: false },
  { id: 'weights', label: '6. Pesos (opcional)', required: false },
  { id: 'botrules', label: '7. Bot Rules (opcional)', required: false },
  { id: 'review', label: '8. Revisión', required: true },
]

export default function CountryWizard({ onClose, onCreated }) {
  const confirm = useConfirm()
  const [step, setStep] = useState(0)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState(null)
  const [validation, setValidation] = useState(null)

  // Draft del país que se va construyendo. Persistido en localStorage
  // para que el usuario pueda cerrar y volver.
  const DRAFT_KEY = 'wizard.countryDraft.v1'
  const [draft, setDraft] = useState(() => {
    try {
      const cached = localStorage.getItem(DRAFT_KEY)
      if (cached) return JSON.parse(cached)
    } catch {}
    return {
      country_key: '',
      label: '',
      currency: 'USD',
      locale: 'en-US',
      iso2: '',
      native_label: '',
      outlier_threshold: 100,
      max_price: 1000,
      status: 'draft',
      cities: [],
      botRules: [],
      weights: { ...DEFAULT_WEIGHTS_PCT },
    }
  })

  // Persistir cada cambio
  useEffect(() => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
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
      if (step === 0)
        errs.push(
          'country_key debe empezar con mayúscula y contener solo letras (ej: Mexico, NewLand)'
        )
    }
    if (step >= 0 && !draft.label.trim()) {
      if (step === 0) errs.push('label es obligatorio')
    }
    if (step >= 1 && !draft.currency.trim()) {
      if (step === 1) errs.push('currency es obligatorio')
    }
    return errs
  }, [step, draft])

  const canAdvance = stepErrors.length === 0

  // ── Guardar país (al final del wizard) ─────────────────────────────
  async function handleFinish() {
    setSaving(true)
    setMsg(null)
    try {
      // 1. country_config
      const cfgRow = {
        country_key: draft.country_key,
        label: draft.label,
        currency: draft.currency,
        locale: draft.locale,
        iso2: draft.iso2 || null,
        native_label: draft.native_label || draft.label,
        outlier_threshold: Number(draft.outlier_threshold),
        max_price: Number(draft.max_price),
        status: 'draft', // siempre arranca en draft — el usuario activa después
        sort_order: 99,
        cities: draft.cities,
      }
      const { error: cfgErr } = await sb
        .from('country_config')
        .upsert(cfgRow, { onConflict: 'country_key' })
      if (cfgErr) throw cfgErr

      // 2. bracket_weights (solo si suma 100 — opcional)
      if (Math.abs(totalWeight - 100) < 0.5) {
        const weightRows = BRACKETS.map((b) => ({
          country: draft.country_key,
          city: 'all',
          category: 'all',
          bracket: b,
          weight: (draft.weights[b] || 0) / 100,
        }))
        const { error: wErr } = await sb
          .from('bracket_weights')
          .upsert(weightRows, { onConflict: 'country,city,category,bracket' })
        if (wErr) throw wErr
      }

      // 3. bot_rules (si hay)
      if (draft.botRules.length > 0) {
        const ruleRows = draft.botRules
          .filter((r) => r.app && r.vc && r.competition_name && r.category)
          .map((r) => ({
            country: draft.country_key,
            app: r.app.toLowerCase(),
            vc: r.vc.toLowerCase(),
            ovc: (r.ovc || '*').toLowerCase(),
            competition_name: r.competition_name,
            category: r.category,
            cities: r.cities || [],
            active: true,
          }))
        if (ruleRows.length > 0) {
          const { error: rErr } = await sb
            .from('bot_rules')
            .upsert(ruleRows, { onConflict: 'country,app,vc,ovc' })
          if (rErr) throw rErr
        }
      }

      // 4. distance_thresholds — CRÍTICO sin esto el dashboard cae a 'very_long'
      // por todo. Sembrar defaults por (city, category, bracket) usando los
      // valores de DEFAULT_DISTANCE_THRESHOLDS_KM. El usuario puede editar
      // después desde /config → Distancias.
      const thresholdRows = []
      for (const c of draft.cities) {
        const categories = c.categories?.length
          ? c.categories.map((cat) => cat.dbName || cat.name)
          : ['all']
        for (const category of categories) {
          for (const bracket of BRACKETS) {
            thresholdRows.push({
              country: draft.country_key,
              city: c.dbName || c.uiName,
              category,
              bracket,
              max_km: DEFAULT_DISTANCE_THRESHOLDS_KM[bracket],
            })
          }
        }
      }
      if (thresholdRows.length > 0) {
        const { error: thrErr } = await sb
          .from('distance_thresholds')
          .upsert(thresholdRows, { onConflict: 'country,city,category,bracket' })
        if (thrErr) throw thrErr
      }

      // 5. price_validation_rules — outlier defensivo a nivel país
      // Usa el max_price del país. Sin esta regla, valores muy altos
      // del bot pasan al dashboard y sesgan los averages.
      const validationRow = {
        country: draft.country_key,
        city: 'all',
        category: 'all',
        competition: 'all',
        max_price: Number(draft.max_price) * 3, // 3x maxPrice como cota razonable
      }
      const { error: pvErr } = await sb
        .from('price_validation_rules')
        .upsert(validationRow, { onConflict: 'country,city,category,competition' })
      if (pvErr) throw pvErr

      // 6. semaforo_config — bandas por defecto (Verde 5-10%, Amarillo
      // 1-5% & 10-12%, Rojo el resto). Sin esto, el semáforo del
      // dashboard cae a fallback hardcoded JS que no es per-país y no se
      // puede editar desde /config. Solo seedeamos si NO hay filas
      // pre-existentes para no clobbear ediciones manuales.
      const { count: semCount } = await sb
        .from('semaforo_config')
        .select('id', { count: 'exact', head: true })
        .eq('country', draft.country_key)
      if (!semCount) {
        const semRows = [
          {
            country: draft.country_key,
            band: 'green',
            min_pct: 5,
            max_pct: 10,
            note: 'Yango competitivo',
          },
          {
            country: draft.country_key,
            band: 'yellow',
            min_pct: 1,
            max_pct: 5,
            note: 'Cerca pero por debajo',
          },
          {
            country: draft.country_key,
            band: 'yellow',
            min_pct: 10,
            max_pct: 12,
            note: 'Cerca pero por arriba',
          },
          {
            country: draft.country_key,
            band: 'red',
            min_pct: null,
            max_pct: 1,
            note: 'Yango muy bajo vs mercado',
          },
          {
            country: draft.country_key,
            band: 'red',
            min_pct: 12,
            max_pct: null,
            note: 'Yango muy alto vs mercado',
          },
        ]
        const { error: semErr } = await sb.from('semaforo_config').insert(semRows)
        if (semErr) throw semErr
      }

      // 7. rush_hour_windows — ventanas estándar 07:00-09:00 y 17:00-20:00
      // por cada ciudad. Sin esto, rush_hour = NULL en pricing_observations
      // y los filtros de hora-pico no funcionan. Solo seedeamos si la
      // ciudad no tiene ya ventanas registradas.
      const rushRows = []
      for (const c of draft.cities) {
        const cityName = c.dbName || c.uiName
        if (!cityName) continue
        rushRows.push(
          {
            country: draft.country_key,
            city: cityName,
            start_time: '07:00',
            end_time: '09:00',
            label: 'Mañana',
          },
          {
            country: draft.country_key,
            city: cityName,
            start_time: '17:00',
            end_time: '20:00',
            label: 'Tarde',
          }
        )
      }
      if (rushRows.length > 0) {
        const { error: rhErr } = await sb
          .from('rush_hour_windows')
          .upsert(rushRows, { onConflict: 'country,city,start_time,end_time' })
        if (rhErr) throw rhErr
      }

      // 8. indrive_config — adjustment_pct=0 por (country, city, category)
      // para que `apply_indrive_bot_prices` tenga filas sobre las cuales
      // aplicar el override. Sin esto, los precios InDrive del bot llegan
      // sin ajuste configurable y el admin tiene que crear cada fila a
      // mano antes de poder afinar. Best-effort: si falla, no rompe el
      // wizard (el admin puede sembrar después manualmente).
      try {
        const indriveRows = []
        for (const c of draft.cities) {
          const cityName = c.dbName || c.uiName
          if (!cityName) continue
          for (const cat of c.categories || []) {
            const catName = cat.dbName || cat.name
            if (!catName) continue
            indriveRows.push({
              country: draft.country_key,
              city: cityName,
              category: catName,
              adjustment_pct: 0,
            })
          }
        }
        if (indriveRows.length > 0) {
          await sb
            .from('indrive_config')
            .upsert(indriveRows, { onConflict: 'country,city,category' })
        }
      } catch (e) {
        // No tiramos — el admin puede configurarlo después
        console.warn('[wizard] indrive_config seed skipped:', e?.message || e)
      }

      // 9. ci_timeslots es global (sin country) y ya tiene defaults desde
      // la mig 10 (Mañana 08-10, Tarde 13-15, Noche 18-20). Nada que
      // hacer acá; lo dejamos documentado.

      // 10. Validar setup
      const { data: vData } = await sb.rpc('validate_country_setup', {
        p_country: draft.country_key,
      })
      setValidation(vData || [])

      setMsg({
        type: 'ok',
        text: `País "${draft.label}" creado en status=draft. Revisá el checklist abajo y activá cuando esté listo.`,
      })
      try {
        localStorage.removeItem(DRAFT_KEY)
      } catch {}
      if (onCreated) onCreated(draft.country_key)
    } catch (e) {
      setMsg({ type: 'err', text: 'Error al crear país: ' + e.message })
    } finally {
      setSaving(false)
    }
  }

  async function handleCancel() {
    const ok = await confirm({
      title: 'Cancelar wizard',
      message: 'Vas a descartar todos los cambios del wizard. El draft local también se borrará.',
      confirmText: 'Descartar',
      cancelText: 'Volver',
      danger: true,
    })
    if (!ok) return
    try {
      localStorage.removeItem(DRAFT_KEY)
    } catch {}
    if (onClose) onClose()
  }

  const activeStep = STEPS[step]

  return (
    <div className="config-section">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 12,
        }}
      >
        <h2>Wizard — Crear país nuevo</h2>
        <Button
          variant="outline"
          size="sm"
          onClick={handleCancel}
          className="rounded-[4px] border-slate-300"
        >
          ✕ Cerrar
        </Button>
      </div>

      {/* Stepper */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16, flexWrap: 'wrap' }}>
        {STEPS.map((s, i) => (
          <button
            key={s.id}
            onClick={() => i < step && setStep(i)}
            disabled={i > step}
            style={{
              padding: '6px 10px',
              borderRadius: 14,
              fontSize: 11,
              border: i === step ? '1.5px solid #2563eb' : '1px solid #e2e8f0',
              background: i === step ? '#dbeafe' : i < step ? '#f0fdf4' : '#fff',
              color: i === step ? '#1e3a8a' : i < step ? '#15803d' : '#94a3b8',
              fontWeight: i === step ? 600 : 400,
              cursor: i < step ? 'pointer' : 'default',
            }}
          >
            {i < step && '✓ '}
            {s.label}
            {!s.required && i >= step && ' *opcional*'}
          </button>
        ))}
      </div>

      <SaveStatusBanner status={msg} onDismiss={() => setMsg(null)} />

      {/* Cuerpo del paso */}
      <div
        style={{ padding: 16, background: '#f8fafc', borderRadius: 8, border: '1px solid #e2e8f0' }}
      >
        {/* PASO 1: Identidad */}
        {activeStep.id === 'identity' && (
          <div>
            <h3 style={{ margin: '0 0 12px', fontSize: 14 }}>Identidad del país</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <Field label="country_key (clave única, sin espacios)" required>
                <input
                  value={draft.country_key}
                  onChange={(e) => update('country_key', e.target.value.replace(/\s+/g, ''))}
                  placeholder="Mexico"
                />
              </Field>
              <Field label="Label visible">
                <input
                  value={draft.label}
                  onChange={(e) => update('label', e.target.value)}
                  placeholder="México"
                />
              </Field>
              <Field label="ISO-2 (opcional)">
                <input
                  list="wizard-iso-list"
                  value={draft.iso2}
                  onChange={(e) => update('iso2', e.target.value.toUpperCase().slice(0, 2))}
                  placeholder="MX"
                />
                <datalist id="wizard-iso-list">
                  {ISO_CODES.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
              </Field>
              <Field label="Nombre nativo (opcional)">
                <input
                  value={draft.native_label}
                  onChange={(e) => update('native_label', e.target.value)}
                  placeholder="México"
                />
              </Field>
            </div>
          </div>
        )}

        {/* PASO 2: Moneda */}
        {activeStep.id === 'currency' && (
          <div>
            <h3 style={{ margin: '0 0 12px', fontSize: 14 }}>Moneda y escala</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
              <Field label="Moneda (ISO-4217)" required>
                <input
                  list="wizard-curr-list"
                  value={draft.currency}
                  onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                  placeholder="USD"
                  title="Auto-aplica defaults razonables para outlier y max_price"
                />
                <datalist id="wizard-curr-list">
                  {Object.keys(CURRENCY_PRESETS).map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
              </Field>
              <Field label="Locale">
                <input value={draft.locale} onChange={(e) => update('locale', e.target.value)} />
              </Field>
              <Field label="Outlier threshold">
                <input
                  type="number"
                  value={draft.outlier_threshold}
                  onChange={(e) => update('outlier_threshold', e.target.value)}
                />
              </Field>
              <Field label="Max price (filtro)">
                <input
                  type="number"
                  value={draft.max_price}
                  onChange={(e) => update('max_price', e.target.value)}
                />
              </Field>
            </div>
            <p style={{ fontSize: 11, color: '#64748b', marginTop: 10 }}>
              Los valores por defecto se ajustan automáticamente al elegir la moneda (PEN: ~100s,
              COP: ~300K, NPR: ~5K, etc.). Podés editarlos.
            </p>
          </div>
        )}

        {/* PASO 3: Ciudades */}
        {activeStep.id === 'cities' && (
          <div>
            <h3 style={{ margin: '0 0 6px', fontSize: 14 }}>Ciudades del país</h3>
            <p style={{ fontSize: 11, color: '#64748b', marginBottom: 10 }}>
              dbName y botKey se sugieren automáticamente sin acentos. Podés agregar ciudades
              después de crear el país.
            </p>
            {draft.cities.map((c, i) => (
              <div
                key={i}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr 1fr auto',
                  gap: 8,
                  marginBottom: 8,
                }}
              >
                <Field label={i === 0 ? 'Nombre UI' : ''}>
                  <input
                    value={c.uiName}
                    onChange={(e) => updateCity(i, 'uiName', e.target.value)}
                    placeholder="Lima"
                  />
                </Field>
                <Field label={i === 0 ? 'dbName' : ''}>
                  <input
                    value={c.dbName}
                    onChange={(e) => updateCity(i, 'dbName', e.target.value)}
                    placeholder="Lima"
                  />
                </Field>
                <Field label={i === 0 ? 'botKey' : ''}>
                  <input
                    value={c.botKey}
                    onChange={(e) => updateCity(i, 'botKey', e.target.value)}
                    placeholder="lima"
                  />
                </Field>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => removeCity(i)}
                  className="rounded-[4px] border-red-300 bg-red-50 px-2 text-[11px] text-red-800 hover:bg-red-100"
                >
                  ✕
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              onClick={addCity}
              className="border-dashed bg-transparent font-semibold text-muted hover:border-yango hover:bg-transparent hover:text-yango"
            >
              + Agregar ciudad
            </Button>
          </div>
        )}

        {/* PASO 4: Categorías */}
        {activeStep.id === 'categories' && (
          <div>
            <h3 style={{ margin: '0 0 6px', fontSize: 14 }}>Categorías por ciudad</h3>
            <p style={{ fontSize: 11, color: '#64748b', marginBottom: 10 }}>
              Usá el dropdown con el catálogo canónico para evitar typos.
            </p>
            {draft.cities.length === 0 ? (
              <em style={{ color: '#888' }}>No hay ciudades. Volvé al paso 3 para agregarlas.</em>
            ) : (
              draft.cities.map((c, ci) => (
                <div
                  key={ci}
                  style={{
                    marginBottom: 12,
                    padding: 10,
                    background: '#fff',
                    borderRadius: 6,
                    border: '1px solid #e2e8f0',
                  }}
                >
                  <strong style={{ fontSize: 12 }}>
                    {c.uiName || c.dbName || '(ciudad sin nombre)'}
                  </strong>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
                    {c.categories.map((cat, cti) => (
                      <span key={cti} style={categoryTag}>
                        {cat.name}
                        <button onClick={() => removeCategoryFromCity(ci, cti)} style={tagRemove}>
                          ✕
                        </button>
                      </span>
                    ))}
                  </div>
                  <select
                    onChange={(e) => {
                      if (e.target.value) {
                        addCategoryToCity(ci, e.target.value)
                        e.target.value = ''
                      }
                    }}
                    style={{ marginTop: 6 }}
                    value=""
                  >
                    <option value="">+ Agregar categoría…</option>
                    {CATALOG_CATEGORIES.map((cc) => (
                      <option key={cc.value} value={cc.value}>
                        {cc.label}
                      </option>
                    ))}
                  </select>
                </div>
              ))
            )}
          </div>
        )}

        {/* PASO 5: Competidores */}
        {activeStep.id === 'competitors' && (
          <div>
            <h3 style={{ margin: '0 0 6px', fontSize: 14 }}>
              Competidores por (ciudad, categoría)
            </h3>
            {draft.cities.length === 0 ? (
              <em style={{ color: '#888' }}>No hay ciudades configuradas.</em>
            ) : (
              draft.cities.map((c, ci) => (
                <div key={ci} style={{ marginBottom: 12 }}>
                  <strong style={{ fontSize: 12 }}>{c.uiName || c.dbName}</strong>
                  {c.categories.map((cat, cti) => (
                    <div
                      key={cti}
                      style={{
                        marginLeft: 12,
                        padding: 6,
                        marginTop: 4,
                        background: '#fff',
                        borderRadius: 4,
                        border: '1px solid #e2e8f0',
                      }}
                    >
                      <div style={{ fontSize: 11, color: '#475569' }}>{cat.name}</div>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
                        {CATALOG_COMPETITORS.map((comp) => (
                          <button
                            key={comp.value}
                            onClick={() => toggleCompetitor(ci, cti, comp.value)}
                            style={{
                              padding: '2px 8px',
                              borderRadius: 10,
                              fontSize: 10,
                              border: '1px solid',
                              cursor: 'pointer',
                              ...(cat.competitors.includes(comp.value)
                                ? { background: comp.color, color: '#fff', borderColor: comp.color }
                                : { background: '#fff', color: '#475569', borderColor: '#cbd5e1' }),
                            }}
                          >
                            {comp.value}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ))
            )}
          </div>
        )}

        {/* PASO 6: Pesos */}
        {activeStep.id === 'weights' && (
          <div>
            <h3 style={{ margin: '0 0 6px', fontSize: 14 }}>Pesos del WA por bracket (opcional)</h3>
            <p style={{ fontSize: 11, color: '#64748b', marginBottom: 10 }}>
              Defaults sensatos pre-cargados. Aplicados como (city='all', category='all'). Podés
              agregar pesos por (city, category) después en /config → Pesos.
            </p>
            <table className="config-table">
              <thead>
                <tr>
                  <th scope="col">Bracket</th>
                  <th scope="col">Peso %</th>
                </tr>
              </thead>
              <tbody>
                {BRACKETS.map((b) => (
                  <tr key={b}>
                    <td>{b}</td>
                    <td>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        max="100"
                        value={draft.weights[b]}
                        onChange={(e) => updateWeight(b, e.target.value)}
                      />
                    </td>
                  </tr>
                ))}
                <tr
                  style={{ background: Math.abs(totalWeight - 100) < 0.5 ? '#f0fdf4' : '#fef2f2' }}
                >
                  <td>
                    <strong>Total</strong>
                  </td>
                  <td>
                    <strong
                      style={{ color: Math.abs(totalWeight - 100) < 0.5 ? '#15803d' : '#b91c1c' }}
                    >
                      {totalWeight.toFixed(2)}%
                    </strong>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}

        {/* PASO 7: Bot Rules */}
        {activeStep.id === 'botrules' && (
          <div>
            <h3 style={{ margin: '0 0 6px', fontSize: 14 }}>Bot rules (opcional)</h3>
            <p style={{ fontSize: 11, color: '#64748b', marginBottom: 10 }}>
              Pre-rellenadas según moneda. Podés editar/agregar/quitar. Si dejás vacío, configurá
              después en /config → Bot Rules.
            </p>
            <div style={{ maxHeight: 240, overflowY: 'auto' }}>
              <table className="config-table" style={{ fontSize: 11 }}>
                <thead>
                  <tr>
                    <th scope="col">app</th>
                    <th scope="col">vc</th>
                    <th scope="col">ovc</th>
                    <th scope="col">Competidor</th>
                    <th scope="col">Categoría</th>
                    <th scope="col"></th>
                  </tr>
                </thead>
                <tbody>
                  {draft.botRules.map((r, i) => (
                    <tr key={i}>
                      <td>
                        <input
                          value={r.app}
                          onChange={(e) =>
                            setDraft((d) => {
                              const br = [...d.botRules]
                              br[i] = { ...br[i], app: e.target.value }
                              return { ...d, botRules: br }
                            })
                          }
                          style={{ width: 90 }}
                        />
                      </td>
                      <td>
                        <input
                          value={r.vc}
                          onChange={(e) =>
                            setDraft((d) => {
                              const br = [...d.botRules]
                              br[i] = { ...br[i], vc: e.target.value }
                              return { ...d, botRules: br }
                            })
                          }
                          style={{ width: 80 }}
                        />
                      </td>
                      <td>
                        <input
                          value={r.ovc || '*'}
                          onChange={(e) =>
                            setDraft((d) => {
                              const br = [...d.botRules]
                              br[i] = { ...br[i], ovc: e.target.value }
                              return { ...d, botRules: br }
                            })
                          }
                          style={{ width: 80 }}
                        />
                      </td>
                      <td>
                        <select
                          value={r.competition_name}
                          onChange={(e) =>
                            setDraft((d) => {
                              const br = [...d.botRules]
                              br[i] = { ...br[i], competition_name: e.target.value }
                              return { ...d, botRules: br }
                            })
                          }
                        >
                          {CATALOG_COMPETITORS.map((c) => (
                            <option key={c.value}>{c.value}</option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <select
                          value={r.category}
                          onChange={(e) =>
                            setDraft((d) => {
                              const br = [...d.botRules]
                              br[i] = { ...br[i], category: e.target.value }
                              return { ...d, botRules: br }
                            })
                          }
                        >
                          {CATALOG_CATEGORIES.map((c) => (
                            <option key={c.value}>{c.value}</option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            setDraft((d) => ({
                              ...d,
                              botRules: d.botRules.filter((_, j) => j !== i),
                            }))
                          }
                          className="rounded-[4px] border-red-300 bg-red-50 px-2 text-[11px] text-red-800 hover:bg-red-100"
                        >
                          ✕
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={() =>
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
              className="border-dashed bg-transparent font-semibold text-muted hover:border-yango hover:bg-transparent hover:text-yango"
            >
              + Regla
            </Button>
          </div>
        )}

        {/* PASO 8: Revisión */}
        {activeStep.id === 'review' && (
          <div>
            <h3 style={{ margin: '0 0 12px', fontSize: 14 }}>Revisión final</h3>
            <ul style={{ fontSize: 12, color: '#475569', lineHeight: 1.8 }}>
              <li>
                <strong>Identidad:</strong> {draft.country_key} ({draft.label}
                {draft.iso2 ? `, ${draft.iso2}` : ''})
              </li>
              <li>
                <strong>Moneda:</strong> {draft.currency} ({draft.locale}, outlier=
                {draft.outlier_threshold}, maxPrice={draft.max_price})
              </li>
              <li>
                <strong>Ciudades:</strong> {draft.cities.length} (
                {draft.cities.map((c) => c.dbName).join(', ') || '—'})
              </li>
              <li>
                <strong>Categorías totales:</strong>{' '}
                {draft.cities.reduce((s, c) => s + c.categories.length, 0)}
              </li>
              <li>
                <strong>Pesos sum:</strong> {totalWeight.toFixed(2)}%{' '}
                {Math.abs(totalWeight - 100) < 0.5 ? '✓' : '⚠ se guardarán solo si suman 100%'}
              </li>
              <li>
                <strong>Bot rules:</strong> {draft.botRules.length}
              </li>
              <li>
                <strong>Status inicial:</strong> <code>draft</code> (no aparecerá en el selector
                global hasta que lo actives)
              </li>
            </ul>

            {validation && (
              <div
                style={{
                  marginTop: 16,
                  padding: 12,
                  background: '#fff',
                  borderRadius: 6,
                  border: '1px solid #e2e8f0',
                }}
              >
                <strong style={{ fontSize: 12 }}>Validación post-creación:</strong>
                <table className="config-table" style={{ marginTop: 6, fontSize: 11 }}>
                  <tbody>
                    {validation.map((v) => (
                      <tr key={v.check_name}>
                        <td>
                          <span
                            style={{
                              padding: '2px 6px',
                              borderRadius: 4,
                              fontSize: 10,
                              fontWeight: 600,
                              background:
                                v.status === 'ok'
                                  ? '#d1fae5'
                                  : v.status === 'warning'
                                    ? '#fef3c7'
                                    : '#fee2e2',
                              color:
                                v.status === 'ok'
                                  ? '#065f46'
                                  : v.status === 'warning'
                                    ? '#78350f'
                                    : '#991b1b',
                            }}
                          >
                            {v.status}
                          </span>
                        </td>
                        <td>
                          <strong>{v.check_name}</strong>
                        </td>
                        <td>{v.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p style={{ fontSize: 11, color: '#64748b', marginTop: 8 }}>
                  ℹ Después podés activar el país desde /config → Países cambiando{' '}
                  <code>status</code> a <code>active</code>.
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer navegación */}
      <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'space-between' }}>
        <Button
          variant="outline"
          onClick={() => setStep((s) => Math.max(0, s - 1))}
          disabled={step === 0}
          className="rounded-[4px] border-slate-300"
        >
          ← Anterior
        </Button>

        {stepErrors.length > 0 && (
          <div
            style={{ fontSize: 11, color: '#b91c1c', flex: 1, textAlign: 'center', padding: '8px' }}
          >
            {stepErrors.map((e) => (
              <div key={e}>⚠ {e}</div>
            ))}
          </div>
        )}

        {step < STEPS.length - 1 ? (
          <Button onClick={() => setStep((s) => s + 1)} disabled={!canAdvance}>
            Siguiente →
          </Button>
        ) : (
          // Bug previo: `validation` siendo `[]` se evaluaba truthy y dejaba
          // el botón disabled tras un save exitoso. Ahora chequeamos !== null
          // explícito para identificar "creado". Si saving o canAdvance, también
          // disabled — el resto del tiempo, habilitado.
          <Button onClick={handleFinish} disabled={saving || !canAdvance || validation !== null}>
            {saving ? 'Creando…' : validation !== null ? '✓ Creado' : 'Crear país (status=draft)'}
          </Button>
        )}
      </div>
    </div>
  )
}

// ── Estilos compartidos ─────────────────────────────────────────────────
function Field({ label, required, children }) {
  return (
    <div>
      {label && (
        <label
          style={{
            display: 'block',
            fontSize: 10,
            fontWeight: 600,
            color: '#475569',
            marginBottom: 3,
          }}
        >
          {label}
          {required && <span style={{ color: '#dc2626' }}> *</span>}
        </label>
      )}
      {children}
    </div>
  )
}

const categoryTag = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '2px 6px',
  fontSize: 11,
  borderRadius: 10,
  background: '#dbeafe',
  color: '#1e3a8a',
  border: '1px solid #93c5fd',
}
const tagRemove = {
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  fontSize: 10,
  color: '#1e3a8a',
}
