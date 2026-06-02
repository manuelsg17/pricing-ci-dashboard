import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip as RechartTooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
  LabelList,
} from 'recharts'
import { sb } from '../lib/supabase'
import { COMPETITOR_COLORS, getCompetitors, resolveDbParams } from '../lib/constants'
import { normalizeCompetitorName } from '../lib/normalize'
import { getISOYearWeek } from '../lib/dateUtils'
import { useCompetitorCommissions } from '../hooks/useCompetitorCommissions'
import { useCompetitorBonuses } from '../hooks/useCompetitorBonuses'
import { useCountry } from '../context/CountryContext'
import { useI18n } from '../context/LanguageContext'

// ── Helpers ─────────────────────────────────────────────────────────────────
const isYango = (c) => c.startsWith('Yango') || c.startsWith('yango')

function formatWeekLabel(year, week) {
  return `Sem ${week} / ${year}`
}

// ── Página: Rentabilidad (Unit Economics por tier) ──────────────────────────
// Build 1: barras de ganancia neta por tier (todas las categorías a la vez),
// Yango vs competidores, con la ganancia encima de cada barra. Escala de viajes
// configurable (segmentos + slider) y selector por viaje / por semana.
// Reusa el motor de DriverEarnings (precios CI + competitor_commissions/bonuses).
// Las herramientas Yango (Mi Zona/Mi Casa/Mis Destinos/Flex) llegan en Build 2.
export default function Rentabilidad() {
  const { t } = useI18n()
  const { country, countryConfig, dbConfigs } = useCountry()
  const uiCities = countryConfig.cities
  const { currency } = countryConfig

  const [uiCity, setUiCity] = useState(uiCities[0] || 'Lima')
  const [refYear, setRefYear] = useState(() => getISOYearWeek().year)
  const [refWeek, setRefWeek] = useState(() => getISOYearWeek().week)
  const [hoursPerWeek, setHoursPerWeek] = useState(40)
  const [segments, setSegments] = useState([60, 90])
  const [liveTrips, setLiveTrips] = useState(70)
  const [metric, setMetric] = useState('trip') // 'trip' | 'week'

  // dbCategory -> { comp -> { avg, count } }
  const [pricesByCat, setPricesByCat] = useState({})
  const [loading, setLoading] = useState(false)

  // Reset ciudad solo si la actual ya no existe en el país. Idempotente: así
  // un re-fetch de config (mount o edición de otro usuario vía realtime) que
  // cambia la identidad de countryConfig NO pisa la ciudad que el usuario eligió.
  useEffect(() => {
    if (!countryConfig.cities.includes(uiCity)) {
      setUiCity(countryConfig.cities[0] || 'Lima')
    }
  }, [country, countryConfig, uiCity])

  // Categorías UI de la ciudad + mapeo a (dbCity, dbCategory)
  const categories = useMemo(
    () => countryConfig.categoriesByCity[uiCity] || [],
    [countryConfig, uiCity]
  )
  const catMap = useMemo(
    () =>
      categories.map((uiCat) => {
        const { dbCity, dbCategory } = resolveDbParams(uiCity, uiCat, null, country, dbConfigs)
        return { uiCat, dbCity, dbCategory }
      }),
    [categories, uiCity, country, dbConfigs]
  )
  const dbCity = catMap[0]?.dbCity || uiCity
  const dbCategories = useMemo(() => [...new Set(catMap.map((c) => c.dbCategory))], [catMap])

  const { commissions, allRows: commRows } = useCompetitorCommissions(dbCity, country)
  const { bonuses } = useCompetitorBonuses(dbCity, country)

  // ── Cargar precios de TODAS las categorías de la ciudad (1 query) ──────
  const loadPrices = useCallback(async () => {
    if (!dbCity || !dbCategories.length) {
      setPricesByCat({})
      return
    }
    setLoading(true)
    const { data } = await sb
      .from('pricing_observations')
      .select('competition_name, category, price_without_discount')
      .eq('country', country)
      .eq('city', dbCity)
      .eq('year', refYear)
      .eq('week', refWeek)
      .in('category', dbCategories)
      .not('price_without_discount', 'is', null)

    const grouped = {} // cat -> comp -> { sum, count }
    for (const row of data || []) {
      const comp =
        normalizeCompetitorName(row.competition_name, { city: dbCity }) || row.competition_name
      const cat = row.category
      if (!grouped[cat]) grouped[cat] = {}
      if (!grouped[cat][comp]) grouped[cat][comp] = { sum: 0, count: 0 }
      grouped[cat][comp].sum += parseFloat(row.price_without_discount)
      grouped[cat][comp].count += 1
    }
    const result = {}
    for (const [cat, comps] of Object.entries(grouped)) {
      result[cat] = {}
      for (const [comp, { sum, count }] of Object.entries(comps)) {
        result[cat][comp] = { avg: sum / count, count }
      }
    }
    setPricesByCat(result)
    setLoading(false)
  }, [country, dbCity, dbCategories, refYear, refWeek])

  useEffect(() => {
    loadPrices()
  }, [loadPrices])

  // ── Competidores a mostrar (catálogo + lo que haya en data/comisiones) ──
  const competitors = useMemo(() => {
    const set = new Set()
    for (const { uiCat } of catMap) {
      for (const c of getCompetitors(uiCity, uiCat, null, country, dbConfigs)) set.add(c)
    }
    for (const comps of Object.values(pricesByCat)) {
      for (const c of Object.keys(comps)) set.add(c)
    }
    for (const r of commRows) {
      if (!r.city || r.city === dbCity)
        set.add(normalizeCompetitorName(r.competitor_name, { city: r.city }) || r.competitor_name)
    }
    return [...set].sort((a, b) =>
      isYango(a) === isYango(b) ? a.localeCompare(b) : isYango(a) ? -1 : 1
    )
  }, [catMap, pricesByCat, commRows, uiCity, dbCity, country, dbConfigs])

  // Solo los que tienen data real en la ciudad seleccionada: el union de arriba
  // arrastra catálogos de otras dbCity (ej. Corp en Lima) que quedan siempre
  // vacíos e inflan leyenda + barras fantasma. Si no hay nada, cae al catálogo
  // completo para que la vista vacía siga mostrando el set esperado.
  const shownCompetitors = useMemo(() => {
    const withData = new Set()
    for (const comps of Object.values(pricesByCat))
      for (const c of Object.keys(comps)) withData.add(c)
    const filtered = competitors.filter((c) => withData.has(c))
    return filtered.length ? filtered : competitors
  }, [competitors, pricesByCat])

  // ── Selección de competidores (multiselect) ────────────────────────────
  // null = automático (Yango + los 3 rivales con más data). Cuando el usuario
  // toca un chip se vuelve una lista explícita. Se resetea a auto al cambiar
  // ciudad/país para recalcular el default del nuevo mercado.
  const [selectedComps, setSelectedComps] = useState(null)
  useEffect(() => {
    setSelectedComps(null)
  }, [uiCity, country])

  const compCounts = useMemo(() => {
    const counts = {}
    for (const comps of Object.values(pricesByCat))
      for (const [c, pd] of Object.entries(comps)) counts[c] = (counts[c] || 0) + pd.count
    return counts
  }, [pricesByCat])

  const defaultSelection = useMemo(() => {
    const yangos = shownCompetitors.filter(isYango)
    const others = shownCompetitors
      .filter((c) => !isYango(c))
      .sort((a, b) => (compCounts[b] || 0) - (compCounts[a] || 0))
      .slice(0, 3)
    return [...yangos, ...others]
  }, [shownCompetitors, compCounts])

  // Lo que realmente se grafica: respeta el orden de shownCompetitors (Yango
  // primero) y descarta lo que ya no tiene data tras un cambio de semana.
  const visibleCompetitors = useMemo(() => {
    const base = selectedComps ?? defaultSelection
    return shownCompetitors.filter((c) => base.includes(c))
  }, [selectedComps, defaultSelection, shownCompetitors])

  function toggleComp(c) {
    setSelectedComps((prev) => {
      const cur = prev ?? defaultSelection
      return cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c]
    })
  }

  // ── Cálculo de ganancia ─────────────────────────────────────────────────
  const bonusFor = useCallback(
    (comp, trips) => {
      let total = 0
      for (const b of bonuses[comp] || []) {
        if (b.bonus_type === 'viajes' && trips >= b.threshold) total += b.bonus_amount
        else if (b.bonus_type === 'horas' && hoursPerWeek >= b.threshold) total += b.bonus_amount
        // 'zona': informativo (se modela en Build 2 vía herramientas Yango)
      }
      return total
    },
    [bonuses, hoursPerWeek]
  )

  const netFor = useCallback(
    (dbCategory, comp, trips) => {
      const pd = pricesByCat[dbCategory]?.[comp]
      if (!pd || !trips || isNaN(pd.avg)) return null
      const comm = commissions[comp] ?? 20
      const week = pd.avg * trips * (1 - comm / 100) + bonusFor(comp, trips)
      return metric === 'trip' ? week / trips : week
    },
    [pricesByCat, commissions, bonusFor, metric]
  )

  // data para un valor de viajes: [{ tier, [comp]: value }]
  const chartDataFor = useCallback(
    (trips) =>
      catMap.map(({ uiCat, dbCategory }) => {
        const point = { tier: uiCat }
        for (const comp of visibleCompetitors) {
          const v = netFor(dbCategory, comp, trips)
          point[comp] = v != null ? Number(v.toFixed(2)) : null
        }
        return point
      }),
    [catMap, visibleCompetitors, netFor]
  )

  // paneles: un small-multiple por segmento + uno "en vivo" (slider)
  const panels = useMemo(() => {
    const segs = [...new Set(segments.filter((n) => n > 0))].sort((a, b) => a - b)
    return [
      ...segs.map((n) => ({ key: `seg-${n}`, trips: n, live: false })),
      { key: 'live', trips: liveTrips, live: true },
    ]
  }, [segments, liveTrips])

  // ── Manejo de segmentos ────────────────────────────────────────────────
  function updateSegment(i, val) {
    const n = parseInt(val, 10)
    setSegments((prev) => prev.map((x, j) => (j === i ? (isNaN(n) ? x : n) : x)))
  }
  function addSegment() {
    if (segments.length >= 5) return
    setSegments((prev) => [...prev, Math.max(...prev, 0) + 30])
  }
  function removeSegment(i) {
    if (segments.length <= 1) return
    setSegments((prev) => prev.filter((_, j) => j !== i))
  }

  const hasData = Object.keys(pricesByCat).length > 0
  const fmt = (n) =>
    n == null || isNaN(n) ? '—' : `${currency} ${n.toFixed(metric === 'trip' ? 2 : 0)}`

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="rent-page" style={{ padding: '16px 20px', maxWidth: 1400 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 2 }}>{t('rentabilidad.title')}</h1>
      <p style={{ color: 'var(--color-muted)', fontSize: 13, marginBottom: 16 }}>
        {t('rentabilidad.subtitle')}
      </p>

      {/* ── Parámetros ── */}
      <div className="rent-panel" style={panelStyle}>
        {/* Ciudades */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          {uiCities.map((c) => (
            <button key={c} onClick={() => setUiCity(c)} style={cityTabStyle(uiCity === c)}>
              {c}
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label={t('earnings.year')}>
            <input
              type="number"
              value={refYear}
              min="2020"
              max="2030"
              style={{ width: 76 }}
              onChange={(e) => {
                const v = Number(e.target.value)
                if (v) setRefYear(v)
              }}
            />
          </Field>
          <Field label={t('earnings.week')}>
            <input
              type="number"
              value={refWeek}
              min="1"
              max="53"
              style={{ width: 64 }}
              onChange={(e) => {
                const v = Number(e.target.value)
                if (v) setRefWeek(v)
              }}
            />
          </Field>
          <Field label={t('earnings.hours_per_week')}>
            <input
              type="number"
              value={hoursPerWeek}
              min="1"
              max="80"
              style={{ width: 68 }}
              onChange={(e) => {
                const v = Number(e.target.value)
                if (v) setHoursPerWeek(v)
              }}
            />
          </Field>

          {/* Toggle por viaje / por semana */}
          <Field label={t('rentabilidad.metric')}>
            <div
              style={{
                display: 'inline-flex',
                border: '1px solid var(--color-border, #e2e8f0)',
                borderRadius: 6,
                overflow: 'hidden',
              }}
            >
              <button onClick={() => setMetric('trip')} style={toggleStyle(metric === 'trip')}>
                {t('rentabilidad.per_trip')}
              </button>
              <button onClick={() => setMetric('week')} style={toggleStyle(metric === 'week')}>
                {t('rentabilidad.per_week')}
              </button>
            </div>
          </Field>
        </div>

        {/* Segmentos de viajes */}
        <div
          style={{ marginTop: 14, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}
        >
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-muted)' }}>
            {t('rentabilidad.segments')}
          </span>
          {segments.map((n, i) => (
            <div key={i} style={chipStyle}>
              <input
                type="number"
                value={n}
                min="1"
                style={{ width: 52, border: 'none', background: 'transparent' }}
                onChange={(e) => updateSegment(i, e.target.value)}
              />
              {segments.length > 1 && (
                <button onClick={() => removeSegment(i)} style={chipRemoveStyle}>
                  ✕
                </button>
              )}
            </div>
          ))}
          <button onClick={addSegment} disabled={segments.length >= 5} style={chipAddStyle}>
            + {t('rentabilidad.add_segment')}
          </button>
        </div>

        {/* Slider "en vivo" */}
        <div style={{ marginTop: 12, display: 'flex', gap: 12, alignItems: 'center' }}>
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--color-muted)',
              whiteSpace: 'nowrap',
            }}
          >
            {t('rentabilidad.live_trips')}
          </span>
          <input
            type="range"
            min="0"
            max="200"
            step="5"
            value={liveTrips}
            onChange={(e) => setLiveTrips(Number(e.target.value))}
            style={{ flex: 1, maxWidth: 420, accentColor: 'var(--color-yango, #E53935)' }}
          />
          <input
            type="number"
            min="0"
            max="400"
            value={liveTrips}
            style={{ width: 72 }}
            onChange={(e) => setLiveTrips(Number(e.target.value) || 0)}
          />
          <span style={{ fontSize: 12, color: 'var(--color-muted)' }}>viajes/sem</span>
        </div>

        {/* Selector de competidores — chips toggleables, label visible en cada barra */}
        {shownCompetitors.length > 0 && (
          <div
            style={{
              marginTop: 14,
              display: 'flex',
              gap: 6,
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-muted)' }}>
              {t('rentabilidad.competitors')}
            </span>
            {shownCompetitors.map((c) => {
              const active = visibleCompetitors.includes(c)
              const color = COMPETITOR_COLORS[c] || '#94a3b8'
              return (
                <button
                  key={c}
                  onClick={() => toggleComp(c)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    padding: '3px 9px',
                    borderRadius: 999,
                    fontSize: 12,
                    cursor: 'pointer',
                    border: '1px solid ' + (active ? color : 'var(--color-border, #e2e8f0)'),
                    background: active ? color : '#fff',
                    color: active ? '#fff' : 'var(--color-muted)',
                    fontWeight: active ? 600 : 400,
                    opacity: active ? 1 : 0.6,
                  }}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 999,
                      background: active ? '#fff' : color,
                      display: 'inline-block',
                    }}
                  />
                  {c}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* ── Gráficos (small multiples) ── */}
      {loading ? (
        <div style={emptyStyle}>{t('app.loading')}</div>
      ) : !hasData ? (
        <div style={emptyStyle}>
          {t('rentabilidad.no_data')}{' '}
          <strong>
            {uiCity} · {formatWeekLabel(refYear, refWeek)}
          </strong>
          .
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(440px, 1fr))',
            gap: 16,
          }}
        >
          {panels.map((p) => (
            <div
              key={p.key}
              className="rent-panel"
              style={{
                ...panelStyle,
                borderColor: p.live ? 'var(--color-yango, #E53935)' : undefined,
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
                {p.live ? `${t('rentabilidad.live_trips')}: ` : ''}
                {p.trips} {t('rentabilidad.trips_week')}
                <span style={{ fontWeight: 400, color: 'var(--color-muted)', marginLeft: 6 }}>
                  · {metric === 'trip' ? t('rentabilidad.per_trip') : t('rentabilidad.per_week')}
                </span>
              </div>
              <div style={{ width: '100%', height: 300 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={chartDataFor(p.trips)}
                    margin={{ top: 22, right: 8, left: 0, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="tier" tick={{ fontSize: 11 }} interval={0} />
                    <YAxis
                      tickFormatter={(v) => `${currency} ${v}`}
                      tick={{ fontSize: 10 }}
                      width={58}
                    />
                    <RechartTooltip
                      formatter={(val, name) => [fmt(val), name]}
                      labelFormatter={(l) => l}
                    />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    {visibleCompetitors.map((comp) => (
                      <Bar
                        key={comp}
                        dataKey={comp}
                        fill={COMPETITOR_COLORS[comp] || '#94a3b8'}
                        radius={[3, 3, 0, 0]}
                      >
                        <LabelList
                          dataKey={comp}
                          position="top"
                          formatter={(v) => (v != null ? v.toFixed(metric === 'trip' ? 1 : 0) : '')}
                          style={{
                            fontSize: 9,
                            fontWeight: isYango(comp) ? 700 : 400,
                            fill: COMPETITOR_COLORS[comp] || '#64748b',
                          }}
                        />
                      </Bar>
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Nota Build 2 ── */}
      <div
        style={{ marginTop: 16, fontSize: 12, color: 'var(--color-muted)', fontStyle: 'italic' }}
      >
        {t('rentabilidad.b2_note')}
      </div>
    </div>
  )
}

// ── Sub-componentes / estilos ───────────────────────────────────────────────
function Field({ label, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-muted)' }}>{label}</span>
      {children}
    </label>
  )
}

const panelStyle = {
  background: 'var(--color-panel, #fff)',
  border: '1px solid var(--color-border, #e2e8f0)',
  borderRadius: 8,
  padding: 14,
  marginBottom: 16,
}
const emptyStyle = {
  padding: '40px 16px',
  textAlign: 'center',
  color: 'var(--color-muted)',
  background: 'var(--color-panel, #fff)',
  border: '1px dashed var(--color-border, #e2e8f0)',
  borderRadius: 8,
}
const chipStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 2,
  border: '1px solid var(--color-border, #e2e8f0)',
  borderRadius: 6,
  padding: '2px 4px',
}
const chipRemoveStyle = {
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  color: '#94a3b8',
  fontSize: 11,
}
const chipAddStyle = {
  border: '1px dashed var(--color-border, #cbd5e1)',
  borderRadius: 6,
  padding: '4px 8px',
  background: 'transparent',
  cursor: 'pointer',
  fontSize: 12,
  color: 'var(--color-muted)',
}
function cityTabStyle(active) {
  return {
    padding: '5px 12px',
    borderRadius: 6,
    fontSize: 13,
    cursor: 'pointer',
    border:
      '1px solid ' + (active ? 'var(--color-yango, #E53935)' : 'var(--color-border, #e2e8f0)'),
    background: active ? 'var(--color-yango, #E53935)' : '#fff',
    color: active ? '#fff' : 'inherit',
    fontWeight: active ? 600 : 400,
  }
}
function toggleStyle(active) {
  return {
    padding: '5px 12px',
    fontSize: 12,
    cursor: 'pointer',
    border: 'none',
    background: active ? 'var(--color-yango, #E53935)' : '#fff',
    color: active ? '#fff' : 'var(--color-muted)',
    fontWeight: active ? 600 : 400,
  }
}
