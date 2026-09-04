/**
 * BonusWizard — asistente paso a paso para crear un bono de competidor.
 *
 * Pensado para que cualquier analista cargue un bono sin conocer el modelo
 * de datos: responde 4 preguntas en lenguaje natural y el wizard arma la
 * fila de competitor_bonuses. El paso final muestra un ejemplo de cálculo
 * en vivo (usa el MISMO motor que Rentabilidad: rowWeeklyCash) para
 * verificar que el bono quedó bien cargado antes de guardar.
 */
import { useMemo, useState } from 'react'
import { COMPETITOR_COLORS } from '../../lib/constants'
import { CATALOG_COMPETITORS } from '../../lib/catalogs'
import { rowWeeklyCash, describeBonus } from '../../lib/competitorBonus'
import { toISODate } from '../../lib/dateUtils'
import { useI18n } from '../../context/LanguageContext'
import { Button } from '../ui/shadcn/button'

// Mismo criterio que BonusesConfig: catálogo canónico (sin las formas legacy
// con espacio que COMPETITOR_COLORS mantiene para leer reportes viejos) y sin
// marcas Yango — un bono de competidor con nombre 'Yango' entraría a bonusFor()
// y falsearía la ganancia en Rentabilidad.
const ALL_COMPETITORS = CATALOG_COMPETITORS.map((c) => c.value).filter(
  (v) => !v.toLowerCase().startsWith('yango')
)

// labelKey/descKey/exampleKey se resuelven con t() en el componente —
// exampleKey usa {currency} para interpolar la moneda del país.
const MECH_CARDS = [
  {
    value: 'tiered',
    labelKey: 'config.bonus_wizard.mech_tiered_label',
    descKey: 'config.bonus_wizard.mech_tiered_desc',
    exampleKey: 'config.bonus_wizard.mech_tiered_example',
  },
  {
    value: 'gmv_tiered',
    labelKey: 'config.bonus_wizard.mech_gmv_tiered_label',
    descKey: 'config.bonus_wizard.mech_gmv_tiered_desc',
    exampleKey: 'config.bonus_wizard.mech_gmv_tiered_example',
  },
  {
    value: 'flat',
    labelKey: 'config.bonus_wizard.mech_flat_label',
    descKey: 'config.bonus_wizard.mech_flat_desc',
    exampleKey: 'config.bonus_wizard.mech_flat_example',
  },
  {
    value: 'guarantee',
    labelKey: 'config.bonus_wizard.mech_guarantee_label',
    descKey: 'config.bonus_wizard.mech_guarantee_desc',
    exampleKey: 'config.bonus_wizard.mech_guarantee_example',
  },
  {
    value: 'comm_discount',
    labelKey: 'config.bonus_wizard.mech_comm_discount_label',
    descKey: 'config.bonus_wizard.mech_comm_discount_desc',
    exampleKey: 'config.bonus_wizard.mech_comm_discount_example',
  },
  {
    value: 'comm_credit',
    labelKey: 'config.bonus_wizard.mech_comm_credit_label',
    descKey: 'config.bonus_wizard.mech_comm_credit_desc',
    exampleKey: 'config.bonus_wizard.mech_comm_credit_example',
  },
  {
    value: 'streak',
    labelKey: 'config.bonus_wizard.mech_streak_label',
    descKey: 'config.bonus_wizard.mech_streak_desc',
    exampleKey: 'config.bonus_wizard.mech_streak_example',
  },
  {
    value: 'surge',
    labelKey: 'config.bonus_wizard.mech_surge_label',
    descKey: 'config.bonus_wizard.mech_surge_desc',
    exampleKey: 'config.bonus_wizard.mech_surge_example',
  },
]

