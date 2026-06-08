import { useState } from 'react'
import { useCompetitorBonuses } from '../../hooks/useCompetitorBonuses'
import { getCountryConfig, COMPETITOR_COLORS } from '../../lib/constants'
import SaveStatusBanner from './SaveStatusBanner'
import { useConfirm } from '../ui/ConfirmDialog'

const ALL_COMPETITORS = Object.keys(COMPETITOR_COLORS)
const SEGMENTS = [
  { value: 'active', label: 'Activo' },
  { value: 'new', label: 'Nuevo' },
  { value: 'reactivated', label: 'Reactivado' },
  { value: 'all', label: 'Todos' },
]
const MECHANISMS = [
  {
    value: 'tiered',
    label: 'Escalera',
    hint: 'Te pagan el peldaño más alto alcanzado (NO la suma).',
  },
  { value: 'flat', label: 'Plano', hint: 'Monto fijo al llegar al umbral.' },
  {
    value: 'guarantee',
    label: 'Garantía',
    hint: 'Piso: si hacés N viajes te completan hasta el monto.',
  },
  {
    value: 'comm_discount',
    label: 'Desc. comisión',
    hint: 'Baja la comisión en una ventana (ej. InDrive 1%).',
  },
  { value: 'comm_credit', label: 'Monedas', hint: 'Crédito/monedas ≈ cash semanal.' },
  {
    value: 'streak',
    label: 'Racha',
    hint: 'Premio por días consecutivos en ventanas (Didi peaks).',
  },
  {
    value: 'surge',
    label: 'Surge',
    hint: '% extra sobre el fare en una ventana, con tope (Didi TAD).',
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
  const config = getCountryConfig(country)
  const confirm = useConfirm()
  const CITY_OPTIONS = [
    { value: '', label: 'Todas' },
    ...config.dbCities.map((c) => ({ value: c, label: c })),
  ]
  const CATEGORY_OPTIONS = [
    { value: '', label: 'Todas' },
    ...[...new Set(Object.values(config.categoriesByCity || {}).flat())].map((c) => ({
      value: c,
      label: c,
    })),
  ]

  const { allRows, loading, saveBonus, deleteBonus, addRow } = useCompetitorBonuses(null, country)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState(null)
  const [edits, setEdits] = useState({})
  const [advOpen, setAdvOpen] = useState({})

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
  function updateTier(id, tiers, i, key, val) {
    setTiers(
      id,
      tiers.map((t, j) => (j === i ? { ...t, [key]: val } : t))
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
      const mech = MECHANISMS.find((x) => x.value === (m.mechanism || 'flat'))?.label || m.mechanism
      setMsg({
        type: 'ok',
        text: `Bono guardado: ${m.competitor_name} · ${m.city || 'Todas'} · ${m.category || 'todas las cat.'} · ${mech} (${m.segment || 'all'})`,
      })
    } else {
      setMsg({ type: 'err', text: 'Error al guardar el bono.' })
    }
    setSaving(false)
  }

  async function handleDelete(row) {
    if (!isNew(row)) {
      const ok = await confirm({
        title: 'Eliminar bono',
        message: '¿Eliminar este bono?',
        danger: true,
        confirmText: 'Eliminar',
      })
      if (!ok) return
    }
    const ok = await deleteBonus(row.id)
    if (!ok) setMsg({ type: 'err', text: 'No se pudo eliminar.' })
    else if (!isNew(row)) setMsg({ type: 'ok', text: 'Bono eliminado.' })
  }

  if (loading) return <div className="config-loading">Cargando bonos…</div>

  return (
    <div className="config-section">
      <h2>Bonos por Competidor</h2>
      <p style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 12 }}>
        Cada tarjeta es un bono. Elegí el <strong>mecanismo</strong> y se muestran solo los campos
        que aplican. La <strong>Escalera</strong> paga el peldaño más alto alcanzado (no la suma).
      </p>

      <SaveStatusBanner status={msg} onDismiss={() => setMsg(null)} />

      {allRows.map((row) => {
        const m = merged(row)
        const dirty = isDirty(row.id) || isNew(row)
        const mech = m.mechanism || 'flat'
        const tiers = Array.isArray(m.tiers) ? m.tiers : []
        const spec = m.streak_spec || {}
        const adv = advOpen[row.id]
        return (
          <div
            key={row.id}
            style={{
              ...cardStyle,
              ...(dirty ? { borderColor: '#f59e0b', background: '#fffbeb' } : {}),
            }}
          >
            {/* Cabecera común */}
            <div style={rowStyle}>
              <Field label="Competidor">
                <select
                  value={m.competitor_name || ''}
                  onChange={(e) => setField(row.id, 'competitor_name', e.target.value)}
                  style={{ width: 150 }}
                >
                  <option value="">— Seleccionar —</option>
                  {ALL_COMPETITORS.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Ciudad">
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
              <Field label="Categoría">
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
              <button
                onClick={() => handleDelete(row)}
                aria-label="Eliminar"
                style={{
                  ...pill(false),
                  marginLeft: 'auto',
                  borderColor: '#fca5a5',
                  color: '#dc2626',
                }}
              >
                ✕ Eliminar
              </button>
            </div>

            {/* Segmento + recurrencia */}
            <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginBottom: 10 }}>
              <div>
                <span style={labelStyle}>Segmento (para comparar activo-vs-activo)</span>
                <div style={{ display: 'flex', gap: 6 }}>
                  {SEGMENTS.map((s) => (
                    <button
                      key={s.value}
                      onClick={() => setField(row.id, 'segment', s.value)}
                      style={pill((m.segment || 'all') === s.value)}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <span style={labelStyle}>Aplica</span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    onClick={() => setField(row.id, 'recurring', true)}
                    style={pill(m.recurring !== false)}
                  >
                    Recurrente
                  </button>
                  <button
                    onClick={() => setField(row.id, 'recurring', false)}
                    style={pill(m.recurring === false)}
                  >
                    Una vez (gancho)
                  </button>
                </div>
              </div>
            </div>

            {/* Selector de mecanismo */}
            <div style={{ marginBottom: 8 }}>
              <span style={labelStyle}>Mecanismo</span>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {MECHANISMS.map((x) => (
                  <button
                    key={x.value}
                    onClick={() => setField(row.id, 'mechanism', x.value)}
                    style={pill(mech === x.value)}
                  >
                    {x.label}
                  </button>
                ))}
              </div>
              <div style={hintStyle}>{MECHANISMS.find((x) => x.value === mech)?.hint}</div>
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
                    Peldaños (a partir de N viajes → premio S/, acumulado)
                  </span>
                  {tiers.map((t, i) => (
                    <div
                      key={i}
                      style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}
                    >
                      <span style={{ fontSize: 12 }}>≥</span>
                      <input
                        type="number"
                        min="0"
                        value={t.threshold ?? ''}
                        placeholder="viajes"
                        style={{ width: 80 }}
                        onChange={(e) => updateTier(row.id, tiers, i, 'threshold', e.target.value)}
                      />
                      <span style={{ fontSize: 12 }}>viajes → S/</span>
                      <input
                        type="number"
                        min="0"
                        value={t.reward ?? ''}
                        placeholder="premio"
                        style={{ width: 90 }}
                        onChange={(e) => updateTier(row.id, tiers, i, 'reward', e.target.value)}
                      />
                      <button
                        onClick={() => removeTier(row.id, tiers, i)}
                        style={{ ...pill(false), padding: '2px 8px' }}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                  <button
                    onClick={() => addTier(row.id, tiers)}
                    style={{ ...pill(false), borderStyle: 'dashed', marginTop: 2 }}
                  >
                    + peldaño
                  </button>
                  {/* preview */}
                  {tiers.filter((t) => t.threshold !== '' && t.threshold != null).length > 0 && (
                    <div style={{ ...hintStyle, marginTop: 6 }}>
                      Preview:{' '}
                      {[...tiers]
                        .filter((t) => t.threshold !== '' && t.threshold != null)
                        .sort((a, b) => Number(a.threshold) - Number(b.threshold))
                        .map((t) => `a ${t.threshold} → S/${t.reward || 0}`)
                        .join('  ·  ')}
                    </div>
                  )}
                  <div style={{ marginTop: 8 }}>
                    <Field label="Tope (opcional, S/)">
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

              {mech === 'flat' && (
                <div style={rowStyle}>
                  <Field label="Tipo de umbral">
                    <select
                      value={m.bonus_type || 'viajes'}
                      onChange={(e) => setField(row.id, 'bonus_type', e.target.value)}
                    >
                      <option value="viajes">Viajes</option>
                      <option value="horas">Horas</option>
                    </select>
                  </Field>
                  <Field label="Umbral">
                    <input
                      type="number"
                      min="0"
                      value={m.threshold ?? 0}
                      style={{ width: 80 }}
                      onChange={(e) => setField(row.id, 'threshold', e.target.value)}
                    />
                  </Field>
                  <Field label={`Monto ${config.currency}`}>
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
                  <Field label="Si hace N viajes">
                    <input
                      type="number"
                      min="0"
                      value={m.threshold ?? 0}
                      style={{ width: 80 }}
                      onChange={(e) => setField(row.id, 'threshold', e.target.value)}
                    />
                  </Field>
                  <Field label={`Le aseguran ${config.currency}`}>
                    <input
                      type="number"
                      min="0"
                      value={m.bonus_amount ?? 0}
                      style={{ width: 90 }}
                      onChange={(e) => setField(row.id, 'bonus_amount', e.target.value)}
                    />
                  </Field>
                  <div style={hintStyle}>
                    Piso: se completa hasta el monto con el neto de esos N viajes.
                  </div>
                </div>
              )}

              {mech === 'comm_discount' && (
                <div style={rowStyle}>
                  <Field label="Comisión en ventana %">
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
                  <Field label="% viajes en ventana (0-1)">
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
                  <div style={hintStyle}>
                    Baja la comisión efectiva del competidor según el % de viajes en ventana
                    (también ajustable en el Arquetipo de driver).
                  </div>
                </div>
              )}

              {mech === 'comm_credit' && (
                <div style={rowStyle}>
                  <Field label={`Crédito ${config.currency} / semana`}>
                    <input
                      type="number"
                      min="0"
                      value={m.bonus_amount ?? 0}
                      style={{ width: 100 }}
                      onChange={(e) => setField(row.id, 'bonus_amount', e.target.value)}
                    />
                  </Field>
                  <div style={hintStyle}>
                    Monedas para pagar comisión ≈ cash equivalente. Suele variar por conductor.
                  </div>
                </div>
              )}

              {mech === 'surge' && (
                <div style={rowStyle}>
                  <Field label="% extra sobre fare">
                    <input
                      type="number"
                      min="0"
                      value={m.mult_pct ?? ''}
                      placeholder="30"
                      style={{ width: 80 }}
                      onChange={(e) => setField(row.id, 'mult_pct', e.target.value)}
                    />
                  </Field>
                  <Field label={`Tope ${config.currency}`}>
                    <input
                      type="number"
                      min="0"
                      value={m.cap_amount ?? ''}
                      placeholder="88"
                      style={{ width: 80 }}
                      onChange={(e) => setField(row.id, 'cap_amount', e.target.value)}
                    />
                  </Field>
                  <Field label="% viajes en ventana (0-1)">
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
                  <Field label="Ventanas/día">
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
                  <Field label="Premios por día (coma)">
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
                  <Field label="Tope/ventana">
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
                  <Field label="Tope total/sem">
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
              {adv ? '▾' : '▸'} Avanzado (alternativas, ventana, zona)
            </button>
            {adv && (
              <div style={{ ...rowStyle, marginTop: 6 }}>
                <Field label="Grupo de alternativas">
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
                  Es la elegida del grupo
                </label>
                <Field label="Días">
                  <input
                    type="text"
                    value={m.day_window || ''}
                    placeholder="L-D / V-D"
                    style={{ width: 90 }}
                    onChange={(e) => setField(row.id, 'day_window', e.target.value || null)}
                  />
                </Field>
                <Field label="Hora desde">
                  <input
                    type="text"
                    value={m.time_from || ''}
                    placeholder="07:00"
                    style={{ width: 70 }}
                    onChange={(e) => setField(row.id, 'time_from', e.target.value || null)}
                  />
                </Field>
                <Field label="Hora hasta">
                  <input
                    type="text"
                    value={m.time_to || ''}
                    placeholder="08:00"
                    style={{ width: 70 }}
                    onChange={(e) => setField(row.id, 'time_to', e.target.value || null)}
                  />
                </Field>
                <Field label="Zona">
                  <input
                    type="text"
                    value={m.zone || ''}
                    placeholder="Centro/Mall"
                    style={{ width: 110 }}
                    onChange={(e) => setField(row.id, 'zone', e.target.value || null)}
                  />
                </Field>
                <Field label="Descripción">
                  <input
                    type="text"
                    value={m.description || ''}
                    placeholder="Ej: quest fin de semana"
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
                Activo
              </label>
              <button
                className="btn-save-sm"
                onClick={() => handleSave(row)}
                disabled={saving || !dirty}
                title={!dirty ? 'Sin cambios' : undefined}
                style={{ marginLeft: 'auto' }}
              >
                {isNew(row) ? 'Crear' : 'Guardar'}
              </button>
            </div>
          </div>
        )
      })}

      <button className="btn-add-row" onClick={addRow} style={{ marginTop: 4 }}>
        + Agregar bono
      </button>
    </div>
  )
}
