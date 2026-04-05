import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  LineChart, Line, XAxis, YAxis, Tooltip as RechartTooltip,
  Legend, ResponsiveContainer, CartesianGrid,
} from 'recharts'
import { sb }                      from '../lib/supabase'
import { useAuth }                 from '../lib/auth'
import { COMPETITOR_COLORS }       from '../lib/constants'
import { useCompetitorCommissions } from '../hooks/useCompetitorCommissions'
import { useCompetitorBonuses }     from '../hooks/useCompetitorBonuses'
import { useEarningsScenarios }     from '../hooks/useEarningsScenarios'
import '../styles/driver-earnings.css'

// ── Mappings ───────────────────────────────────────────────────────────────
const UI_CITIES = ['Lima', 'Trujillo', 'Arequipa', 'Aeropuerto', 'Corp']
const DB_CITY_MAP = {
  Lima: 'Lima', Trujillo: 'Trujillo', Arequipa: 'Arequipa',
  Aeropuerto: 'Airport', Corp: 'Corp',
}
const CATEGORIES_BY_DB_CITY = {
  Lima:     ['Economy', 'Comfort', 'Comfort+/Premier', 'TukTuk', 'XL'],
  Trujillo: ['Economy', 'Comfort/Comfort+'],
  Arequipa: ['Economy', 'Comfort/Comfort+'],
  Airport:  ['Economy', 'Comfort', 'Comfort+/Premier'],
  Corp:     ['Corp'],
}
const UI_CAT_TO_DB = {
  'Economy': 'Economy', 'Comfort': 'Comfort', 'Comfort+/Premier': 'Premier',
  'Comfort/Comfort+': 'Comfort', 'TukTuk': 'TukTuk', 'XL': 'XL', 'Corp': 'Corp',
}

// ── ISO week helpers ────────────────────────────────────────────────────────
function getISOYearWeek(date = new Date()) {
  const d   = new Date(date)
  const day = d.getDay() || 7
  d.setDate(d.getDate() + 4 - day)
  const jan1 = new Date(d.getFullYear(), 0, 1)
  const week = Math.ceil(((d - jan1) / 86400000 + 1) / 7)
  return { year: d.getFullYear(), week }
}

function formatWeekLabel(year, week) {
  return `Sem ${week} / ${year}`
}

// ── Currency formatter ──────────────────────────────────────────────────────
function fmt(n) {
  if (n == null || isNaN(n)) return '—'
  return `S/ ${n.toFixed(2)}`
}

