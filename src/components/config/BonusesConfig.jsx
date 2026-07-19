import { useState } from 'react'
import { useCompetitorBonuses } from '../../hooks/useCompetitorBonuses'
import { useCompetitorCommissions } from '../../hooks/useCompetitorCommissions'
import { getCountryConfig, COMPETITOR_COLORS } from '../../lib/constants'
import { describeBonus } from '../../lib/competitorBonus'
import SaveStatusBanner from './SaveStatusBanner'
import BonusWizard from './BonusWizard'
import { useConfirm } from '../ui/ConfirmDialog'
import { useCountry } from '../../context/CountryContext'
import { useI18n } from '../../context/LanguageContext'
import { Button } from '../ui/shadcn/button'

const ALL_COMPETITORS = Object.keys(COMPETITOR_COLORS)
const SEGMENTS = [
  { value: 'active', labelKey: 'config.bonuses_config.seg_active' },
  { value: 'new', labelKey: 'config.bonuses_config.seg_new' },
  { value: 'reactivated', labelKey: 'config.bonuses_config.seg_reactivated' },
  { value: 'all', labelKey: 'config.bonus_wizard.seg_all_label' },
]
const MECHANISMS = [
  {
    value: 'tiered',
    labelKey: 'config.bonuses_config.mech_tiered_label',
    hintKey: 'config.bonuses_config.mech_tiered_hint',
  },
  {
    value: 'gmv_tiered',
    labelKey: 'config.bonuses_config.mech_gmv_label',
    hintKey: 'config.bonuses_config.mech_gmv_hint',
  },
  {
    value: 'flat',
    labelKey: 'config.bonuses_config.mech_flat_label',
    hintKey: 'config.bonuses_config.mech_flat_hint',
  },
  {
    value: 'guarantee',
    labelKey: 'config.bonuses_config.mech_guarantee_label',
    hintKey: 'config.bonuses_config.mech_guarantee_hint',
  },
  {
    value: 'comm_discount',
    labelKey: 'config.bonuses_config.mech_comm_discount_label',
    hintKey: 'config.bonuses_config.mech_comm_discount_hint',
  },
  {
    value: 'comm_credit',
    labelKey: 'config.bonuses_config.mech_comm_credit_label',
    hintKey: 'config.bonuses_config.mech_comm_credit_hint',
  },
  {
    value: 'streak',
    labelKey: 'config.bonuses_config.mech_streak_label',
    hintKey: 'config.bonuses_config.mech_streak_hint',
  },
  {
    value: 'surge',
    labelKey: 'config.bonuses_config.mech_surge_label',
    hintKey: 'config.bonuses_config.mech_surge_hint',
  },
]
// ── estilos ──────────────────────────────────────────────────────────────────
const cardStyle = {
  border: '1px solid var(--color-border, #e2e8f0)',
  borderRadius: 8,
  padding: 14,
  marginBottom: 14,
  background: '#fff',
}
const rowStyle = {
  display: 'flex',
  gap: 12,
  flexWrap: 'wrap',
  alignItems: 'flex-end',
  marginBottom: 10,
}
const labelStyle = {
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--color-muted)',
  display: 'block',
  marginBottom: 3,
}
const hintStyle = { fontSize: 11, color: 'var(--color-muted)', fontStyle: 'italic', marginTop: 4 }
// '' → null; un 0 explícito se conserva (igual criterio que el hook).
const numOrNull = (v) => (v === '' || v == null ? null : Number(v))
function pill(active, color = 'var(--color-yango, #E53935)') {
  return {
    padding: '4px 11px',
    borderRadius: 999,
    fontSize: 12,
    cursor: 'pointer',
    border: '1px solid ' + (active ? color : 'var(--color-border, #e2e8f0)'),
    background: active ? color : '#fff',
    color: active ? '#fff' : 'var(--color-muted)',
    fontWeight: active ? 600 : 400,
  }
}