const SEGMENTS = [
  {
    value: 'active',
    labelKey: 'config.bonus_wizard.seg_active_label',
    hintKey: 'config.bonus_wizard.seg_active_hint',
  },
  {
    value: 'new',
    labelKey: 'config.bonus_wizard.seg_new_label',
    hintKey: 'config.bonus_wizard.seg_new_hint',
  },
  {
    value: 'reactivated',
    labelKey: 'config.bonus_wizard.seg_reactivated_label',
    hintKey: 'config.bonus_wizard.seg_reactivated_hint',
  },
  {
    value: 'all',
    labelKey: 'config.bonus_wizard.seg_all_label',
    hintKey: 'config.bonus_wizard.seg_all_hint',
  },
]

// ── estilos ──
const overlayStyle = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(15,23,42,0.45)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
}
const modalStyle = {
  background: '#fff',
  borderRadius: 12,
  padding: 22,
  width: 'min(680px, 94vw)',
  maxHeight: '88vh',
  overflowY: 'auto',
  boxShadow: '0 20px 50px rgba(0,0,0,0.25)',
}
const qStyle = { fontSize: 15, fontWeight: 700, marginBottom: 4 }
const subStyle = { fontSize: 12, color: 'var(--color-muted)', marginBottom: 14 }
const inputStyle = {
  padding: '6px 8px',
  border: '1px solid var(--color-border, #e2e8f0)',
  borderRadius: 6,
}
const mechCardStyle = (active) => ({
  border: active
    ? '2px solid var(--color-yango, #E53935)'
    : '1px solid var(--color-border, #e2e8f0)',
  borderRadius: 10,
  padding: '10px 12px',
  cursor: 'pointer',
  background: active ? '#fef2f2' : '#fff',
})

function Lbl({ children }) {
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        color: 'var(--color-muted)',
        display: 'block',
        marginBottom: 3,
      }}
    >
      {children}
    </span>
  )
}