// ── Main component ──────────────────────────────────────────────────────────
export default function DriverEarnings() {
  const { session } = useAuth()
  const userEmail   = session?.user?.email || ''

  const [uiCity,     setUiCity]     = useState('Lima')
  const [uiCat,      setUiCat]      = useState('Economy')
  const [refYear,    setRefYear]    = useState(() => getISOYearWeek().year)
  const [refWeek,    setRefWeek]    = useState(() => getISOYearWeek().week)
  const [hoursPerWeek, setHoursPerWeek] = useState(40)
  const [tripScale,  setTripScale]  = useState([10, 20, 30, 40, 50])
  const [notes,      setNotes]      = useState('')
  const [saving,     setSaving]     = useState(false)
  const [saveMsg,    setSaveMsg]    = useState(null)
  const [showBonuses,  setShowBonuses]  = useState(false)
  const [showHistory,  setShowHistory]  = useState(false)

  // Loaded from DB
  const [avgPrices,    setAvgPrices]    = useState({}) // comp → {avg, count}
  const [priceEdits,   setPriceEdits]   = useState({}) // comp → overridden value
  const [loadingPrices, setLoadingPrices] = useState(false)

  const dbCity     = DB_CITY_MAP[uiCity]
  const dbCat      = UI_CAT_TO_DB[uiCat] || uiCat
  const categories = CATEGORIES_BY_DB_CITY[dbCity] || []

  const { commissions, allRows: commRows } = useCompetitorCommissions(dbCity)
  const { bonuses }                        = useCompetitorBonuses(dbCity)
  const { scenarios, loading: loadingHist, saveScenario, deleteScenario } =
    useEarningsScenarios(dbCity, dbCat)

  // ── Load avg prices ────────────────────────────────────────────────────
  const loadPrices = useCallback(async () => {
    setLoadingPrices(true)
    setPriceEdits({})
    const { data } = await sb
      .from('pricing_observations')
      .select('competition_name, price_without_discount')
      .eq('city', dbCity)
      .eq('category', dbCat)
      .eq('year',  refYear)
      .eq('week',  refWeek)
      .not('price_without_discount', 'is', null)
    const grouped = {}
    for (const row of (data || [])) {
      const comp = row.competition_name
      if (!grouped[comp]) grouped[comp] = { sum: 0, count: 0 }
      grouped[comp].sum   += parseFloat(row.price_without_discount)
      grouped[comp].count += 1
    }
    const result = {}
    for (const [comp, { sum, count }] of Object.entries(grouped)) {
      result[comp] = { avg: sum / count, count }
    }
    setAvgPrices(result)
    setLoadingPrices(false)
  }, [dbCity, dbCat, refYear, refWeek])

  useEffect(() => { loadPrices() }, [loadPrices])

  // Reset category when city changes
  useEffect(() => {
    const cats = CATEGORIES_BY_DB_CITY[DB_CITY_MAP[uiCity]] || []
    setUiCat(cats[0] || 'Economy')
  }, [uiCity])

  // ── Effective price per competitor ─────────────────────────────────────
  const effectivePrices = useMemo(() => {
    const result = {}
    for (const [comp, data] of Object.entries(avgPrices)) {
      result[comp] = {
        price: priceEdits[comp] !== undefined
          ? parseFloat(priceEdits[comp])
          : data.avg,
        count:   data.count,
        edited:  priceEdits[comp] !== undefined,
      }
    }
    return result
  }, [avgPrices, priceEdits])

  // ── Competitors to show (those with data OR configured commissions) ─────
  const competitors = useMemo(() => {
    const fromData  = Object.keys(effectivePrices)
    const fromComms = commRows.filter(r => !r.city || r.city === dbCity).map(r => r.competitor_name)
    const all = [...new Set([...fromData, ...fromComms])]
    return all.sort()
  }, [effectivePrices, commRows, dbCity])

  // ── Calculation ────────────────────────────────────────────────────────
  function calcCell(comp, n) {
    const priceData = effectivePrices[comp]
    if (!priceData || isNaN(priceData.price)) return null
    const commPct   = commissions[comp] ?? 20
    const netRides  = priceData.price * n * (1 - commPct / 100)

    const compBonuses = bonuses[comp] || []
    let totalBonus = 0
    const appliedBonuses = []
    for (const b of compBonuses) {
      if (b.bonus_type === 'viajes' && n >= b.threshold) {
        totalBonus += b.bonus_amount
        appliedBonuses.push(b)
      } else if (b.bonus_type === 'horas' && hoursPerWeek >= b.threshold) {
        totalBonus += b.bonus_amount
        appliedBonuses.push(b)
      }
      // zona: informational only
    }
    return {
      netRides,
      totalBonus,
      total: netRides + totalBonus,
      commPct,
      pricePerTrip: priceData.price,
      appliedBonuses,
    }
  }

  // ── Chart data ─────────────────────────────────────────────────────────
  const chartData = useMemo(() => {
    const sortedScale = [...tripScale].sort((a, b) => a - b)
    return sortedScale.map(n => {
      const point = { n }
      for (const comp of competitors) {
        const cell = calcCell(comp, n)
        point[comp] = cell ? parseFloat(cell.total.toFixed(2)) : null
      }
      return point
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripScale, competitors, effectivePrices, commissions, bonuses, hoursPerWeek])

  // ── Trip scale management ──────────────────────────────────────────────
  function updateScale(i, val) {
    const n = parseInt(val, 10)
    if (isNaN(n)) return
    setTripScale(prev => {
      const next = [...prev]
      next[i] = n
      return next
    })
  }

  function addScalePoint() {
    if (tripScale.length >= 8) return
    const max = Math.max(...tripScale, 0)
    setTripScale(prev => [...prev, max + 10])
  }

  function removeScalePoint(i) {
    if (tripScale.length <= 1) return
    setTripScale(prev => prev.filter((_, j) => j !== i))
  }

  // ── Save scenario ──────────────────────────────────────────────────────
  async function handleSave() {
    if (!competitors.length) {
      setSaveMsg({ type: 'err', text: 'No hay datos de precios para guardar.' }); return
    }
    setSaving(true); setSaveMsg(null)

    const resultsSnapshot = {}
    for (const comp of competitors) {
      resultsSnapshot[comp] = {}
      for (const n of tripScale) {
        const cell = calcCell(comp, n)
        resultsSnapshot[comp][n] = cell ? parseFloat(cell.total.toFixed(2)) : null
      }
    }

    const payload = {
      city:          dbCity,
      category:      dbCat,
      ref_year:      refYear,
      ref_week:      refWeek,
      trip_scale:    tripScale,
      hours_per_week: hoursPerWeek,
      avg_prices:    Object.fromEntries(competitors.map(c => [c, effectivePrices[c]?.price ?? null])),
      commissions:   Object.fromEntries(competitors.map(c => [c, commissions[c] ?? null])),
      bonuses:       competitors.flatMap(c => (bonuses[c] || []).map(b => ({
        competitor: c, type: b.bonus_type, threshold: b.threshold,
        amount: b.bonus_amount, description: b.description,
      }))),
      results:       resultsSnapshot,
      notes:         notes || null,
      user_email:    userEmail,
    }

    const ok = await saveScenario(payload)
    if (ok) {
      setSaveMsg({ type: 'ok', text: '✓ Escenario guardado.' })
      setNotes('')
    } else {
      setSaveMsg({ type: 'err', text: 'Error al guardar.' })
    }
    setSaving(false)
  }

  // ── Sorted trip scale for display ─────────────────────────────────────
  const sortedScale = [...tripScale].sort((a, b) => a - b)

  const isYango = (comp) => comp.startsWith('Yango') || comp.startsWith('yango')

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="earn-page">
      <h1>Comparador de Ganancias</h1>
      <p className="earn-page__desc">
        Estima la ganancia semanal neta del conductor en cada app según los precios del CI.
      </p>

      {/* ── Params ── */}
      <div className="earn-panel">
        <div className="earn-panel__header">
          <span className="earn-panel__title">Parámetros</span>
        </div>
        <div className="earn-panel__body">
          {/* City tabs */}
          <div className="earn-city-tabs">
            {UI_CITIES.map(c => (
              <button
                key={c}
                className={`earn-city-tab${uiCity === c ? ' active' : ''}`}
                onClick={() => setUiCity(c)}
              >
                {c}
              </button>
            ))}
          </div>

          <div className="earn-controls">
            {/* Category */}
            <label className="earn-ctrl">
              <span className="earn-ctrl__label">Categoría</span>
              <select value={uiCat} onChange={e => setUiCat(e.target.value)}>
                {categories.map(c => <option key={c}>{c}</option>)}
              </select>
            </label>

            {/* Week reference */}
            <label className="earn-ctrl">
              <span className="earn-ctrl__label">Año</span>
              <input
                type="number"
                value={refYear}
                min="2020" max="2030"
                style={{ width: 72 }}
                onChange={e => setRefYear(Number(e.target.value))}
              />
            </label>

            <label className="earn-ctrl">
              <span className="earn-ctrl__label">Semana ISO</span>
              <input
                type="number"
                value={refWeek}
                min="1" max="53"
                style={{ width: 62 }}
                onChange={e => setRefWeek(Number(e.target.value))}
              />
            </label>

            {/* Hours/week */}
            <label className="earn-ctrl">
              <span className="earn-ctrl__label">Horas/semana</span>
              <input
                type="number"
                value={hoursPerWeek}
                min="1" max="80"
                style={{ width: 66 }}
                onChange={e => setHoursPerWeek(Number(e.target.value))}
              />
            </label>
          </div>

          {/* Scale chips */}
          <div style={{ marginTop: 12 }}>
            <div className="earn-scale">
              <span className="earn-scale__label">Escala de viajes/semana</span>
              {tripScale.map((n, i) => (
                <div key={i} className="earn-chip">
                  <input
                    type="number"
                    value={n}
                    min="1"
                    onChange={e => updateScale(i, e.target.value)}
                  />
                  {tripScale.length > 1 && (
                    <button className="earn-chip__remove" onClick={() => removeScalePoint(i)}>✕</button>
                  )}
                </div>
              ))}
              <button
                className="earn-chip__add"
                onClick={addScalePoint}
                disabled={tripScale.length >= 8}
              >
                + Agregar
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ── Reference prices ── */}
      <div className="earn-panel">
        <div className="earn-panel__header">
          <span className="earn-panel__title">
            Precios de referencia — {uiCity} · {uiCat} · {formatWeekLabel(refYear, refWeek)}
          </span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          {loadingPrices ? (
            <div className="earn-no-data">Cargando precios…</div>
          ) : Object.keys(avgPrices).length === 0 ? (
            <div className="earn-no-data">
              No hay datos CI para <strong>{uiCity} · {uiCat} · {formatWeekLabel(refYear, refWeek)}</strong>.
              Los precios editables quedan en blanco.
            </div>
          ) : (
            <table className="earn-ref-table">
              <thead>
                <tr>
                  <th>Competidor</th>
                  <th>Precio promedio / viaje</th>
                  <th># Observaciones</th>
                  <th>Comisión %</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(avgPrices).map(([comp, { avg, count }]) => (
                  <tr key={comp}>
                    <td><strong>{comp}</strong></td>
                    <td>
                      <input
                        type="number"
                        className={`earn-ref-input${priceEdits[comp] !== undefined ? ' earn-ref-input--edited' : ''}`}
                        value={priceEdits[comp] !== undefined ? priceEdits[comp] : avg.toFixed(2)}
                        min="0"
                        step="0.01"
                        onChange={e => setPriceEdits(prev => ({ ...prev, [comp]: e.target.value }))}
                      />
                    </td>
                    <td><span className="earn-ref-count">{count} obs.</span></td>
                    <td><span className="earn-ref-count">{commissions[comp] ?? '—'} %</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* ── Results ── */}
      {competitors.length > 0 && (
        <div className="earn-panel">
          <div className="earn-panel__header">
            <span className="earn-panel__title">Ganancia semanal neta (S/)</span>
          </div>
          <div className="earn-panel__body">
            {/* Matrix */}
            <div className="earn-matrix-wrap">
              <table className="earn-matrix">
                <thead>
                  <tr>
                    <th>App</th>
                    {sortedScale.map(n => (
                      <th key={n}>{n} viajes</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {competitors.map(comp => (
                    <tr key={comp} className={isYango(comp) ? 'earn-row--yango' : ''}>
                      <td>{comp}</td>
                      {sortedScale.map(n => {
                        const cell = calcCell(comp, n)
                        if (!cell) return <td key={n} className="earn-cell--empty">—</td>
                        return (
                          <td key={n}>
                            <div className="earn-cell-wrap">
                              <div className="earn-cell">
                                <span className="earn-cell__amount">{fmt(cell.total)}</span>
                                {cell.totalBonus > 0 && (
                                  <span className="earn-cell__bonus" title="Incluye bono">✦</span>
                                )}
                              </div>
                              {/* Tooltip */}
                              <div className="earn-tooltip">
                                <div className="earn-tooltip__row">
                                  <span className="earn-tooltip__label">Precio/viaje</span>
                                  <span className="earn-tooltip__val">{fmt(cell.pricePerTrip)}</span>
                                </div>
                                <div className="earn-tooltip__row">
                                  <span className="earn-tooltip__label">× {n} viajes</span>
                                  <span className="earn-tooltip__val">{fmt(cell.pricePerTrip * n)}</span>
                                </div>
                                <div className="earn-tooltip__row">
                                  <span className="earn-tooltip__label">− Comisión {cell.commPct}%</span>
                                  <span className="earn-tooltip__val">− {fmt(cell.pricePerTrip * n * cell.commPct / 100)}</span>
                                </div>
                                {cell.totalBonus > 0 && (
                                  <div className="earn-tooltip__row">
                                    <span className="earn-tooltip__label">+ Bono</span>
                                    <span className="earn-tooltip__val">+ {fmt(cell.totalBonus)}</span>
                                  </div>
                                )}
                                <div className="earn-tooltip__row earn-tooltip__total">
                                  <span className="earn-tooltip__label">Total neto</span>
                                  <span className="earn-tooltip__val">{fmt(cell.total)}</span>
                                </div>
                              </div>
                            </div>
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Chart */}
            <div className="earn-chart-wrap">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis
                    dataKey="n"
                    tickFormatter={v => `${v} viajes`}
                    tick={{ fontSize: 10 }}
                  />
                  <YAxis tickFormatter={v => `S/${v}`} tick={{ fontSize: 10 }} width={60} />
                  <RechartTooltip
                    formatter={(val, name) => [`S/ ${val?.toFixed(2) ?? '—'}`, name]}
                    labelFormatter={v => `${v} viajes/semana`}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  {competitors.map(comp => (
                    <Line
                      key={comp}
                      dataKey={comp}
                      stroke={COMPETITOR_COLORS[comp] || '#94a3b8'}
                      strokeWidth={isYango(comp) ? 2.5 : 1.5}
                      dot={{ r: 3 }}
                      connectNulls={false}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* Bonuses summary */}
            <div className="earn-bonuses-section">
              <button
                className="earn-bonuses-toggle"
                onClick={() => setShowBonuses(p => !p)}
              >
                {showBonuses ? '▲' : '▼'} Bonos aplicados
              </button>

              {showBonuses && (
                <div className="earn-bonuses-list">
                  {competitors.map(comp => {
                    const compBonuses = bonuses[comp] || []
                    if (!compBonuses.length) return null
                    return (
                      <div key={comp} style={{ marginBottom: 6 }}>
                        <strong style={{ fontSize: 12 }}>{comp}</strong>
                        <div style={{ marginTop: 4 }}>
                          {compBonuses.map((b, i) => (
                            <span
                              key={i}
                              className={`earn-bonus-chip earn-bonus-chip--${b.bonus_type}`}
                            >
                              {b.bonus_type === 'viajes' && `≥ ${b.threshold} viajes → +S/ ${b.bonus_amount}`}
                              {b.bonus_type === 'horas'  && `≥ ${b.threshold} h/sem → +S/ ${b.bonus_amount}`}
                              {b.bonus_type === 'zona'   && `Zona: +S/ ${b.bonus_amount} (informativo)`}
                              {b.description && ` · ${b.description}`}
                            </span>
                          ))}
                        </div>
                      </div>
                    )
                  })}
                  {competitors.every(c => !(bonuses[c] || []).length) && (
                    <span style={{ fontSize: 12, color: 'var(--color-muted)' }}>
                      No hay bonos configurados. Agrega bonos en Config → Bonos.
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="earn-footer">
              <input
                className="earn-notes-input"
                type="text"
                placeholder="Notas del escenario (opcional)…"
                value={notes}
                onChange={e => setNotes(e.target.value)}
              />
              <button className="earn-btn-save" onClick={handleSave} disabled={saving}>
                {saving ? 'Guardando…' : '💾 Guardar escenario'}
              </button>
              {saveMsg && (
                <span className={saveMsg.type === 'ok' ? 'earn-msg--ok' : 'earn-msg--err'}>
                  {saveMsg.text}
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── History ── */}
      <div>
        <button
          className="earn-history-toggle"
          onClick={() => setShowHistory(p => !p)}
        >
          {showHistory ? '▲' : '▼'} Historial de escenarios ({scenarios.length})
        </button>

        {showHistory && (
          loadingHist ? (
            <div style={{ fontSize: 12, color: 'var(--color-muted)', padding: '10px 0' }}>
              Cargando…
            </div>
          ) : scenarios.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--color-muted)', padding: '10px 0' }}>
              No hay escenarios guardados.
            </div>
          ) : (
            <div style={{ overflowX: 'auto', marginTop: 10 }}>
              <table className="earn-history-table">
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Semana ref.</th>
                    <th>Escala</th>
                    <th>Notas</th>
                    <th>Usuario</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {scenarios.map(s => (
                    <tr key={s.id}>
                      <td>{new Date(s.created_at).toLocaleDateString('es-PE')}</td>
                      <td>{formatWeekLabel(s.ref_year, s.ref_week)}</td>
                      <td>{(s.trip_scale || []).join(', ')}</td>
                      <td>{s.notes || '—'}</td>
                      <td style={{ color: 'var(--color-muted)' }}>{s.user_email || '—'}</td>
                      <td style={{ display: 'flex', gap: 4 }}>
                        <button
                          className="earn-btn-del"
                          onClick={() => deleteScenario(s.id)}
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </div>
    </div>
  )
}