function Field({ label, children }) {
  return (
    <label>
      <span style={labelStyle}>{label}</span>
      {children}
    </label>
  )
}

export default function BonusesConfig({ country }) {
  const { dbConfigs } = useCountry()
  const config = getCountryConfig(country, dbConfigs)
  const confirm = useConfirm()
  const { t } = useI18n()
  const CITY_OPTIONS = [
    { value: '', label: t('access.all') },
    ...config.dbCities.map((c) => ({ value: c, label: c })),
  ]
  const CATEGORY_OPTIONS = [
    { value: '', label: t('access.all') },
    ...[...new Set(Object.values(config.categoriesByCity || {}).flat())].map((c) => ({
      value: c,
      label: c,
    })),
  ]

  const { allRows, loading, saveBonus, deleteBonus, addRow } = useCompetitorBonuses(null, country)
  // Comisiones reales por competidor — para que el preview del wizard
  // calcule garantías con la misma comisión que usa Rentabilidad.
  const { commissions } = useCompetitorCommissions(null, country)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState(null)
  const [edits, setEdits] = useState({})
  const [advOpen, setAdvOpen] = useState({})
  const [openCards, setOpenCards] = useState({})
  const [wizardOpen, setWizardOpen] = useState(false)

  // m = fila + ediciones sin guardar
  const merged = (row) => ({ ...row, ...(edits[row.id] || {}) })
  function setField(id, field, val) {
    setMsg(null)
    setEdits((prev) => ({ ...prev, [id]: { ...prev[id], [field]: val } }))
  }
  const isDirty = (id) => !!edits[id] && Object.keys(edits[id]).length > 0
  const isNew = (row) => String(row.id).startsWith('new_')

  // ── tiers (escalera) ──
  function setTiers(id, tiers) {
    setField(id, 'tiers', tiers)
  }
  // Cambio de mecanismo: remapear tiers a la shape correcta (preservando
  // thresholds). Sin esto, cruzar Escalera↔% GMV deja keys del mecanismo
  // anterior y el bono se guardaría pagando 0 silencioso.
  function setMechanism(id, tiers, value) {
    setMsg(null)
    setEdits((prev) => {
      const cur = { ...prev[id], mechanism: value }
      if (value === 'gmv_tiered' && tiers.some((tier) => !('pct' in tier))) {
        cur.tiers = tiers.map((tier) => ({ threshold: tier.threshold ?? '', pct: '', cap: '' }))
      } else if (value === 'tiered' && tiers.some((tier) => !('reward' in tier))) {
        cur.tiers = tiers.map((tier) => ({ threshold: tier.threshold ?? '', reward: '' }))
      }
      return { ...prev, [id]: cur }
    })
  }
  function updateTier(id, tiers, i, key, val) {
    setTiers(
      id,
      tiers.map((tier, j) => (j === i ? { ...tier, [key]: val } : tier))
    )
  }
  function addTier(id, tiers) {
    setTiers(id, [...tiers, { threshold: '', reward: '' }])
  }
  function removeTier(id, tiers, i) {
    setTiers(
      id,
      tiers.filter((_, j) => j !== i)
    )
  }
  // ── streak_spec ──
  function setStreak(id, spec, key, val) {
    setField(id, 'streak_spec', { ...(spec || {}), [key]: val })
  }

  async function handleSave(row) {
    setSaving(true)
    setMsg(null)
    const m = merged(row)
    const ok = await saveBonus(m)
    if (ok) {
      setEdits((prev) => {
        const n = { ...prev }
        delete n[row.id]
        return n
      })
      const mechInfo = MECHANISMS.find((x) => x.value === (m.mechanism || 'flat'))
      const mechLabel = mechInfo ? t(mechInfo.labelKey) : m.mechanism
      setMsg({
        type: 'ok',
        text: t('config.bonuses_config.saved_toast', {
          competitor: m.competitor_name,
          city: m.city || t('access.all'),
          category: m.category || t('config.bonuses_config.all_categories_short'),
          mech: mechLabel,
          segment: m.segment || 'all',
        }),
      })
    } else {
      setMsg({ type: 'err', text: t('config.bonuses_config.save_error') })
    }
    setSaving(false)
  }

  // Crear desde el asistente paso a paso
  async function handleWizardSave(draft) {
    setSaving(true)
    setMsg(null)
    const ok = await saveBonus({ ...draft, id: `new_${Date.now()}` })
    if (ok) {
      setWizardOpen(false)
      setMsg({
        type: 'ok',
        text: t('config.bonuses_config.wizard_created_toast', {
          competitor: draft.competitor_name,
          city: draft.city || t('access.all'),
        }),
      })
    } else {
      setMsg({
        type: 'err',
        text: t('config.bonuses_config.wizard_create_error'),
      })
    }
    setSaving(false)
  }

  async function handleDelete(row) {
    if (!isNew(row)) {
      const ok = await confirm({
        title: t('config.bonuses_config.delete_confirm_title'),
        message: t('config.bonuses_config.delete_confirm_message'),
        danger: true,
        confirmText: t('app.delete'),
      })
      if (!ok) return
    }
    const ok = await deleteBonus(row.id)
    if (!ok) setMsg({ type: 'err', text: t('config.bonuses_config.delete_error') })
    else if (!isNew(row)) setMsg({ type: 'ok', text: t('config.bonuses_config.delete_success') })
  }

  if (loading) return <div className="config-loading">{t('config.bonuses_config.loading')}</div>

  return (
    <div className="config-section">
      <h2>{t('config.bonuses_config.title')}</h2>
      <p style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 12 }}>
        {t('config.bonuses_config.description')}
      </p>

      <SaveStatusBanner status={msg} onDismiss={() => setMsg(null)} />

      {allRows.map((row) => {
        const m = merged(row)
        const dirty = isDirty(row.id) || isNew(row)
        const mech = m.mechanism || 'flat'
        const tiers = Array.isArray(m.tiers) ? m.tiers : []
        const spec = m.streak_spec || {}
        const adv = advOpen[row.id]
        const open = openCards[row.id] ?? (isNew(row) || dirty)
        return (
          <div
            key={row.id}
            style={{
              ...cardStyle,
              ...(dirty ? { borderColor: '#f59e0b', background: '#fffbeb' } : {}),
            }}
          >
            {/* Resumen siempre visible: qué hace el bono en una frase */}
            <div
              style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}
              onClick={() => setOpenCards((p) => ({ ...p, [row.id]: !open }))}
            >
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: '50%',
                  flexShrink: 0,
                  background: COMPETITOR_COLORS[m.competitor_name] || '#94a3b8',
                }}
              />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>
                  {m.competitor_name || t('config.bonuses_config.new_bonus_label')}{' '}
                  <span style={{ fontWeight: 400, color: 'var(--color-muted)' }}>
                    · {m.city || t('config.commissions.all_cities')} ·{' '}
                    {m.category || t('config.bonuses_config.all_categories_short')}
                  </span>
                  {m.is_active === false && (
                    <span
                      style={{ marginLeft: 8, fontSize: 10, color: '#dc2626', fontWeight: 600 }}
                    >
                      {t('config.bonuses_config.inactive_badge')}
                    </span>
                  )}
                  {m.recurring === false && (
                    <span
                      style={{ marginLeft: 8, fontSize: 10, color: '#b45309', fontWeight: 600 }}
                    >
                      {t('config.bonuses_config.once_badge')}
                    </span>
                  )}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: 'var(--color-muted)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {describeBonus(m, config.currency)}
                  {m.description ? ` — ${m.description}` : ''}
                </div>
              </div>
              <button
                style={{ ...pill(false), marginLeft: 'auto', flexShrink: 0 }}
                onClick={(e) => {
                  e.stopPropagation()
                  setOpenCards((p) => ({ ...p, [row.id]: !open }))
                }}
              >
                {open
                  ? `▾ ${t('config.bonuses_config.close_btn')}`
                  : `✎ ${t('config.bonuses_config.edit_btn')}`}
              </button>
            </div>

            {open && (
              <div style={{ marginTop: 12 }}>
                {/* Cabecera común */}
                <div style={rowStyle}>
                  <Field label={t('config.commissions.col_competitor')}>
                    <select
                      value={m.competitor_name || ''}
                      onChange={(e) => setField(row.id, 'competitor_name', e.target.value)}
                      style={{ width: 150 }}
                    >
                      <option value="">{t('config.commissions.select_placeholder')}</option>
                      {ALL_COMPETITORS.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t('filter.city')}>
                    <select
                      value={m.city || ''}
                      onChange={(e) => setField(row.id, 'city', e.target.value || null)}
                    >
                      {CITY_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t('filter.category')}>
                    <select
                      value={m.category || ''}
                      onChange={(e) => setField(row.id, 'category', e.target.value || null)}
                    >
                      {CATEGORY_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleDelete(row)}
                    aria-label={t('app.delete')}
                    className="ml-auto rounded-full border-red-300 font-normal text-red-600 hover:bg-red-50"
                  >
                    ✕ {t('app.delete')}
                  </Button>
                </div>

                {/* Segmento + recurrencia */}
                <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginBottom: 10 }}>
                  <div>
                    <span style={labelStyle}>{t('config.bonuses_config.segment_label')}</span>
                    <div style={{ display: 'flex', gap: 6 }}>
                      {SEGMENTS.map((s) => (
                        <button
                          key={s.value}
                          onClick={() => setField(row.id, 'segment', s.value)}
                          style={pill((m.segment || 'all') === s.value)}
                        >
                          {t(s.labelKey)}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <span style={labelStyle}>{t('config.bonuses_config.applies_label')}</span>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        onClick={() => setField(row.id, 'recurring', true)}
                        style={pill(m.recurring !== false)}
                      >
                        {t('config.bonuses_config.recurring_btn')}
                      </button>
                      <button
                        onClick={() => setField(row.id, 'recurring', false)}
                        style={pill(m.recurring === false)}
                      >
                        {t('config.bonuses_config.once_btn')}
                      </button>
                    </div>
                  </div>
                </div>

                {/* Selector de mecanismo */}
                <div style={{ marginBottom: 8 }}>
                  <span style={labelStyle}>{t('config.bonuses_config.mechanism_label')}</span>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {MECHANISMS.map((x) => (
                      <button
                        key={x.value}
                        onClick={() => setMechanism(row.id, tiers, x.value)}
                        style={pill(mech === x.value)}
                      >
                        {t(x.labelKey)}
                      </button>
                    ))}
                  </div>
                  <div style={hintStyle}>
                    {t(MECHANISMS.find((x) => x.value === mech)?.hintKey)}
                  </div>
                </div>

                {/* Cuerpo según mecanismo */}
                <div
                  style={{
                    borderTop: '1px dashed var(--color-border, #e2e8f0)',
                    paddingTop: 10,
                    marginTop: 6,
                  }}
                >
                  {mech === 'tiered' && (
                    <div>
                      <span style={labelStyle}>
                        {t('config.bonuses_config.tiers_label', { currency: config.currency })}
                      </span>
                      {tiers.map((tier, i) => (
                        <div
                          key={i}
                          style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}
                        >
                          <span style={{ fontSize: 12 }}>≥</span>
                          <input
                            type="number"
                            min="0"
                            value={tier.threshold ?? ''}
                            placeholder={t('config.bonuses_config.bonus_type_trips').toLowerCase()}
                            style={{ width: 80 }}
                            onChange={(e) =>
                              updateTier(row.id, tiers, i, 'threshold', e.target.value)
                            }
                          />
                          <span style={{ fontSize: 12 }}>
                            {t('config.bonuses_config.bonus_type_trips').toLowerCase()} →{' '}
                            {config.currency}
                          </span>
                          <input
                            type="number"
                            min="0"
                            value={tier.reward ?? ''}
                            placeholder={t('config.bonuses_config.reward_placeholder')}
                            style={{ width: 90 }}
                            onChange={(e) => updateTier(row.id, tiers, i, 'reward', e.target.value)}
                          />
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => removeTier(row.id, tiers, i)}
                            className="h-auto rounded-full px-2 py-0.5 text-xs font-normal text-muted"
                          >
                            ✕
                          </Button>
                        </div>
                      ))}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => addTier(row.id, tiers)}
                        className="mt-0.5 rounded-full border-dashed font-normal text-muted"
                      >
                        + {t('config.bonuses_config.add_tier_btn')}
                      </Button>
                      {/* preview */}
                      {tiers.filter((tier) => tier.threshold !== '' && tier.threshold != null)
                        .length > 0 && (
                        <div style={{ ...hintStyle, marginTop: 6 }}>
                          {t('config.bonuses_config.preview_label')}{' '}
                          {[...tiers]
                            .filter((tier) => tier.threshold !== '' && tier.threshold != null)
                            .sort((a, b) => Number(a.threshold) - Number(b.threshold))
                            .map((tier) =>
                              t('config.bonuses_config.preview_item', {
                                threshold: tier.threshold,
                                currency: config.currency,
                                reward: tier.reward || 0,
                              })
                            )
                            .join('  ·  ')}
                        </div>
                      )}
                      <div style={{ marginTop: 8 }}>
                        <Field
                          label={t('config.bonuses_config.cap_optional_label', {
                            currency: config.currency,
                          })}
                        >
                          <input
                            type="number"
                            min="0"
                            value={m.cap_amount ?? ''}
                            style={{ width: 90 }}
                            onChange={(e) => setField(row.id, 'cap_amount', e.target.value)}
                          />
                        </Field>
                      </div>
                    </div>
                  )}

                  {mech === 'gmv_tiered' && (
                    <div>
                      <span style={labelStyle}>
                        {t('config.bonuses_config.gmv_goals_label', { currency: config.currency })}
                      </span>
                      {tiers.map((tier, i) => (
                        <div
                          key={i}
                          style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}
                        >
                          <span style={{ fontSize: 12 }}>
                            {t('config.bonuses_config.goal_lower')}
                          </span>
                          <input
                            type="number"
                            min="0"
                            value={tier.threshold ?? ''}
                            placeholder={t('config.bonuses_config.bonus_type_trips').toLowerCase()}
                            style={{ width: 75 }}
                            onChange={(e) =>
                              updateTier(row.id, tiers, i, 'threshold', e.target.value)
                            }
                          />
                          <span style={{ fontSize: 12 }}>
                            {t('config.bonuses_config.bonus_type_trips').toLowerCase()} →
                          </span>
                          <input
                            type="number"
                            min="0"
                            step="0.1"
                            value={tier.pct ?? ''}
                            placeholder="%"
                            style={{ width: 65 }}
                            onChange={(e) => updateTier(row.id, tiers, i, 'pct', e.target.value)}
                          />
                          <span style={{ fontSize: 12 }}>
                            {t('config.bonuses_config.gmv_pct_cap_dot', {
                              currency: config.currency,
                            })}
                          </span>
                          <input
                            type="number"
                            min="0"
                            value={tier.cap ?? ''}
                            placeholder={t('config.bonuses_config.cap_currency_label2', {
                              currency: '',
                            })
                              .trim()
                              .toLowerCase()}
                            style={{ width: 80 }}
                            onChange={(e) => updateTier(row.id, tiers, i, 'cap', e.target.value)}
                          />
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => removeTier(row.id, tiers, i)}
                            className="h-auto rounded-full px-2 py-0.5 text-xs font-normal text-muted"
                          >
                            ✕
                          </Button>
                        </div>
                      ))}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          setTiers(row.id, [...tiers, { threshold: '', pct: '', cap: '' }])
                        }
                        className="mt-0.5 rounded-full border-dashed font-normal text-muted"
                      >
                        + {t('config.bonuses_config.add_goal_short')}
                      </Button>
                      <div style={hintStyle}>{t('config.bonuses_config.gmv_hint')}</div>
                    </div>
                  )}

                  {mech === 'flat' && (
                    <div style={rowStyle}>
                      <Field label={t('config.bonuses_config.threshold_type_label')}>
                        <select
                          value={m.bonus_type || 'viajes'}
                          onChange={(e) => setField(row.id, 'bonus_type', e.target.value)}
                        >
                          <option value="viajes">
                            {t('config.bonuses_config.bonus_type_trips')}
                          </option>
                          <option value="horas">
                            {t('config.bonuses_config.bonus_type_hours')}
                          </option>
                        </select>
                      </Field>
                      <Field label={t('config.bonuses_config.threshold_label')}>
                        <input
                          type="number"
                          min="0"
                          value={m.threshold ?? 0}
                          style={{ width: 80 }}
                          onChange={(e) => setField(row.id, 'threshold', e.target.value)}
                        />
                      </Field>
                      <Field
                        label={t('config.bonuses_config.amount_currency_label', {
                          currency: config.currency,
                        })}
                      >
                        <input
                          type="number"
                          min="0"
                          value={m.bonus_amount ?? 0}
                          style={{ width: 90 }}
                          onChange={(e) => setField(row.id, 'bonus_amount', e.target.value)}
                        />
                      </Field>
                    </div>
                  )}

                  {mech === 'guarantee' && (
                    <div style={rowStyle}>
                      <Field label={t('config.bonuses_config.guarantee_threshold_label')}>
                        <input
                          type="number"
                          min="0"
                          value={m.threshold ?? 0}
                          style={{ width: 80 }}
                          onChange={(e) => setField(row.id, 'threshold', e.target.value)}
                        />
                      </Field>
                      <Field
                        label={t('config.bonuses_config.guaranteed_currency', {
                          currency: config.currency,
                        })}
                      >
                        <input
                          type="number"
                          min="0"
                          value={m.bonus_amount ?? 0}
                          style={{ width: 90 }}
                          onChange={(e) => setField(row.id, 'bonus_amount', e.target.value)}
                        />
                      </Field>
                      <div style={hintStyle}>{t('config.bonuses_config.guarantee_hint')}</div>
                    </div>
                  )}

                  {mech === 'comm_discount' && (
                    <div style={rowStyle}>
                      <Field label={t('config.bonuses_config.comm_window_pct_label')}>
                        <input
                          type="number"
                          min="0"
                          max="100"
                          step="0.1"
                          value={m.comm_pct ?? ''}
                          placeholder="1"
                          style={{ width: 80 }}
                          onChange={(e) => setField(row.id, 'comm_pct', e.target.value)}
                        />
                      </Field>
                      <Field label={t('config.bonuses_config.share_window_label')}>
                        <input
                          type="number"
                          min="0"
                          max="1"
                          step="0.05"
                          value={m.share_in_window ?? ''}
                          placeholder="0.25"
                          style={{ width: 90 }}
                          onChange={(e) => setField(row.id, 'share_in_window', e.target.value)}
                        />
                      </Field>
                      <div style={hintStyle}>{t('config.bonuses_config.comm_discount_hint')}</div>
                    </div>
                  )}

                  {mech === 'comm_credit' && (
                    <div style={rowStyle}>
                      <Field
                        label={t('config.bonuses_config.credit_currency_week', {
                          currency: config.currency,
                        })}
                      >
                        <input
                          type="number"
                          min="0"
                          value={m.bonus_amount ?? 0}
                          style={{ width: 100 }}
                          onChange={(e) => setField(row.id, 'bonus_amount', e.target.value)}
                        />
                      </Field>
                      <div style={hintStyle}>{t('config.bonuses_config.comm_credit_hint')}</div>
                    </div>
                  )}

                  {mech === 'surge' && (
                    <div style={rowStyle}>
                      <Field label={t('config.bonuses_config.extra_fare_label')}>
                        <input
                          type="number"
                          min="0"
                          value={m.mult_pct ?? ''}
                          placeholder="30"
                          style={{ width: 80 }}
                          onChange={(e) => setField(row.id, 'mult_pct', e.target.value)}
                        />
                      </Field>
                      <Field
                        label={t('config.bonuses_config.cap_currency_label2', {
                          currency: config.currency,
                        })}
                      >
                        <input
                          type="number"
                          min="0"
                          value={m.cap_amount ?? ''}
                          placeholder="88"
                          style={{ width: 80 }}
                          onChange={(e) => setField(row.id, 'cap_amount', e.target.value)}
                        />
                      </Field>
                      <Field label={t('config.bonuses_config.share_window_label')}>
                        <input
                          type="number"
                          min="0"
                          max="1"
                          step="0.05"
                          value={m.share_in_window ?? ''}
                          placeholder="0.25"
                          style={{ width: 90 }}
                          onChange={(e) => setField(row.id, 'share_in_window', e.target.value)}
                        />
                      </Field>
                    </div>
                  )}

                  {mech === 'streak' && (
                    <div style={rowStyle}>
                      <Field label={t('config.bonuses_config.windows_day_label')}>
                        <input
                          type="number"
                          min="1"
                          value={spec.windows_per_day ?? ''}
                          placeholder="2"
                          style={{ width: 70 }}
                          onChange={(e) =>
                            setStreak(row.id, spec, 'windows_per_day', numOrNull(e.target.value))
                          }
                        />
                      </Field>
                      <Field label={t('config.bonuses_config.rewards_day_comma_label')}>
                        <input
                          type="text"
                          value={
                            Array.isArray(spec.per_day_reward) ? spec.per_day_reward.join(',') : ''
                          }
                          placeholder="16,18,20,22,24"
                          style={{ width: 150 }}
                          onChange={(e) =>
                            setStreak(
                              row.id,
                              spec,
                              'per_day_reward',
                              e.target.value
                                .split(',')
                                .map((x) => Number(x.trim()))
                                .filter((x) => Number.isFinite(x))
                            )
                          }
                        />
                      </Field>
                      <Field label={t('config.bonuses_config.cap_window_label')}>
                        <input
                          type="number"
                          min="0"
                          value={spec.cap_per_window ?? ''}
                          placeholder="100"
                          style={{ width: 80 }}
                          onChange={(e) =>
                            setStreak(row.id, spec, 'cap_per_window', numOrNull(e.target.value))
                          }
                        />
                      </Field>
                      <Field label={t('config.bonuses_config.cap_total_week_label')}>
                        <input
                          type="number"
                          min="0"
                          value={spec.cap_total ?? ''}
                          placeholder="200"
                          style={{ width: 80 }}
                          onChange={(e) =>
                            setStreak(row.id, spec, 'cap_total', numOrNull(e.target.value))
                          }
                        />
                      </Field>
                    </div>
                  )}
                </div>

                {/* Avanzado: alternativas + ventana + zona + activo/orden */}
                <button
                  onClick={() => setAdvOpen((p) => ({ ...p, [row.id]: !p[row.id] }))}
                  style={{
                    ...pill(false),
                    border: 'none',
                    background: 'transparent',
                    color: 'var(--color-muted)',
                    paddingLeft: 0,
                    marginTop: 8,
                  }}
                >
                  {adv ? '▾' : '▸'} {t('config.bonuses_config.advanced_toggle')}
                </button>
                {adv && (
                  <div style={{ ...rowStyle, marginTop: 6 }}>
                    <Field label={t('config.bonuses_config.alt_group_label')}>
                      <input
                        type="text"
                        value={m.group_key || ''}
                        placeholder="ej. uber-quest"
                        style={{ width: 130 }}
                        onChange={(e) => setField(row.id, 'group_key', e.target.value || null)}
                      />
                    </Field>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12 }}>
                      <input
                        type="checkbox"
                        checked={m.is_chosen !== false}
                        onChange={(e) => setField(row.id, 'is_chosen', e.target.checked)}
                        style={{ accentColor: 'var(--color-yango)' }}
                      />
                      {t('config.bonuses_config.is_chosen_label')}
                    </label>
                    <Field label={t('config.bonuses_config.days_label')}>
                      <input
                        type="text"
                        value={m.day_window || ''}
                        placeholder="L-D / V-D"
                        style={{ width: 90 }}
                        onChange={(e) => setField(row.id, 'day_window', e.target.value || null)}
                      />
                    </Field>
                    <Field label={t('config.bonuses_config.time_from_label')}>
                      <input
                        type="text"
                        value={m.time_from || ''}
                        placeholder="07:00"
                        style={{ width: 70 }}
                        onChange={(e) => setField(row.id, 'time_from', e.target.value || null)}
                      />
                    </Field>
                    <Field label={t('config.bonuses_config.time_to_label')}>
                      <input
                        type="text"
                        value={m.time_to || ''}
                        placeholder="08:00"
                        style={{ width: 70 }}
                        onChange={(e) => setField(row.id, 'time_to', e.target.value || null)}
                      />
                    </Field>
                    <Field label={t('config.bonuses_config.zone_label')}>
                      <input
                        type="text"
                        value={m.zone || ''}
                        placeholder="Centro/Mall"
                        style={{ width: 110 }}
                        onChange={(e) => setField(row.id, 'zone', e.target.value || null)}
                      />
                    </Field>
                    <Field label={t('config.bonuses_config.description_label')}>
                      <input
                        type="text"
                        value={m.description || ''}
                        placeholder={t('config.bonuses_config.description_placeholder')}
                        style={{ width: 160 }}
                        onChange={(e) => setField(row.id, 'description', e.target.value)}
                      />
                    </Field>
                  </div>
                )}

                {/* Footer */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12 }}>
                    <input
                      type="checkbox"
                      checked={m.is_active ?? true}
                      onChange={(e) => setField(row.id, 'is_active', e.target.checked)}
                      style={{ accentColor: 'var(--color-yango)' }}
                    />
                    {t('config.bonuses_config.seg_active')}
                  </label>
                  <Button
                    size="sm"
                    onClick={() => handleSave(row)}
                    disabled={saving || !dirty}
                    title={!dirty ? t('config.commissions.no_changes_title') : undefined}
                    className="ml-auto"
                  >
                    {isNew(row) ? t('config.commissions.create_btn') : t('app.save')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )
      })}

      <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
        <Button onClick={() => setWizardOpen(true)}>
          + {t('config.bonuses_config.wizard_btn')}
        </Button>
        <Button
          variant="outline"
          onClick={addRow}
          className="border-dashed bg-transparent font-semibold text-muted hover:border-yango hover:bg-transparent hover:text-yango"
        >
          + {t('config.bonuses_config.expert_card_btn')}
        </Button>
      </div>

      {wizardOpen && (
        <BonusWizard
          config={config}
          currency={config.currency}
          commissions={commissions}
          saving={saving}
          onSave={handleWizardSave}
          onClose={() => setWizardOpen(false)}
        />
      )}
    </div>
  )
}