export default function BonusWizard({
  config,
  currency = 'S/',
  commissions = {},
  onSave,
  onClose,
  saving,
}) {
  const { t } = useI18n()
  const [step, setStep] = useState(0)
  const [draft, setDraft] = useState({
    competitor_name: '',
    city: null,
    category: null,
    mechanism: null,
    tiers: [],
    bonus_type: 'viajes',
    threshold: '',
    bonus_amount: '',
    comm_pct: '',
    share_in_window: '',
    cap_amount: '',
    mult_pct: '',
    streak_spec: null,
    segment: 'active',
    recurring: true,
    description: '',
    is_active: true,
    // mig 237 — vigencia y procedencia (hoy en hora local, no UTC)
    valid_from: toISODate(new Date()),
    valid_to: null,
    source_type: 'captura',
    source_ref: '',
    reported_week: null,
  })
  // Ejemplo de cálculo en vivo (paso final)
  const [exTrips, setExTrips] = useState(40)
  const [exFare, setExFare] = useState(12)

  const set = (field, val) => setDraft((d) => ({ ...d, [field]: val }))

  const mech = draft.mechanism
  const isGmv = mech === 'gmv_tiered'

  // tiers helpers (sirven para tiered y gmv_tiered)
  const blankTier = isGmv ? { threshold: '', pct: '', cap: '' } : { threshold: '', reward: '' }
  function updateTier(i, key, val) {
    set(
      'tiers',
      draft.tiers.map((t, j) => (j === i ? { ...t, [key]: val } : t))
    )
  }

  // Al cambiar de mecanismo, remapear tiers a la shape correcta preservando
  // los thresholds. Sin esto, ir de Escalera a % GMV (o al revés) deja tiers
  // con keys del mecanismo anterior y el bono se guardaría pagando 0.
  function pickMechanism(value) {
    setDraft((d) => {
      let tiers = d.tiers
      if (value === 'gmv_tiered' && tiers.some((tier) => !('pct' in tier))) {
        tiers = tiers.map((tier) => ({ threshold: tier.threshold ?? '', pct: '', cap: '' }))
      } else if (value === 'tiered' && tiers.some((tier) => !('reward' in tier))) {
        tiers = tiers.map((tier) => ({ threshold: tier.threshold ?? '', reward: '' }))
      }
      return { ...d, mechanism: value, tiers }
    })
  }

  // Validación del paso "Los números": evita guardar bonos que pagan 0
  // silencioso en Rentabilidad por campos vacíos.
  const numbersOk = (() => {
    switch (mech) {
      case 'tiered':
        return draft.tiers.some((tier) => Number(tier.threshold) > 0 && Number(tier.reward) > 0)
      case 'gmv_tiered':
        return draft.tiers.some((tier) => Number(tier.threshold) > 0 && Number(tier.pct) > 0)
      case 'flat':
      case 'guarantee':
        return Number(draft.threshold) > 0 && Number(draft.bonus_amount) > 0
      case 'comm_credit':
        return Number(draft.bonus_amount) > 0
      case 'comm_discount':
        return draft.comm_pct !== '' && Number(draft.comm_pct) >= 0
      case 'surge':
        return Number(draft.mult_pct) > 0
      case 'streak':
        return (draft.streak_spec?.per_day_reward || []).length > 0
      default:
        return true
    }
  })()

  const exampleValue = useMemo(() => {
    if (!mech) return null
    const row = {
      ...draft,
      tiers: (draft.tiers || []).filter((tier) => tier.threshold !== '' && tier.threshold != null),
    }
    // Misma comisión que usa Rentabilidad (lookup por competidor, fallback
    // 20) para que el preview coincida con lo que se verá después.
    return rowWeeklyCash(row, {
      trips: Number(exTrips) || 0,
      fare: Number(exFare) || 0,
      hours: 40,
      commPct: commissions?.[draft.competitor_name] ?? 20,
      sharePeak: 0.25,
      streakDays: 7,
    })
  }, [draft, mech, exTrips, exFare, commissions])

  const canNext = [
    !!draft.competitor_name, // paso 0
    !!mech, // paso 1
    numbersOk, // paso 2 — sin números válidos el bono pagaría 0
    true, // paso 3 (condiciones)
  ][step]

  const steps = [
    t('config.bonus_wizard.step_who'),
    t('config.bonus_wizard.step_how'),
    t('config.bonus_wizard.step_numbers'),
    t('config.bonus_wizard.step_conditions'),
    t('config.bonus_wizard.step_confirm'),
  ]

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        {/* Progreso */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 18 }}>
          {steps.map((s, i) => (
            <div key={s} style={{ flex: 1, textAlign: 'center' }}>
              <div
                style={{
                  height: 4,
                  borderRadius: 2,
                  marginBottom: 4,
                  background:
                    i <= step ? 'var(--color-yango, #E53935)' : 'var(--color-border, #e2e8f0)',
                }}
              />
              <span
                style={{
                  fontSize: 10,
                  color: i === step ? '#0f172a' : 'var(--color-muted)',
                  fontWeight: i === step ? 700 : 400,
                }}
              >
                {s}
              </span>
            </div>
          ))}
        </div>

        {/* Paso 0: competidor + alcance */}
        {step === 0 && (
          <div>
            <div style={qStyle}>{t('config.bonus_wizard.q0_title')}</div>
            <div style={subStyle}>{t('config.bonus_wizard.q0_sub')}</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
              {ALL_COMPETITORS.map((c) => {
                const active = draft.competitor_name === c
                return (
                  <Button
                    key={c}
                    type="button"
                    variant="outline"
                    className={
                      'h-auto gap-1.5 rounded-[10px] px-3.5 py-1.5' +
                      (active ? ' border-2 border-yango bg-red-50' : '')
                    }
                    onClick={() => set('competitor_name', c)}
                  >
                    <span
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: '50%',
                        background: COMPETITOR_COLORS[c] || '#64748b',
                      }}
                    />
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{c}</span>
                  </Button>
                )
              })}
            </div>
            <div style={{ display: 'flex', gap: 14 }}>
              <label>
                <Lbl>{t('filter.city')}</Lbl>
                <select
                  style={inputStyle}
                  value={draft.city || ''}
                  onChange={(e) => set('city', e.target.value || null)}
                >
                  <option value="">{t('access.all')}</option>
                  {config.dbCities.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <Lbl>{t('filter.category')}</Lbl>
                <select
                  style={inputStyle}
                  value={draft.category || ''}
                  onChange={(e) => set('category', e.target.value || null)}
                >
                  <option value="">{t('access.all')}</option>
                  {[...new Set(Object.values(config.categoriesByCity || {}).flat())].map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        )}

        {/* Paso 1: mecanismo */}
        {step === 1 && (
          <div>
            <div style={qStyle}>{t('config.bonus_wizard.q1_title')}</div>
            <div style={subStyle}>{t('config.bonus_wizard.q1_sub')}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {MECH_CARDS.map((m) => (
                <div
                  key={m.value}
                  style={mechCardStyle(mech === m.value)}
                  onClick={() => pickMechanism(m.value)}
                >
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{t(m.labelKey)}</div>
                  <div style={{ fontSize: 11, color: 'var(--color-muted)', margin: '3px 0' }}>
                    {t(m.descKey)}
                  </div>
                  <div style={{ fontSize: 11, color: '#0369a1' }}>
                    {t(m.exampleKey, { currency })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Paso 2: números según mecanismo */}
        {step === 2 && (
          <div>
            <div style={qStyle}>{t('config.bonus_wizard.q2_title')}</div>

            {(mech === 'tiered' || isGmv) && (
              <div>
                <div style={subStyle}>
                  {isGmv
                    ? t('config.bonus_wizard.tiers_gmv_sub')
                    : t('config.bonus_wizard.tiers_flat_sub')}
                </div>
                {draft.tiers.map((tier, i) => (
                  <div
                    key={i}
                    style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}
                  >
                    <span style={{ fontSize: 12 }}>{t('config.bonus_wizard.goal_label')}</span>
                    <input
                      type="number"
                      min="0"
                      style={{ ...inputStyle, width: 75 }}
                      placeholder={t('config.bonus_wizard.ph_trips')}
                      value={tier.threshold}
                      onChange={(e) => updateTier(i, 'threshold', e.target.value)}
                    />
                    {isGmv ? (
                      <>
                        <span style={{ fontSize: 12 }}>{t('config.bonus_wizard.trips_arrow')}</span>
                        <input
                          type="number"
                          min="0"
                          step="0.1"
                          style={{ ...inputStyle, width: 70 }}
                          placeholder={t('config.bonus_wizard.ph_pct')}
                          value={tier.pct}
                          onChange={(e) => updateTier(i, 'pct', e.target.value)}
                        />
                        <span style={{ fontSize: 12 }}>
                          {t('config.bonus_wizard.gmv_pct_cap', { currency })}
                        </span>
                        <input
                          type="number"
                          min="0"
                          style={{ ...inputStyle, width: 80 }}
                          placeholder={t('config.bonus_wizard.ph_cap')}
                          value={tier.cap}
                          onChange={(e) => updateTier(i, 'cap', e.target.value)}
                        />
                      </>
                    ) : (
                      <>
                        <span style={{ fontSize: 12 }}>
                          {t('config.bonus_wizard.trips_arrow_currency', { currency })}
                        </span>
                        <input
                          type="number"
                          min="0"
                          style={{ ...inputStyle, width: 90 }}
                          placeholder={t('config.bonus_wizard.ph_reward')}
                          value={tier.reward}
                          onChange={(e) => updateTier(i, 'reward', e.target.value)}
                        />
                      </>
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-auto rounded-lg px-2 py-1 text-muted"
                      onClick={() =>
                        set(
                          'tiers',
                          draft.tiers.filter((_, j) => j !== i)
                        )
                      }
                    >
                      ✕
                    </Button>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="border-dashed text-muted"
                  onClick={() => set('tiers', [...draft.tiers, blankTier])}
                >
                  + {t('config.bonus_wizard.add_goal')}
                </Button>
                {!isGmv && (
                  <div style={{ marginTop: 10 }}>
                    <Lbl>{t('config.bonus_wizard.global_cap_label', { currency })}</Lbl>
                    <input
                      type="number"
                      min="0"
                      style={{ ...inputStyle, width: 100 }}
                      value={draft.cap_amount}
                      onChange={(e) => set('cap_amount', e.target.value)}
                    />
                  </div>
                )}
              </div>
            )}

            {mech === 'flat' && (
              <div style={{ display: 'flex', gap: 14, alignItems: 'flex-end' }}>
                <label>
                  <Lbl>{t('config.bonus_wizard.threshold_of_label')}</Lbl>
                  <select
                    style={inputStyle}
                    value={draft.bonus_type}
                    onChange={(e) => set('bonus_type', e.target.value)}
                  >
                    <option value="viajes">{t('config.bonus_wizard.opt_trips')}</option>
                    <option value="horas">{t('config.bonus_wizard.opt_hours')}</option>
                  </select>
                </label>
                <label>
                  <Lbl>{t('config.bonus_wizard.quantity_label')}</Lbl>
                  <input
                    type="number"
                    min="0"
                    style={{ ...inputStyle, width: 80 }}
                    value={draft.threshold}
                    onChange={(e) => set('threshold', e.target.value)}
                  />
                </label>
                <label>
                  <Lbl>{t('config.bonus_wizard.reward_currency_label', { currency })}</Lbl>
                  <input
                    type="number"
                    min="0"
                    style={{ ...inputStyle, width: 90 }}
                    value={draft.bonus_amount}
                    onChange={(e) => set('bonus_amount', e.target.value)}
                  />
                </label>
              </div>
            )}

            {mech === 'guarantee' && (
              <div style={{ display: 'flex', gap: 14, alignItems: 'flex-end' }}>
                <label>
                  <Lbl>{t('config.bonus_wizard.if_n_trips_label')}</Lbl>
                  <input
                    type="number"
                    min="0"
                    style={{ ...inputStyle, width: 80 }}
                    value={draft.threshold}
                    onChange={(e) => set('threshold', e.target.value)}
                  />
                </label>
                <label>
                  <Lbl>{t('config.bonus_wizard.guaranteed_label', { currency })}</Lbl>
                  <input
                    type="number"
                    min="0"
                    style={{ ...inputStyle, width: 100 }}
                    value={draft.bonus_amount}
                    onChange={(e) => set('bonus_amount', e.target.value)}
                  />
                </label>
              </div>
            )}

            {mech === 'comm_discount' && (
              <div style={{ display: 'flex', gap: 14, alignItems: 'flex-end' }}>
                <label>
                  <Lbl>{t('config.bonus_wizard.comm_window_label')}</Lbl>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.1"
                    style={{ ...inputStyle, width: 80 }}
                    value={draft.comm_pct}
                    onChange={(e) => set('comm_pct', e.target.value)}
                  />
                </label>
                <label>
                  <Lbl>{t('config.bonus_wizard.share_window_label')}</Lbl>
                  <input
                    type="number"
                    min="0"
                    max="1"
                    step="0.05"
                    style={{ ...inputStyle, width: 90 }}
                    placeholder="0.25"
                    value={draft.share_in_window}
                    onChange={(e) => set('share_in_window', e.target.value)}
                  />
                </label>
              </div>
            )}

            {mech === 'comm_credit' && (
              <label>
                <Lbl>{t('config.bonus_wizard.credit_week_label', { currency })}</Lbl>
                <input
                  type="number"
                  min="0"
                  style={{ ...inputStyle, width: 100 }}
                  value={draft.bonus_amount}
                  onChange={(e) => set('bonus_amount', e.target.value)}
                />
              </label>
            )}

            {mech === 'surge' && (
              <div style={{ display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <label>
                  <Lbl>{t('config.bonus_wizard.extra_pct_label')}</Lbl>
                  <input
                    type="number"
                    min="0"
                    style={{ ...inputStyle, width: 80 }}
                    value={draft.mult_pct}
                    onChange={(e) => set('mult_pct', e.target.value)}
                  />
                </label>
                <label>
                  <Lbl>{t('config.bonus_wizard.cap_currency_label', { currency })}</Lbl>
                  <input
                    type="number"
                    min="0"
                    style={{ ...inputStyle, width: 80 }}
                    value={draft.cap_amount}
                    onChange={(e) => set('cap_amount', e.target.value)}
                  />
                </label>
                <label>
                  <Lbl>{t('config.bonus_wizard.share_window_label')}</Lbl>
                  <input
                    type="number"
                    min="0"
                    max="1"
                    step="0.05"
                    style={{ ...inputStyle, width: 90 }}
                    placeholder="0.25"
                    value={draft.share_in_window}
                    onChange={(e) => set('share_in_window', e.target.value)}
                  />
                </label>
              </div>
            )}

            {mech === 'streak' && (
              <div style={{ display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <label>
                  <Lbl>{t('config.bonus_wizard.windows_per_day_label')}</Lbl>
                  <input
                    type="number"
                    min="1"
                    style={{ ...inputStyle, width: 70 }}
                    value={draft.streak_spec?.windows_per_day ?? ''}
                    onChange={(e) =>
                      set('streak_spec', {
                        ...(draft.streak_spec || {}),
                        windows_per_day: Number(e.target.value) || null,
                      })
                    }
                  />
                </label>
                <label>
                  <Lbl>{t('config.bonus_wizard.rewards_per_day_label')}</Lbl>
                  <input
                    type="text"
                    style={{ ...inputStyle, width: 170 }}
                    placeholder="16,18,20,22"
                    value={
                      Array.isArray(draft.streak_spec?.per_day_reward)
                        ? draft.streak_spec.per_day_reward.join(',')
                        : ''
                    }
                    onChange={(e) =>
                      set('streak_spec', {
                        ...(draft.streak_spec || {}),
                        per_day_reward: e.target.value
                          .split(',')
                          .map((x) => Number(x.trim()))
                          .filter((x) => Number.isFinite(x)),
                      })
                    }
                  />
                </label>
                <label>
                  <Lbl>{t('config.bonus_wizard.total_cap_week_label')}</Lbl>
                  <input
                    type="number"
                    min="0"
                    style={{ ...inputStyle, width: 80 }}
                    value={draft.streak_spec?.cap_total ?? ''}
                    onChange={(e) =>
                      set('streak_spec', {
                        ...(draft.streak_spec || {}),
                        cap_total: Number(e.target.value) || null,
                      })
                    }
                  />
                </label>
              </div>
            )}
          </div>
        )}

        {/* Paso 3: condiciones */}
        {step === 3 && (
          <div>
            <div style={qStyle}>{t('config.bonus_wizard.q3_title')}</div>
            <div style={subStyle}>{t('config.bonus_wizard.q3_sub')}</div>
            <Lbl>{t('config.bonus_wizard.segment_label')}</Lbl>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
              {SEGMENTS.map((s) => (
                <div
                  key={s.value}
                  style={{ ...mechCardStyle(draft.segment === s.value), padding: '8px 12px' }}
                  onClick={() => set('segment', s.value)}
                >
                  <div style={{ fontSize: 12, fontWeight: 700 }}>{t(s.labelKey)}</div>
                  <div style={{ fontSize: 10, color: 'var(--color-muted)' }}>{t(s.hintKey)}</div>
                </div>
              ))}
            </div>
            <Lbl>{t('config.bonus_wizard.frequency_label')}</Lbl>
            <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
              <div
                style={{ ...mechCardStyle(draft.recurring === true), padding: '8px 12px' }}
                onClick={() => set('recurring', true)}
              >
                <div style={{ fontSize: 12, fontWeight: 700 }}>
                  {t('config.bonus_wizard.recurring_label')}
                </div>
                <div style={{ fontSize: 10, color: 'var(--color-muted)' }}>
                  {t('config.bonus_wizard.recurring_hint')}
                </div>
              </div>
              <div
                style={{ ...mechCardStyle(draft.recurring === false), padding: '8px 12px' }}
                onClick={() => set('recurring', false)}
              >
                <div style={{ fontSize: 12, fontWeight: 700 }}>
                  {t('config.bonus_wizard.onetime_label')}
                </div>
                <div style={{ fontSize: 10, color: 'var(--color-muted)' }}>
                  {t('config.bonus_wizard.onetime_hint')}
                </div>
              </div>
            </div>
            <label style={{ display: 'block' }}>
              <Lbl>{t('config.bonus_wizard.note_label')}</Lbl>
              <input
                type="text"
                style={{ ...inputStyle, width: '100%' }}
                placeholder={t('config.bonus_wizard.note_placeholder')}
                value={draft.description}
                onChange={(e) => set('description', e.target.value)}
              />
            </label>
          </div>
        )}

        {/* Paso 4: confirmar con ejemplo en vivo */}
        {step === 4 && (
          <div>
            <div style={qStyle}>{t('config.bonus_wizard.review_title')}</div>
            <div
              style={{
                border: '1px solid var(--color-border, #e2e8f0)',
                borderRadius: 10,
                padding: '12px 14px',
                marginBottom: 14,
                background: '#f8fafc',
                fontSize: 13,
              }}
            >
              <div style={{ fontWeight: 700, marginBottom: 4 }}>
                {draft.competitor_name} · {draft.city || t('config.commissions.all_cities')} ·{' '}
                {draft.category || t('config.bonus_wizard.all_categories')}
              </div>
              <div>{describeBonus(draft, currency)}</div>
              <div style={{ fontSize: 11, color: 'var(--color-muted)', marginTop: 4 }}>
                {t(SEGMENTS.find((s) => s.value === draft.segment)?.labelKey)} ·{' '}
                {draft.recurring
                  ? t('config.bonus_wizard.weekly_label')
                  : t('config.bonus_wizard.onetime_summary')}
                {draft.description ? ` · ${draft.description}` : ''}
              </div>
            </div>

            <div
              style={{
                border: '1px dashed var(--color-border, #e2e8f0)',
                borderRadius: 10,
                padding: '12px 14px',
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>
                🧮 {t('config.bonus_wizard.calc_title')}
              </div>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <label style={{ fontSize: 12 }}>
                  {t('config.bonus_wizard.trips_week_label')}{' '}
                  <input
                    type="number"
                    min="0"
                    style={{ ...inputStyle, width: 70 }}
                    value={exTrips}
                    onChange={(e) => setExTrips(e.target.value)}
                  />
                </label>
                <label style={{ fontSize: 12 }}>
                  {t('config.bonus_wizard.avg_fare_label', { currency })}{' '}
                  <input
                    type="number"
                    min="0"
                    step="0.5"
                    style={{ ...inputStyle, width: 70 }}
                    value={exFare}
                    onChange={(e) => setExFare(e.target.value)}
                  />
                </label>
                <div
                  style={{
                    fontSize: 16,
                    fontWeight: 800,
                    color: exampleValue > 0 ? '#15803d' : 'var(--color-muted)',
                  }}
                >
                  {t('config.bonus_wizard.bonus_result', {
                    currency,
                    value: Number(exampleValue || 0).toFixed(2),
                  })}
                </div>
              </div>
              {mech === 'comm_discount' && (
                <div style={{ fontSize: 11, color: 'var(--color-muted)', marginTop: 6 }}>
                  {t('config.bonus_wizard.comm_discount_note')}
                </div>
              )}
              {mech === 'guarantee' && (
                <div style={{ fontSize: 11, color: 'var(--color-muted)', marginTop: 6 }}>
                  {t('config.bonus_wizard.guarantee_note', {
                    pct: commissions?.[draft.competitor_name] ?? 20,
                    competitor: draft.competitor_name,
                  })}
                </div>
              )}
              {mech === 'surge' && draft.share_in_window === '' && (
                <div style={{ fontSize: 11, color: 'var(--color-muted)', marginTop: 6 }}>
                  {t('config.bonus_wizard.surge_note')}
                </div>
              )}
            </div>

            {/* Vigencia y procedencia (mig 237): desde cuándo rige y de dónde salió */}
            <div
              style={{
                border: '1px dashed var(--color-border, #e2e8f0)',
                borderRadius: 10,
                padding: '12px 14px',
                marginTop: 12,
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>
                📅 {t('config.bonuses_config.validity_title')}
              </div>
              <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <label style={{ fontSize: 12 }}>
                  {t('config.bonuses_config.valid_from_label')}{' '}
                  <input
                    type="date"
                    style={{ ...inputStyle, width: 140 }}
                    value={draft.valid_from || ''}
                    onChange={(e) => set('valid_from', e.target.value)}
                  />
                </label>
                <label style={{ fontSize: 12 }}>
                  {t('config.bonuses_config.source_type_label')}{' '}
                  <select
                    style={{ ...inputStyle, width: 160 }}
                    value={draft.source_type || 'captura'}
                    onChange={(e) => set('source_type', e.target.value)}
                  >
                    <option value="informe_msye">
                      {t('config.bonuses_config.source_informe_msye')}
                    </option>
                    <option value="captura">{t('config.bonuses_config.source_captura')}</option>
                    <option value="estimado">{t('config.bonuses_config.source_estimado')}</option>
                  </select>
                </label>
                <label style={{ fontSize: 12 }}>
                  {t('config.bonuses_config.source_ref_label')}{' '}
                  <input
                    type="text"
                    style={{ ...inputStyle, width: 200 }}
                    value={draft.source_ref || ''}
                    onChange={(e) => set('source_ref', e.target.value)}
                  />
                </label>
                <label style={{ fontSize: 12 }}>
                  {t('config.bonuses_config.reported_week_label')}{' '}
                  <input
                    type="date"
                    style={{ ...inputStyle, width: 140 }}
                    value={draft.reported_week || ''}
                    onChange={(e) => set('reported_week', e.target.value || null)}
                  />
                </label>
              </div>
            </div>
          </div>
        )}

        {/* Navegación */}
        {step === 2 && !numbersOk && (
          <div style={{ fontSize: 11, color: '#b45309', marginTop: 10 }}>
            {t('config.bonus_wizard.numbers_incomplete')}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
          <Button type="button" variant="outline" className="text-muted" onClick={onClose}>
            {t('app.cancel')}
          </Button>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            {step > 0 && (
              <Button
                type="button"
                variant="outline"
                className="text-muted"
                onClick={() => setStep(step - 1)}
              >
                ← {t('config.bonus_wizard.back_btn')}
              </Button>
            )}
            {step < 4 ? (
              <Button
                type="button"
                disabled={!canNext}
                onClick={() => {
                  // al entrar a "números" con escalera vacía, arrancar con una meta
                  if (
                    step === 1 &&
                    (mech === 'tiered' || mech === 'gmv_tiered') &&
                    draft.tiers.length === 0
                  ) {
                    set('tiers', [
                      mech === 'gmv_tiered'
                        ? { threshold: '', pct: '', cap: '' }
                        : { threshold: '', reward: '' },
                    ])
                  }
                  setStep(step + 1)
                }}
              >
                {t('config.bonus_wizard.next_btn')} →
              </Button>
            ) : (
              <Button type="button" disabled={saving || !numbersOk} onClick={() => onSave(draft)}>
                {saving ? t('account.saving') : `✓ ${t('config.bonus_wizard.create_btn')}`}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
