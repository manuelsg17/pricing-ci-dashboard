/**
 * SurgeWindowsConfig — Config → Timing → Surge (mig 111).
 *
 * Matriz ciudad × franja horaria: el analista marca en qué franjas hay
 * surge en cada ciudad. El filtro SURGE del dashboard usa estas reglas
 * (Surge=Yes muestra solo las franjas marcadas; No, las no marcadas) en
 * lugar del flag del scraper, que es poco confiable.
 *
 * Guardado instantáneo: cada checkbox inserta/borra su fila en
 * surge_windows — no hay botón "Guardar".
 */
import { useState, useEffect, useCallback } from 'react'
import { sb } from '../../lib/supabase'
import { getCountryConfig } from '../../lib/constants'
import SaveStatusBanner from './SaveStatusBanner'

const TIME_SLOTS = [
  { key: 'early_morning', label: 'Madrugada', range: '0–6h' },
  { key: 'morning', label: 'Mañana', range: '6–12h' },
  { key: 'midday', label: 'Mediodía', range: '12–14h' },
  { key: 'afternoon', label: 'Tarde', range: '14–18h' },
  { key: 'evening', label: 'Noche', range: '18–24h' },
]

export default function SurgeWindowsConfig({ country }) {
  const config = getCountryConfig(country)
  // null = fila "Todas las ciudades" (city NULL en DB) — aplica al país entero
  // salvo que la ciudad tenga sus propias marcas (se suman, no se pisan).
  const cities = [null, ...(config.dbCities || [])]

  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState(null)

  const load = useCallback(async () => {
    const { data, error } = await sb.from('surge_windows').select('*').eq('country', country)
    if (error) {
      setMsg({
        type: 'err',
        text: 'La tabla surge_windows no existe todavía — aplicá la migración 111 en Supabase.',
      })
      setRows([])
    } else {
      setRows(data || [])
    }
    setLoading(false)
  }, [country])

  useEffect(() => {
    setLoading(true)
    load()
  }, [load])

  // Live-sync con otras sesiones
  useEffect(() => {
    function onChange(e) {
      if (e?.detail?.table === 'surge_windows') load()
    }
    window.addEventListener('config:changed', onChange)
    return () => window.removeEventListener('config:changed', onChange)
  }, [load])

  const isOn = (city, slot) =>
    rows.some((r) => r.city === city && r.time_of_day === slot && r.is_active !== false)

  async function toggle(city, slot) {
    setSaving(true)
    setMsg(null)
    const existing = rows.find((r) => r.city === city && r.time_of_day === slot)
    let error
    if (existing) {
      ;({ error } = await sb.from('surge_windows').delete().eq('id', existing.id))
    } else {
      ;({ error } = await sb
        .from('surge_windows')
        .insert({ country, city, time_of_day: slot, is_active: true }))
    }
    if (error) {
      setMsg({ type: 'err', text: 'Error al guardar: ' + error.message })
    } else {
      const slotLabel = TIME_SLOTS.find((s) => s.key === slot)?.label || slot
      const cityLabel = city ?? 'Todas las ciudades'
      setMsg({
        type: 'ok',
        text: existing
          ? `${cityLabel} · ${slotLabel}: ya no se considera surge.`
          : `${cityLabel} · ${slotLabel}: marcada como franja con surge.`,
      })
      await load()
    }
    setSaving(false)
  }

  if (loading) return <div className="config-loading">Cargando ventanas surge…</div>

  return (
    <div className="config-section">
      <h2>Franjas con surge</h2>
      <p style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 12 }}>
        Marcá en qué franjas del día hay surge en cada ciudad. El filtro <strong>SURGE</strong> del
        dashboard usa estas reglas: <strong>Yes</strong> muestra solo los precios observados en
        franjas marcadas, <strong>No</strong> los de las franjas sin marcar. Si una ciudad no tiene
        ninguna franja marcada, el filtro vuelve a usar el flag de surge que manda el bot.
      </p>

      <SaveStatusBanner status={msg} onDismiss={() => setMsg(null)} />

      <table className="config-table" style={{ marginTop: 10 }}>
        <thead>
          <tr>
            <th scope="col">Ciudad</th>
            {TIME_SLOTS.map((s) => (
              <th key={s.key} scope="col" style={{ textAlign: 'center' }}>
                {s.label}
                <div style={{ fontSize: 9, fontWeight: 400, color: 'var(--color-muted)' }}>
                  {s.range}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cities.map((city) => (
            <tr
              key={city ?? '__all__'}
              style={city === null ? { background: '#f8fafc' } : undefined}
            >
              <td style={{ fontWeight: 600 }}>
                {city ?? 'Todas las ciudades'}
                {city === null && (
                  <div style={{ fontSize: 9, fontWeight: 400, color: 'var(--color-muted)' }}>
                    se suma a las marcas por ciudad
                  </div>
                )}
              </td>
              {TIME_SLOTS.map((s) => {
                const on = isOn(city, s.key)
                return (
                  <td key={s.key} style={{ textAlign: 'center' }}>
                    <label
                      style={{
                        display: 'inline-flex',
                        padding: '4px 10px',
                        borderRadius: 6,
                        cursor: saving ? 'wait' : 'pointer',
                        background: on ? '#fee2e2' : 'transparent',
                        border: on ? '1px solid #fca5a5' : '1px solid var(--color-border)',
                      }}
                      title={on ? 'Con surge — click para quitar' : 'Sin surge — click para marcar'}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={saving}
                        onChange={() => toggle(city, s.key)}
                        style={{ cursor: 'inherit' }}
                      />
                      {on && <span style={{ marginLeft: 6, fontSize: 11 }}>⚡</span>}
                    </label>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
