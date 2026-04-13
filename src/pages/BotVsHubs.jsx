/**
 * BotVsHubs.jsx
 *
 * Compara precio efectivo promedio y número de datapoints
 * entre datos ingresados por hubs (manual) y datos del bot,
 * agrupados por ciudad / categoría / competidor.
 *
 * Requiere la función RPC get_bot_vs_hubs_summary() en Supabase
 * (supabase/20_bot_vs_hubs_rpc.sql).
 */

import { useState, useEffect, useMemo } from 'react'
import { sb } from '../lib/supabase'
import { useI18n } from '../context/LanguageContext'

const CITY_TABS = [
  { db: 'Lima',     label: 'Lima' },
  { db: 'Trujillo', label: 'Trujillo' },
  { db: 'Arequipa', label: 'Arequipa' },
  { db: 'Airport',  label: 'Aeropuerto' },
  { db: 'Corp',     label: 'Corp' },
  { db: null,       label: 'Todas' },
]

function fmt(val) {
  if (val === null || val === undefined) return '—'
  return `S/ ${parseFloat(val).toFixed(2)}`
}

function diffPct(hub, bot) {
  if (hub == null || bot == null || parseFloat(hub) === 0) return null
  return ((parseFloat(bot) / parseFloat(hub)) - 1) * 100
}

