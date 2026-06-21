import { useState, useEffect } from 'react'
import { sb } from '../../lib/supabase'
import SaveStatusBanner from './SaveStatusBanner'
import { useConfirm } from '../ui/ConfirmDialog'

// Editor del bono Yango por % de GMV (tabla yango_gmv_tiers, mig 116).
// Una fila = un peldaño. variant ∈ unbranded|branded|vip (VIP = Premier en Lima).
const VARIANTS = [
  { key: 'unbranded', label: 'Sin brandeo' },
  { key: 'branded', label: 'Con brandeo' },
  { key: 'vip', label: 'VIP (Premier · solo Lima)' },
]
const CITIES = ['Lima', 'Trujillo', 'Arequipa']

export default function YangoGmvConfig({ country }) {
  const confirm = useConfirm()
  const [tiers, setTiers] = useState([])
  const [original, setOriginal] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState(null)
  const [city, setCity] = useState('Lima')
  const [variant, setVariant] = useState('unbranded')

  useEffect(() => {
    load() /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [country])

  useEffect(() => {
    function onChange(e) {
      if (e?.detail?.table === 'yango_gmv_tiers') load()
    }
    window.addEventListener('config:changed', onChange)
    return () => window.removeEventListener('config:changed', onChange)
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [country])

  async function load() {
    setLoading(true)
    const { data } = await sb
      .from('yango_gmv_tiers')
      .select('*')
      .eq('country', country)
      .order('city')
      .order('variant')
      .order('min_trips')
    setTiers(data || [])
    setOriginal((data || []).map((r) => ({ ...r })))
    setLoading(false)
  }

  const rows = tiers.filter((t) => t.city === city && t.variant === variant)

  function update(id, field, val) {
    setMsg(null)
    setTiers((prev) => prev.map((t) => (t.id === id ? { ...t, [field]: val } : t)))
  }

  function addTier() {
    setMsg(null)
    setTiers((prev) => [
      ...prev,
      { id: `new_${Date.now()}`, country, city, variant, min_trips: 0, pct: 0, cap: 0, _new: true },
    ])
  }

  const isDirty = (t) => {
    if (t._new) return true
    const o = original.find((x) => x.id === t.id)
    if (!o) return true
    return (
      Number(t.min_trips) !== Number(o.min_trips) ||
      Number(t.pct) !== Number(o.pct) ||
      Number(t.cap) !== Number(o.cap)
    )
  }

  async function saveTier(t) {
    setSaving(true)
    setMsg(null)
    const payload = {
      country,
      city: t.city,
      variant: t.variant,
      min_trips: Number(t.min_trips) || 0,
      pct: Number(t.pct) || 0,
      cap: Number(t.cap) || 0,
    }
    let err
    if (t._new) {
      ;({ error: err } = await sb.from('yango_gmv_tiers').insert(payload))
    } else {
      ;({ error: err } = await sb.from('yango_gmv_tiers').update(payload).eq('id', t.id))
    }
    if (err) {
      setMsg({ type: 'err', text: 'Error al guardar: ' + err.message })
    } else {
      setMsg({
        type: 'ok',
        text: `Peldaño guardado: ≥${payload.min_trips} viajes → ${payload.pct}% / tope S/${payload.cap}`,
      })
      await load()
    }
    setSaving(false)
  }

  async function deleteTier(t) {
    if (String(t.id).startsWith('new_')) {
      setTiers((prev) => prev.filter((x) => x.id !== t.id))
      return
    }
    const ok = await confirm({
      title: 'Eliminar peldaño',
      message: '¿Eliminar este peldaño del bono GMV?',
      danger: true,
      confirmText: 'Eliminar',
    })
    if (!ok) return
    const { error } = await sb.from('yango_gmv_tiers').delete().eq('id', t.id)
    if (!error) {
      setMsg({ type: 'ok', text: 'Peldaño eliminado.' })
      await load()
    } else {
      setMsg({ type: 'err', text: 'Error al eliminar: ' + error.message })
    }
  }

  if (loading) return <div className="config-loading">Cargando bono GMV…</div>

  const dirtyCellStyle = { background: '#fef3c7', borderColor: '#f59e0b', fontWeight: 600 }

  return (
    <div className="config-section">
      <h2>Bono Yango por % de GMV</h2>
      <p style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 12 }}>
        Bono = mín(<strong>%</strong> · GMV semanal, <strong>tope</strong>) del peldaño más alto
        alcanzado por # de viajes; GMV = tarifa × viajes. Aplica UNA tabla (no suma). Alimenta el
        take-home de Yango en <strong>Análisis → Rentabilidad</strong> (toggle Brandeado). VIP es
        solo para Premier en Lima.
      </p>

      <div
        style={{
          display: 'flex',
          gap: 12,
          marginBottom: 12,
          flexWrap: 'wrap',
          alignItems: 'center',
        }}
      >
        <label>
          Ciudad{' '}
          <select value={city} onChange={(e) => setCity(e.target.value)}>
            {CITIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <div style={{ display: 'inline-flex', gap: 6 }}>
          {VARIANTS.map((v) => {
            const disabled = v.key === 'vip' && city !== 'Lima'
            return (
              <button
                key={v.key}
                onClick={() => setVariant(v.key)}
                disabled={disabled}
                style={{
                  padding: '5px 12px',
                  borderRadius: 6,
                  fontSize: 12,
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  border:
                    '1px solid ' +
                    (variant === v.key
                      ? 'var(--color-yango, #E53935)'
                      : 'var(--color-border, #e2e8f0)'),
                  background: variant === v.key ? 'var(--color-yango, #E53935)' : '#fff',
                  color: variant === v.key ? '#fff' : 'var(--color-muted)',
                  opacity: disabled ? 0.4 : 1,
                }}
              >
                {v.label}
              </button>
            )
          })}
        </div>
      </div>

      <SaveStatusBanner status={msg} onDismiss={() => setMsg(null)} />

      <table className="config-table" style={{ marginTop: 10 }}>
        <thead>
          <tr>
            <th scope="col">≥ Viajes/sem</th>
            <th scope="col">% del GMV</th>
            <th scope="col">Tope (S/)</th>
            <th scope="col"></th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={4} style={{ color: 'var(--color-muted)' }}>
                Sin peldaños para {city} · {VARIANTS.find((v) => v.key === variant)?.label} — agregá
                uno.
              </td>
            </tr>
          )}
          {rows.map((t) => {
            const dirty = isDirty(t)
            return (
              <tr key={t.id} style={dirty ? { background: '#fffbeb' } : undefined}>
                <td>
                  <input
                    type="number"
                    min="0"
                    value={t.min_trips}
                    onChange={(e) => update(t.id, 'min_trips', e.target.value)}
                    style={{ width: 80, ...(dirty ? dirtyCellStyle : {}) }}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    value={t.pct}
                    onChange={(e) => update(t.id, 'pct', e.target.value)}
                    style={{ width: 70, ...(dirty ? dirtyCellStyle : {}) }}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    min="0"
                    value={t.cap}
                    onChange={(e) => update(t.id, 'cap', e.target.value)}
                    style={{ width: 80, ...(dirty ? dirtyCellStyle : {}) }}
                  />
                </td>
                <td style={{ display: 'flex', gap: 6 }}>
                  <button
                    className="btn-save-sm"
                    onClick={() => saveTier(t)}
                    disabled={saving || !dirty}
                    title={!dirty ? 'Sin cambios' : 'Guardar peldaño'}
                  >
                    {t._new ? 'Crear' : 'Guardar'}
                  </button>
                  <button
                    className="btn-delete-sm"
                    aria-label="Eliminar"
                    onClick={() => deleteTier(t)}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <button className="btn-add-row" onClick={addTier} style={{ marginTop: 10 }}>
        + Agregar peldaño
      </button>
    </div>
  )
}
