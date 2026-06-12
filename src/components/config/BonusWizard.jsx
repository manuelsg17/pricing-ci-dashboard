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
import { rowWeeklyCash, describeBonus } from '../../lib/competitorBonus'

const ALL_COMPETITORS = Object.keys(COMPETITOR_COLORS)

// {C} se reemplaza por la moneda del país al renderizar.
const MECH_CARDS = [
  {
    value: 'tiered',
    label: 'Escalera de montos',
    desc: 'Cuantos más viajes, más grande el premio fijo. Paga solo el peldaño más alto que alcances.',
    example: 'Ej. Uber: 20 viajes → {C}50 · 40 viajes → {C}120',
  },
  {
    value: 'gmv_tiered',
    label: '% del GMV con metas',
    desc: 'Elegís una meta de N viajes y te devuelven un % de lo facturado (antes de comisión) en esos primeros N viajes. Cada meta tiene su tope.',
    example: 'Ej. Yango: meta 20 viajes → 5% del GMV, tope {C}40',
  },
  {
    value: 'flat',
    label: 'Monto fijo',
    desc: 'Llegás al umbral de viajes u horas y te dan un monto fijo.',
    example: 'Ej. 30 viajes en la semana → {C}80',
  },
  {
    value: 'guarantee',
    label: 'Garantía (piso)',
    desc: 'Si hacés N viajes, te aseguran un mínimo: completan la diferencia entre lo que ganaste y el piso.',
    example: 'Ej. 40 viajes → te aseguran {C}500',
  },
  {
    value: 'comm_discount',
    label: 'Descuento de comisión',
    desc: 'En ciertas horas la comisión baja. No es plata directa: pagás menos comisión.',
    example: 'Ej. InDrive: 1% de comisión en hora pico',
  },
  {
    value: 'comm_credit',
    label: 'Monedas / crédito',
    desc: 'Crédito semanal para pagar comisión — equivale a cash.',
    example: 'Ej. {C}30 en monedas por semana',
  },
  {
    value: 'streak',
    label: 'Racha de días',
    desc: 'Premio por trabajar días consecutivos en ventanas horarias.',
    example: 'Ej. Didi: {C}16, {C}18, {C}20 por día 1, 2, 3…',
  },
  {
    value: 'surge',
    label: 'Surge / multiplicador',
    desc: '% extra sobre la tarifa en una ventana horaria, con tope.',
    example: 'Ej. Didi TAD: +30% sobre el fare, tope {C}88',
  },
]