export default function BotVsHubs() {
  const { t } = useI18n()
  const [data,    setData]    = useState([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)
  const [city,    setCity]    = useState('Lima')
  const [catFilter,  setCatFilter]  = useState('')
  const [compFilter, setCompFilter] = useState('')

  useEffect(() => {
    async function load() {
      setLoading(true)
      setError(null)
      try {
        const { data: rows, error: e } = await sb.rpc('get_bot_vs_hubs_summary', {
          p_country: 'Peru',
        })
        if (e) throw e
        setData(rows || [])
      } catch (e) {
        setError(e.message)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  // Filtrar por ciudad activa
  const cityData = useMemo(() =>
    data.filter(r => city === null || r.city === city),
  [data, city])

  // Categorías y competidores disponibles para el filtro
  const categories  = useMemo(() => [...new Set(cityData.map(r => r.category))].sort(),  [cityData])
  const competitors = useMemo(() => [...new Set(cityData.map(r => r.competition_name))].sort(), [cityData])

  // Agrupar por ciudad+categoría+competidor → hub / bot side by side
  const grouped = useMemo(() => {
    const map = {}
    for (const r of cityData) {
      if (catFilter  && r.category         !== catFilter)  continue
      if (compFilter && r.competition_name !== compFilter) continue

      const key = `${r.city}||${r.category}||${r.competition_name}`
      if (!map[key]) {
        map[key] = {
          city:       r.city,
          category:   r.category,
          competitor: r.competition_name,
          hub: null,
          bot: null,
        }
      }
      if (r.data_source === 'manual') map[key].hub = r
      if (r.data_source === 'bot')    map[key].bot = r
    }
    return Object.values(map).sort(
      (a, b) => a.city.localeCompare(b.city) || a.category.localeCompare(b.category) || a.competitor.localeCompare(b.competitor)
    )
  }, [cityData, catFilter, compFilter])

  // Totales de resumen
  const totals = useMemo(() => ({
    hubObs: grouped.reduce((s, r) => s + (parseInt(r.hub?.obs_count) || 0), 0),
    botObs: grouped.reduce((s, r) => s + (parseInt(r.bot?.obs_count) || 0), 0),
    rows:   grouped.length,
  }), [grouped])

  return (
    <div style={{ padding: '16px 20px' }}>
      <h1 style={{ fontSize: 18, fontWeight: 800, marginBottom: 16, color: 'var(--color-text)', letterSpacing: '-0.3px' }}>
        Bot vs Hubs — Comparativa de precios
      </h1>

      {/* City tabs */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '2px solid var(--color-border)', marginBottom: 16 }}>
        {CITY_TABS.map(t => (
          <button
            key={String(t.db)}
            onClick={() => { setCity(t.db); setCatFilter(''); setCompFilter('') }}
            style={{
              padding: '8px 16px', border: 'none', background: 'transparent',
              borderBottom: city === t.db ? '2px solid var(--color-yango)' : '2px solid transparent',
              color: city === t.db ? 'var(--color-yango)' : 'var(--color-muted)',
              fontWeight: city === t.db ? 700 : 500,
              fontSize: 13, cursor: 'pointer', marginBottom: -2,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-muted)', textTransform: 'uppercase' }}>{t('filter.category')}</label>
          <select value={catFilter} onChange={e => setCatFilter(e.target.value)}
            style={{ padding: '5px 8px', border: '1.5px solid var(--color-border)', borderRadius: 4, fontSize: 12 }}>
            <option value="">{t('access.all')}</option>
            {categories.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-muted)', textTransform: 'uppercase' }}>Competidor</label>
          <select value={compFilter} onChange={e => setCompFilter(e.target.value)}
            style={{ padding: '5px 8px', border: '1.5px solid var(--color-border)', borderRadius: 4, fontSize: 12 }}>
            <option value="">Todos</option>
            {competitors.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        {(catFilter || compFilter) && (
          <button onClick={() => { setCatFilter(''); setCompFilter('') }}
            style={{ fontSize: 12, padding: '5px 10px', border: '1px solid var(--color-border)', borderRadius: 4, background: 'transparent', cursor: 'pointer', color: 'var(--color-muted)' }}>
            ✕ Limpiar
          </button>
        )}
      </div>

      {error && (
        <div style={{ padding: 14, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, color: '#991b1b', fontSize: 13, marginBottom: 16 }}>
          ⚠ {error}
          {error.includes('does not exist') && (
            <div style={{ marginTop: 8, fontSize: 12 }}>
              Ejecuta <code>supabase/20_bot_vs_hubs_rpc.sql</code> en tu Supabase para activar esta funcionalidad.
            </div>
          )}
        </div>
      )}

      {loading && <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-muted)' }}>{t('app.loading')}</div>}

      {!loading && !error && (
        <>
          {/* Resumen */}
          <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
            <div style={{ background: '#dcfce7', border: '1px solid #86efac', borderRadius: 8, padding: '10px 18px', fontSize: 13 }}>
              <span style={{ fontWeight: 700, color: '#166534' }}>Hubs: </span>
              <span style={{ color: '#166534' }}>{totals.hubObs.toLocaleString()} observaciones</span>
            </div>
            <div style={{ background: '#dbeafe', border: '1px solid #93c5fd', borderRadius: 8, padding: '10px 18px', fontSize: 13 }}>
              <span style={{ fontWeight: 700, color: '#1e40af' }}>Bot: </span>
              <span style={{ color: '#1e40af' }}>{totals.botObs.toLocaleString()} observaciones</span>
            </div>
            <div style={{ background: 'var(--color-panel)', border: '1px solid var(--color-border)', borderRadius: 8, padding: '10px 18px', fontSize: 13, color: 'var(--color-muted)' }}>
              {totals.rows} combinaciones ciudad/categoría/competidor
            </div>
          </div>

          {grouped.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-muted)', fontSize: 13 }}>
              Sin datos para los filtros seleccionados.
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr>
                    <th rowSpan={2} style={thStyle({ textAlign: 'left' })}>Ciudad</th>
                    <th rowSpan={2} style={thStyle({ textAlign: 'left' })}>Categoría</th>
                    <th rowSpan={2} style={thStyle({ textAlign: 'left' })}>Competidor</th>
                    <th colSpan={2} style={thStyle({ background: '#dcfce7', color: '#166534', borderBottom: 'none' })}>
                      🟢 Hubs (manual)
                    </th>
                    <th colSpan={2} style={thStyle({ background: '#dbeafe', color: '#1e40af', borderBottom: 'none' })}>
                      🔵 Bot
                    </th>
                    <th rowSpan={2} style={thStyle()}>Bot vs Hub %</th>
                  </tr>
                  <tr>
                    <th style={thStyle({ background: '#f0fdf4', color: '#166534', fontSize: 10 })}>Obs.</th>
                    <th style={thStyle({ background: '#f0fdf4', color: '#166534', fontSize: 10 })}>Avg precio</th>
                    <th style={thStyle({ background: '#eff6ff', color: '#1e40af', fontSize: 10 })}>Obs.</th>
                    <th style={thStyle({ background: '#eff6ff', color: '#1e40af', fontSize: 10 })}>Avg precio</th>
                  </tr>
                </thead>
                <tbody>
                  {grouped.map((r, i) => {
                    const pct = diffPct(r.hub?.avg_effective, r.bot?.avg_effective)
                    const pctColor = pct === null ? '#9ca3af' : pct > 5 ? '#166534' : pct < -5 ? '#991b1b' : '#92400e'
                    return (
                      <tr key={i} style={{ borderBottom: '1px solid #f1f5f9' }}>
                        <td style={{ padding: '5px 10px', fontWeight: 600 }}>{r.city}</td>
                        <td style={{ padding: '5px 10px' }}>{r.category}</td>
                        <td style={{ padding: '5px 10px' }}>{r.competitor}</td>
                        <td style={{ padding: '5px 10px', textAlign: 'right', background: '#f0fdf4', color: '#374151' }}>
                          {r.hub ? r.hub.obs_count.toLocaleString() : '—'}
                        </td>
                        <td style={{ padding: '5px 10px', textAlign: 'right', background: '#f0fdf4', fontWeight: r.hub ? 600 : 400 }}>
                          {r.hub ? fmt(r.hub.avg_effective) : '—'}
                        </td>
                        <td style={{ padding: '5px 10px', textAlign: 'right', background: '#eff6ff', color: '#374151' }}>
                          {r.bot ? r.bot.obs_count.toLocaleString() : '—'}
                        </td>
                        <td style={{ padding: '5px 10px', textAlign: 'right', background: '#eff6ff', fontWeight: r.bot ? 600 : 400 }}>
                          {r.bot ? fmt(r.bot.avg_effective) : '—'}
                        </td>
                        <td style={{ padding: '5px 10px', textAlign: 'right', fontWeight: 700, color: pctColor }}>
                          {pct === null ? '—' : `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          <p style={{ marginTop: 12, fontSize: 11, color: 'var(--color-muted)' }}>
            * Precio efectivo: para InDrive con bids = promedio de bids; InDrive sin bids = precio recomendado; otros = precio con descuento si existe, sino sin descuento.
            <br />
            * Bot vs Hub %: diferencia porcentual del precio promedio del bot respecto al de hubs. Positivo = bot más caro, negativo = bot más barato.
          </p>
        </>
      )}
    </div>
  )
}

function thStyle(extra = {}) {
  return {
    padding: '6px 10px',
    background: '#f3f4f6',
    border: '1px solid #e5e7eb',
    fontSize: 10,
    fontWeight: 700,
    textTransform: 'uppercase',
    textAlign: 'right',
    ...extra,
  }
}