const SEGMENTS = [
  { value: 'active', label: 'Drivers activos', hint: 'el caso típico para comparar' },
  { value: 'new', label: 'Solo nuevos', hint: 'bono de captación' },
  { value: 'reactivated', label: 'Solo reactivados', hint: 'bono de retorno' },
  { value: 'all', label: 'Todos', hint: 'sin restricción de segmento' },
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
const btnPrimary = {
  padding: '8px 18px',
  borderRadius: 8,
  border: 'none',
  cursor: 'pointer',
  background: 'var(--color-yango, #E53935)',
  color: '#fff',
  fontWeight: 600,
  fontSize: 13,
}
const btnGhost = {
  padding: '8px 14px',
  borderRadius: 8,
  cursor: 'pointer',
  fontSize: 13,
  border: '1px solid var(--color-border, #e2e8f0)',
  background: '#fff',
  color: 'var(--color-muted)',
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
      if (value === 'gmv_tiered' && tiers.some((t) => !('pct' in t))) {
        tiers = tiers.map((t) => ({ threshold: t.threshold ?? '', pct: '', cap: '' }))
      } else if (value === 'tiered' && tiers.some((t) => !('reward' in t))) {
        tiers = tiers.map((t) => ({ threshold: t.threshold ?? '', reward: '' }))
      }
      return { ...d, mechanism: value, tiers }
    })
  }

  // Validación del paso "Los números": evita guardar bonos que pagan 0
  // silencioso en Rentabilidad por campos vacíos.
  const numbersOk = (() => {
    switch (mech) {
      case 'tiered':
        return draft.tiers.some((t) => Number(t.threshold) > 0 && Number(t.reward) > 0)
      case 'gmv_tiered':
        return draft.tiers.some((t) => Number(t.threshold) > 0 && Number(t.pct) > 0)
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
      tiers: (draft.tiers || []).filter((t) => t.threshold !== '' && t.threshold != null),
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

  const steps = ['¿De quién es?', '¿Cómo funciona?', 'Los números', 'Condiciones', 'Confirmar']

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
            <div style={qStyle}>¿Qué competidor ofrece este bono?</div>
            <div style={subStyle}>
              Y dónde aplica. Si la escalera cambia por ciudad (ej. Lima vs Trujillo), creá un bono
              por ciudad.
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
              {ALL_COMPETITORS.map((c) => (
                <button
                  key={c}
                  onClick={() => set('competitor_name', c)}
                  style={{
                    ...mechCardStyle(draft.competitor_name === c),
                    padding: '6px 14px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
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
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 14 }}>
              <label>
                <Lbl>Ciudad</Lbl>
                <select
                  style={inputStyle}
                  value={draft.city || ''}
                  onChange={(e) => set('city', e.target.value || null)}
                >
                  <option value="">Todas</option>
                  {config.dbCities.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <Lbl>Categoría</Lbl>
                <select
                  style={inputStyle}
                  value={draft.category || ''}
                  onChange={(e) => set('category', e.target.value || null)}
                >
                  <option value="">Todas</option>
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
            <div style={qStyle}>¿Cómo funciona el bono?</div>
            <div style={subStyle}>Elegí el que mejor describe lo que el driver recibe.</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {MECH_CARDS.map((m) => (
                <div
                  key={m.value}
                  style={mechCardStyle(mech === m.value)}
                  onClick={() => pickMechanism(m.value)}
                >
                  <div style={{ fontSize: 13, fontWeight: 700 }}>{m.label}</div>
                  <div style={{ fontSize: 11, color: 'var(--color-muted)', margin: '3px 0' }}>
                    {m.desc}
                  </div>
                  <div style={{ fontSize: 11, color: '#0369a1' }}>
                    {m.example.replaceAll('{C}', currency)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Paso 2: números según mecanismo */}
        {step === 2 && (
          <div>
            <div style={qStyle}>Los números del bono</div>

            {(mech === 'tiered' || isGmv) && (
              <div>
                <div style={subStyle}>
                  {isGmv
                    ? `Cada meta: con N viajes te devuelven un % del GMV (lo facturado antes de comisión) de esos primeros N viajes, hasta el tope.`
                    : 'Cada peldaño: a partir de N viajes, premio fijo acumulado. Paga solo el más alto alcanzado.'}
                </div>
                {draft.tiers.map((t, i) => (
                  <div
                    key={i}
                    style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}
                  >
                    <span style={{ fontSize: 12 }}>Meta</span>
                    <input
                      type="number"
                      min="0"
                      style={{ ...inputStyle, width: 75 }}
                      placeholder="viajes"
                      value={t.threshold}
                      onChange={(e) => updateTier(i, 'threshold', e.target.value)}
                    />
                    {isGmv ? (
                      <>
                        <span style={{ fontSize: 12 }}>viajes →</span>
                        <input
                          type="number"
                          min="0"
                          step="0.1"
                          style={{ ...inputStyle, width: 70 }}
                          placeholder="%"
                          value={t.pct}
                          onChange={(e) => updateTier(i, 'pct', e.target.value)}
                        />
                        <span style={{ fontSize: 12 }}>% del GMV, tope {currency}</span>
                        <input
                          type="number"
                          min="0"
                          style={{ ...inputStyle, width: 80 }}
                          placeholder="tope"
                          value={t.cap}
                          onChange={(e) => updateTier(i, 'cap', e.target.value)}
                        />
                      </>
                    ) : (
                      <>
                        <span style={{ fontSize: 12 }}>viajes → {currency}</span>
                        <input
                          type="number"
                          min="0"
                          style={{ ...inputStyle, width: 90 }}
                          placeholder="premio"
                          value={t.reward}
                          onChange={(e) => updateTier(i, 'reward', e.target.value)}
                        />
                      </>
                    )}
                    <button
                      style={btnGhost}
                      onClick={() =>
                        set(
                          'tiers',
                          draft.tiers.filter((_, j) => j !== i)
                        )
                      }
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <button
                  style={{ ...btnGhost, borderStyle: 'dashed' }}
                  onClick={() => set('tiers', [...draft.tiers, blankTier])}
                >
                  + agregar meta
                </button>
                {!isGmv && (
                  <div style={{ marginTop: 10 }}>
                    <Lbl>Tope global opcional ({currency})</Lbl>
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
                  <Lbl>Umbral de</Lbl>
                  <select
                    style={inputStyle}
                    value={draft.bonus_type}
                    onChange={(e) => set('bonus_type', e.target.value)}
                  >
                    <option value="viajes">Viajes</option>
                    <option value="horas">Horas</option>
                  </select>
                </label>
                <label>
                  <Lbl>Cantidad</Lbl>
                  <input
                    type="number"
                    min="0"
                    style={{ ...inputStyle, width: 80 }}
                    value={draft.threshold}
                    onChange={(e) => set('threshold', e.target.value)}
                  />
                </label>
                <label>
                  <Lbl>Premio ({currency})</Lbl>
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
                  <Lbl>Si hace N viajes</Lbl>
                  <input
                    type="number"
                    min="0"
                    style={{ ...inputStyle, width: 80 }}
                    value={draft.threshold}
                    onChange={(e) => set('threshold', e.target.value)}
                  />
                </label>
                <label>
                  <Lbl>Le aseguran ({currency})</Lbl>
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
                  <Lbl>Comisión en la ventana (%)</Lbl>
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
                  <Lbl>% de viajes en la ventana (0–1)</Lbl>
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
                <Lbl>Crédito por semana ({currency})</Lbl>
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
                  <Lbl>% extra sobre la tarifa</Lbl>
                  <input
                    type="number"
                    min="0"
                    style={{ ...inputStyle, width: 80 }}
                    value={draft.mult_pct}
                    onChange={(e) => set('mult_pct', e.target.value)}
                  />
                </label>
                <label>
                  <Lbl>Tope ({currency})</Lbl>
                  <input
                    type="number"
                    min="0"
                    style={{ ...inputStyle, width: 80 }}
                    value={draft.cap_amount}
                    onChange={(e) => set('cap_amount', e.target.value)}
                  />
                </label>
                <label>
                  <Lbl>% de viajes en la ventana (0–1)</Lbl>
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
                  <Lbl>Ventanas por día</Lbl>
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
                  <Lbl>Premios por día (separados por coma)</Lbl>
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
                  <Lbl>Tope total/semana</Lbl>
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
            <div style={qStyle}>¿Quién puede ganarlo y cada cuánto?</div>
            <div style={subStyle}>
              Esto define en qué comparaciones de Rentabilidad entra el bono.
            </div>
            <Lbl>Segmento de drivers</Lbl>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
              {SEGMENTS.map((s) => (
                <div
                  key={s.value}
                  style={{ ...mechCardStyle(draft.segment === s.value), padding: '8px 12px' }}
                  onClick={() => set('segment', s.value)}
                >
                  <div style={{ fontSize: 12, fontWeight: 700 }}>{s.label}</div>
                  <div style={{ fontSize: 10, color: 'var(--color-muted)' }}>{s.hint}</div>
                </div>
              ))}
            </div>
            <Lbl>Frecuencia</Lbl>
            <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
              <div
                style={{ ...mechCardStyle(draft.recurring === true), padding: '8px 12px' }}
                onClick={() => set('recurring', true)}
              >
                <div style={{ fontSize: 12, fontWeight: 700 }}>Todas las semanas</div>
                <div style={{ fontSize: 10, color: 'var(--color-muted)' }}>
                  cuenta en la ganancia semanal
                </div>
              </div>
              <div
                style={{ ...mechCardStyle(draft.recurring === false), padding: '8px 12px' }}
                onClick={() => set('recurring', false)}
              >
                <div style={{ fontSize: 12, fontWeight: 700 }}>Una sola vez (gancho)</div>
                <div style={{ fontSize: 10, color: 'var(--color-muted)' }}>
                  bono de entrada, no recurrente
                </div>
              </div>
            </div>
            <label style={{ display: 'block' }}>
              <Lbl>Nota para vos (opcional)</Lbl>
              <input
                type="text"
                style={{ ...inputStyle, width: '100%' }}
                placeholder="Ej: quest fin de semana junio"
                value={draft.description}
                onChange={(e) => set('description', e.target.value)}
              />
            </label>
          </div>
        )}

        {/* Paso 4: confirmar con ejemplo en vivo */}
        {step === 4 && (
          <div>
            <div style={qStyle}>Revisá que esté bien</div>
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
                {draft.competitor_name} · {draft.city || 'Todas las ciudades'} ·{' '}
                {draft.category || 'todas las categorías'}
              </div>
              <div>{describeBonus(draft, currency)}</div>
              <div style={{ fontSize: 11, color: 'var(--color-muted)', marginTop: 4 }}>
                {SEGMENTS.find((s) => s.value === draft.segment)?.label} ·{' '}
                {draft.recurring ? 'todas las semanas' : 'una sola vez'}
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
                🧮 Probalo: ¿cuánto ganaría un driver con este bono?
              </div>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                <label style={{ fontSize: 12 }}>
                  Viajes en la semana{' '}
                  <input
                    type="number"
                    min="0"
                    style={{ ...inputStyle, width: 70 }}
                    value={exTrips}
                    onChange={(e) => setExTrips(e.target.value)}
                  />
                </label>
                <label style={{ fontSize: 12 }}>
                  Tarifa promedio ({currency}){' '}
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
                  → bono: {currency} {Number(exampleValue || 0).toFixed(2)}
                </div>
              </div>
              {mech === 'comm_discount' && (
                <div style={{ fontSize: 11, color: 'var(--color-muted)', marginTop: 6 }}>
                  Este mecanismo no paga cash: baja la comisión efectiva en Rentabilidad.
                </div>
              )}
              {mech === 'guarantee' && (
                <div style={{ fontSize: 11, color: 'var(--color-muted)', marginTop: 6 }}>
                  Calculado con comisión {commissions?.[draft.competitor_name] ?? 20}% de{' '}
                  {draft.competitor_name} (la misma que usa Rentabilidad).
                </div>
              )}
              {mech === 'surge' && draft.share_in_window === '' && (
                <div style={{ fontSize: 11, color: 'var(--color-muted)', marginTop: 6 }}>
                  Asumiendo 25% de los viajes dentro de la ventana (ajustable en el Arquetipo de
                  driver de Rentabilidad).
                </div>
              )}
            </div>
          </div>
        )}

        {/* Navegación */}
        {step === 2 && !numbersOk && (
          <div style={{ fontSize: 11, color: '#b45309', marginTop: 10 }}>
            Completá los números del bono (meta y monto/%) para continuar.
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
          <button style={btnGhost} onClick={onClose}>
            Cancelar
          </button>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            {step > 0 && (
              <button style={btnGhost} onClick={() => setStep(step - 1)}>
                ← Atrás
              </button>
            )}
            {step < 4 ? (
              <button
                style={{
                  ...btnPrimary,
                  opacity: canNext ? 1 : 0.45,
                  cursor: canNext ? 'pointer' : 'not-allowed',
                }}
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
                Siguiente →
              </button>
            ) : (
              <button
                style={{ ...btnPrimary, opacity: numbersOk ? 1 : 0.45 }}
                disabled={saving || !numbersOk}
                onClick={() => onSave(draft)}
              >
                {saving ? 'Guardando…' : '✓ Crear bono'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
