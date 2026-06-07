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
import {
  COMPETITOR_COLORS,
  getCompetitors,
  resolveDbParams,
  getYangoDisplayName,
} from '../lib/constants'
import { normalizeCompetitorName } from '../lib/normalize'
import { getISOYearWeek } from '../lib/dateUtils'
import { useCompetitorCommissions } from '../hooks/useCompetitorCommissions'
import { useCompetitorBonuses } from '../hooks/useCompetitorBonuses'
import { useCountry } from '../context/CountryContext'
import { useI18n } from '../context/LanguageContext'
import {
  DEFAULT_TOOLS_STATE,
  YANGO_TOOLS,
  YANGO_PARTNER_PCT,
  MI_ZONA_MAX_PCT,
  yangoBaseCommission,
  yangoToolsExtra,
  miZonaCommissionForRatio,
  yangoScenarioCommission,
} from '../lib/yangoTools'
import { gmvInsideRatio, miZonaCommissionForSelection } from '../lib/limaZones'
import MiZonaMap from '../components/rentabilidad/MiZonaMap'

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
// Build 2: comisión de Yango apilable (base ciudad + partner + Mi Casa/Mis
// Destinos/Flex/Mi Zona, ver lib/yangoTools.js) + matriz E1/E4 + notas de fórmulas.
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
  const [tools, setTools] = useState(DEFAULT_TOOLS_STATE) // herramientas Yango

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

  // ── Comisión total de Yango = base ciudad + partner(3%) + herramientas ──────
  // Reemplaza el % plano del DB (Yango figura 20%): el modelo real es apilable.
  const yangoBasePct = yangoBaseCommission(dbCity)
  const isLima = dbCity === 'Lima'

  // Mi Zona: en Lima la cobertura sale del mapa (gmv_inside_ratio de las zonas
  // elegidas, mín. 2); en provincias del slider de respaldo.
  const miZonaRatio = useMemo(() => {
    if (!tools.mi_zona.on) return 1
    if (isLima)
      return tools.mi_zona.zones.length >= 2 ? (gmvInsideRatio(tools.mi_zona.zones) ?? 1) : 1
    return tools.mi_zona.ratio
  }, [tools.mi_zona, isLima])
  const miZonaPct = useMemo(() => {
    if (!tools.mi_zona.on) return 0
    if (isLima)
      return tools.mi_zona.zones.length >= 2 ? miZonaCommissionForSelection(tools.mi_zona.zones) : 0
    return miZonaCommissionForRatio(tools.mi_zona.ratio)
  }, [tools.mi_zona, isLima])

  const yangoExtraPct = useMemo(() => yangoToolsExtra(tools, miZonaPct), [tools, miZonaPct])
  const yangoCommission = yangoBasePct + YANGO_PARTNER_PCT + yangoExtraPct

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
    (comp, dbCategory, trips) => {
      let total = 0
      for (const b of bonuses[comp] || []) {
        if (b.category && b.category !== dbCategory) continue // bono de otra categoría
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
      // Yango: comisión apilable computada. Resto: % del DB.
      const comm = isYango(comp) ? yangoCommission : (commissions[comp] ?? 20)
      const week = pd.avg * trips * (1 - comm / 100) + bonusFor(comp, dbCategory, trips)
      return metric === 'trip' ? week / trips : week
    },
    [pricesByCat, commissions, bonusFor, metric, yangoCommission]
  )

  // Ganancia de Yango a una comisión arbitraria (para la matriz de escenarios).
  // La key de Yango varía por ciudad/categoría (ej. Corp usa 'YangoEconomy'),
  // así que la resolvemos con getYangoDisplayName en vez de hardcodear 'Yango'.
  const yangoNetAt = useCallback(
    (dbCategory, trips, commPct) => {
      const yangoKey = getYangoDisplayName(country, dbCity, dbCategory)
      const pd = pricesByCat[dbCategory]?.[yangoKey]
      if (!pd || !trips || isNaN(pd.avg)) return null
      const week = pd.avg * trips * (1 - commPct / 100) + bonusFor(yangoKey, dbCategory, trips)
      return metric === 'trip' ? week / trips : week
    },
    [pricesByCat, bonusFor, metric, country, dbCity]
  )

  // Clave de Yango para una categoría (Corp usa 'YangoEconomy', resto 'Yango').
  const yangoKeyFor = useCallback(
    (dbCategory) => getYangoDisplayName(country, dbCity, dbCategory),
    [country, dbCity]
  )

  // Ganancia POR VIAJE a n viajes (siempre per-trip, para el break-even).
  const netPerTrip = useCallback(
    (dbCategory, comp, n) => {
      const pd = pricesByCat[dbCategory]?.[comp]
      if (!pd || !n || isNaN(pd.avg)) return null
      const comm = isYango(comp) ? yangoCommission : (commissions[comp] ?? 20)
      return pd.avg * (1 - comm / 100) + bonusFor(comp, dbCategory, n) / n
    },
    [pricesByCat, commissions, bonusFor, yangoCommission]
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

  // Tier + competidor de referencia para la matriz E1/E4 (primer tier con data
  // de Yango; primer rival visible). Sin fallback a catMap[0]: si ningún tier
  // tiene Yango, refTier queda undefined y la matriz se oculta (guard abajo).
  const refTier = useMemo(
    () =>
      catMap.find(
        ({ dbCategory }) =>
          pricesByCat[dbCategory]?.[getYangoDisplayName(country, dbCity, dbCategory)]
      ),
    [catMap, pricesByCat, country, dbCity]
  )
  const refComp = useMemo(
    () => visibleCompetitors.find((c) => !isYango(c)) || shownCompetitors.find((c) => !isYango(c)),
    [visibleCompetitors, shownCompetitors]
  )

  // ── Análisis auto-generado (Build 3) ────────────────────────────────────
  const rivalCols = useMemo(
    () => visibleCompetitors.filter((c) => !isYango(c)),
    [visibleCompetitors]
  )

  // Yango vs cada rival por tier — delta en la métrica actual, a liveTrips.
  const tierComparison = useMemo(
    () =>
      catMap.map(({ uiCat, dbCategory }) => {
        const yNet = netFor(dbCategory, yangoKeyFor(dbCategory), liveTrips)
        const cells = rivalCols.map((comp) => {
          const cNet = netFor(dbCategory, comp, liveTrips)
          return { comp, cNet, delta: yNet != null && cNet != null ? yNet - cNet : null }
        })
        return { uiCat, yNet, cells }
      }),
    [catMap, rivalCols, netFor, liveTrips, yangoKeyFor]
  )
  const winSummary = useMemo(() => {
    let wins = 0
    let total = 0
    for (const row of tierComparison)
      for (const c of row.cells)
        if (c.delta != null) {
          total++
          if (c.delta >= 0) wins++
        }
    return { wins, total }
  }, [tierComparison])

  // Costo de cada herramienta Yango en el tier de referencia (en la métrica actual).
  const toolCosts = useMemo(() => {
    if (!refTier) return null
    const pd = pricesByCat[refTier.dbCategory]?.[yangoKeyFor(refTier.dbCategory)]
    if (!pd) return null
    const fare = pd.avg
    const cost = (pct) => (metric === 'trip' ? fare * (pct / 100) : fare * (pct / 100) * liveTrips)
    const items = [
      {
        key: 'mi_casa',
        label: YANGO_TOOLS.mi_casa.label,
        pct: YANGO_TOOLS.mi_casa.pct,
        active: tools.mi_casa,
      },
      {
        key: 'mis_destinos',
        label: YANGO_TOOLS.mis_destinos.label,
        pct: YANGO_TOOLS.mis_destinos.pct,
        active: tools.mis_destinos,
      },
      { key: 'flex', label: YANGO_TOOLS.flex.label, pct: YANGO_TOOLS.flex.pct, active: tools.flex },
      { key: 'mi_zona', label: 'Mi Zona', pct: miZonaPct, active: tools.mi_zona.on },
    ].map((it) => ({ ...it, cost: cost(it.pct) }))
    return { fare, items, totalPct: yangoExtraPct, totalCost: cost(yangoExtraPct) }
  }, [refTier, pricesByCat, metric, liveTrips, tools, miZonaPct, yangoExtraPct, yangoKeyFor])

  // Break-even: a cuántos viajes/sem Yango supera a cada rival (tier ref, per-trip).
  const breakEvens = useMemo(() => {
    if (!refTier) return []
    const yKey = yangoKeyFor(refTier.dbCategory)
    const MAXN = 200
    return rivalCols.map((comp) => {
      let startWin = null
      let flipN = null
      let points = 0
      for (let n = 1; n <= MAXN; n++) {
        const y = netPerTrip(refTier.dbCategory, yKey, n)
        const c = netPerTrip(refTier.dbCategory, comp, n)
        if (y == null || c == null) continue
        points++
        const win = y >= c
        if (startWin === null) startWin = win
        else if (flipN === null && win !== startWin) flipN = n
      }
      let type
      if (!points) type = 'nodata'
      else if (flipN === null) type = startWin ? 'always' : 'never'
      else type = startWin ? 'until' : 'from'
      // 'until': flipN es el primer n donde Yango YA pierde; el último n ganador
      // es flipN-1. 'from': flipN es el primer n ganador (inclusivo, correcto).
      return { comp, type, n: type === 'until' ? flipN - 1 : flipN }
    })
  }, [refTier, rivalCols, netPerTrip, yangoKeyFor])

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
    <div className="rent-page" style={{ padding: '16px 20px', maxWidth: 1820 }}>
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

      {/* ── Herramientas Yango (comisión apilable) ── */}
      <div className="rent-panel" style={panelStyle}>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 8,
            marginBottom: 10,
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 700 }}>{t('rentabilidad.yango_tools')}</span>
          <span style={{ fontSize: 13 }}>
            {t('rentabilidad.total_commission')}:{' '}
            <strong style={{ color: 'var(--color-yango, #E53935)', fontSize: 15 }}>
              {yangoCommission.toFixed(1)}%
            </strong>
            <span style={{ color: 'var(--color-muted)', marginLeft: 8, fontSize: 12 }}>
              = {yangoBasePct}% {t('rentabilidad.base_city')} + {YANGO_PARTNER_PCT}% partner
              {yangoExtraPct > 0
                ? ` + ${yangoExtraPct.toFixed(1)}% ${t('rentabilidad.tools_extra')}`
                : ''}
            </span>
          </span>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <ToolToggle
            active={tools.mi_casa}
            onClick={() => setTools((s) => ({ ...s, mi_casa: !s.mi_casa }))}
            label={`${YANGO_TOOLS.mi_casa.label} +${YANGO_TOOLS.mi_casa.pct}%`}
          />
          <ToolToggle
            active={tools.mis_destinos}
            onClick={() => setTools((s) => ({ ...s, mis_destinos: !s.mis_destinos }))}
            label={`${YANGO_TOOLS.mis_destinos.label} +${YANGO_TOOLS.mis_destinos.pct}%`}
          />
          <ToolToggle
            active={tools.flex}
            onClick={() => setTools((s) => ({ ...s, flex: !s.flex }))}
            label={`${YANGO_TOOLS.flex.label} +${YANGO_TOOLS.flex.pct}%`}
            sub={t('rentabilidad.temporary')}
          />
          <ToolToggle
            active={tools.mi_zona.on}
            onClick={() =>
              setTools((s) => ({ ...s, mi_zona: { ...s.mi_zona, on: !s.mi_zona.on } }))
            }
            label={`Mi Zona +${miZonaPct.toFixed(1)}%`}
          />
        </div>

        {/* Mi Zona — Lima: mapa de zonas clickeable (Fase 3); provincias: slider. */}
        {tools.mi_zona.on && isLima && (
          <div
            style={{
              marginTop: 12,
              display: 'flex',
              gap: 16,
              flexWrap: 'wrap',
              alignItems: 'flex-start',
            }}
          >
            <div style={{ flex: '0 1 460px', minWidth: 280 }}>
              <MiZonaMap
                selected={tools.mi_zona.zones}
                onToggle={(id) =>
                  setTools((s) => {
                    const set = new Set(s.mi_zona.zones)
                    if (set.has(id)) set.delete(id)
                    else set.add(id)
                    return { ...s, mi_zona: { ...s.mi_zona, zones: [...set] } }
                  })
                }
              />
            </div>
            <div style={{ fontSize: 13, minWidth: 200, flex: '1 1 200px' }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                {t('rentabilidad.mi_zona_select')}
              </div>
              <div style={{ color: 'var(--color-muted)' }}>
                {tools.mi_zona.zones.length} {t('rentabilidad.zones_selected')}
              </div>
              {tools.mi_zona.zones.length < 2 ? (
                <div style={{ color: '#DC2626', marginTop: 8 }}>
                  {t('rentabilidad.mi_zona_min2')}
                </div>
              ) : (
                <div style={{ marginTop: 8, lineHeight: 1.7 }}>
                  {t('rentabilidad.gmv_inside')}:{' '}
                  <strong>{Math.round((miZonaRatio ?? 1) * 100)}%</strong>
                  <br />
                  {t('rentabilidad.tools_extra')}:{' '}
                  <strong style={{ color: 'var(--color-yango, #E53935)', fontSize: 15 }}>
                    +{miZonaPct.toFixed(1)}%
                  </strong>{' '}
                  {t('rentabilidad.col_commission').toLowerCase()}
                </div>
              )}
              {tools.mi_zona.zones.length > 0 && (
                <button
                  onClick={() => setTools((s) => ({ ...s, mi_zona: { ...s.mi_zona, zones: [] } }))}
                  style={{ ...chipAddStyle, marginTop: 10 }}
                >
                  {t('rentabilidad.clear')}
                </button>
              )}
            </div>
          </div>
        )}
        {tools.mi_zona.on && !isLima && (
          <div
            style={{
              marginTop: 12,
              display: 'flex',
              gap: 12,
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
          >
            <span
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: 'var(--color-muted)',
                whiteSpace: 'nowrap',
              }}
            >
              {t('rentabilidad.mi_zona_coverage')}
            </span>
            <input
              type="range"
              min="0.25"
              max="1"
              step="0.01"
              value={tools.mi_zona.ratio}
              onChange={(e) =>
                setTools((s) => ({
                  ...s,
                  mi_zona: { ...s.mi_zona, ratio: Number(e.target.value) },
                }))
              }
              style={{ flex: 1, maxWidth: 360, accentColor: 'var(--color-yango, #E53935)' }}
            />
            <span style={{ fontSize: 12, color: 'var(--color-muted)' }}>
              {Math.round(tools.mi_zona.ratio * 100)}% GMV →{' '}
              <strong style={{ color: 'var(--color-yango, #E53935)' }}>
                +{miZonaPct.toFixed(1)}%
              </strong>
            </span>
            <span style={{ fontSize: 11, color: 'var(--color-muted)', fontStyle: 'italic' }}>
              {t('rentabilidad.mi_zona_lima_only')}
            </span>
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
            // ~2 paneles por fila en pantallas grandes (antes 3 muy angostos) y
            // 1 a pantalla completa en monitores chicos → barras mucho más anchas.
            gridTemplateColumns: 'repeat(auto-fit, minmax(680px, 1fr))',
            gap: 18,
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
              <div style={{ width: '100%', height: 340 }}>
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
                            fontSize: 10,
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

      {/* ── Matriz de escenarios Yango (E1 mejor / E4 peor) ── */}
      {hasData && refTier && (
        <div className="rent-panel" style={panelStyle}>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: 8,
              marginBottom: 8,
            }}
          >
            <span style={{ fontSize: 14, fontWeight: 700 }}>{t('rentabilidad.scenarios')}</span>
            <span style={{ fontSize: 12, color: 'var(--color-muted)' }}>
              {t('rentabilidad.ref_tier')}: <strong>{refTier.uiCat}</strong> · {liveTrips}{' '}
              {t('rentabilidad.trips_week')} ·{' '}
              {metric === 'trip' ? t('rentabilidad.per_trip') : t('rentabilidad.per_week')}
            </span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={matrixTableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>{t('rentabilidad.col_scenario')}</th>
                  <th style={thStyle}>Flex</th>
                  <th style={thStyle}>Mi Zona</th>
                  <th style={thStyle}>{t('rentabilidad.col_commission')}</th>
                  <th style={thStyle}>{t('rentabilidad.col_net')}</th>
                  <th style={thStyle}>vs {refComp || '—'}</th>
                </tr>
              </thead>
              <tbody>
                {[
                  {
                    key: 'best',
                    label: t('rentabilidad.scenario_best'),
                    comm: yangoScenarioCommission(dbCity, 'best'),
                    flex: '—',
                    zona: '0%',
                    accent: '#16A34A',
                  },
                  {
                    key: 'current',
                    label: t('rentabilidad.scenario_current'),
                    comm: yangoCommission,
                    flex: tools.flex ? `${YANGO_TOOLS.flex.pct}%` : '—',
                    zona: tools.mi_zona.on ? `${miZonaPct.toFixed(1)}%` : '—',
                    accent: 'var(--color-yango, #E53935)',
                  },
                  {
                    key: 'worst',
                    label: t('rentabilidad.scenario_worst'),
                    comm: yangoScenarioCommission(dbCity, 'worst'),
                    flex: `${YANGO_TOOLS.flex.pct}%`,
                    zona: `${MI_ZONA_MAX_PCT}%`,
                    accent: '#DC2626',
                  },
                ].map((row) => {
                  const yNet = yangoNetAt(refTier.dbCategory, liveTrips, row.comm)
                  const rNet = refComp ? netFor(refTier.dbCategory, refComp, liveTrips) : null
                  const delta = yNet != null && rNet != null ? yNet - rNet : null
                  return (
                    <tr key={row.key}>
                      <td style={{ ...tdStyle, fontWeight: 600 }}>
                        <span style={{ color: row.accent }}>●</span> {row.label}
                      </td>
                      <td style={tdStyle}>{row.flex}</td>
                      <td style={tdStyle}>{row.zona}</td>
                      <td style={{ ...tdStyle, fontWeight: 700 }}>{row.comm.toFixed(1)}%</td>
                      <td style={tdStyle}>{fmt(yNet)}</td>
                      <td
                        style={{
                          ...tdStyle,
                          color: delta == null ? 'inherit' : delta >= 0 ? '#16A34A' : '#DC2626',
                          fontWeight: 600,
                        }}
                      >
                        {delta == null ? '—' : `${delta >= 0 ? '+' : '-'}${fmt(Math.abs(delta))}`}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 6, fontSize: 11, color: 'var(--color-muted)' }}>
            {t('rentabilidad.scenarios_hint')}
          </div>
        </div>
      )}

      {/* ── Notas: fórmulas de cálculo ── */}
      <div className="rent-panel" style={panelStyle}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>
          {t('rentabilidad.formulas')}
        </div>
        <div style={formulaBoxStyle}>
          <div style={{ marginBottom: 8 }}>
            <strong>{t('rentabilidad.formula_competitor')}</strong>
            <div>neto/semana = precio_prom × viajes × (1 − comisión%) + bonos</div>
            <div>neto/viaje = neto/semana ÷ viajes</div>
          </div>
          <div style={{ marginBottom: 8 }}>
            <strong>Yango ({t('rentabilidad.formula_stacked')})</strong>
            <div>comisión_total = base_ciudad + partner(3%) + Σ herramientas activas</div>
            <div style={{ color: 'var(--color-yango, #E53935)' }}>
              = {yangoBasePct}% ({dbCity}) + {YANGO_PARTNER_PCT}% + {yangoExtraPct.toFixed(1)}% ={' '}
              <strong>{yangoCommission.toFixed(1)}%</strong>
            </div>
            <div>Mi Casa +5% · Mis Destinos +5% · Flex +6% · Mi Zona = 9·(1 − t^1.087)%</div>
            <div style={{ color: 'var(--color-muted)' }}>
              {' '}
              t = (cobertura_GMV − 0.251) / 0.749 · cobertura 100% → 0% · ≤25% → 9%
            </div>
          </div>
          <div style={{ color: 'var(--color-muted)' }}>{t('rentabilidad.formula_note')}</div>
        </div>
      </div>

      {/* ── Análisis auto-generado (Build 3) ── */}
      {hasData && refTier && (
        <div className="rent-panel" style={panelStyle}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>
            {t('rentabilidad.analysis')}
          </div>
          <div style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 12 }}>
            {liveTrips} {t('rentabilidad.trips_week')} ·{' '}
            {metric === 'trip' ? t('rentabilidad.per_trip') : t('rentabilidad.per_week')} ·{' '}
            {t('rentabilidad.total_commission')} {yangoCommission.toFixed(1)}%
            {winSummary.total > 0 && (
              <>
                {' · '}
                <strong
                  style={{
                    color: winSummary.wins * 2 >= winSummary.total ? '#16A34A' : '#DC2626',
                  }}
                >
                  Yango {t('rentabilidad.wins_in')} {winSummary.wins}/{winSummary.total}{' '}
                  {t('rentabilidad.comparisons')}
                </strong>
              </>
            )}
          </div>

          {/* 1. Yango vs competidores por tier */}
          <div style={{ fontSize: 13, fontWeight: 600, margin: '4px 0 6px' }}>
            {t('rentabilidad.vs_competitors_tier')}
          </div>
          <div style={{ overflowX: 'auto', marginBottom: 18 }}>
            <table style={matrixTableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>{t('rentabilidad.col_tier')}</th>
                  <th style={thStyle}>Yango</th>
                  {rivalCols.map((c) => (
                    <th key={c} style={thStyle}>
                      vs {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tierComparison.map((row) => (
                  <tr key={row.uiCat}>
                    <td style={{ ...tdStyle, fontWeight: 600 }}>{row.uiCat}</td>
                    <td style={tdStyle}>{fmt(row.yNet)}</td>
                    {row.cells.map((c) => (
                      <td
                        key={c.comp}
                        style={{
                          ...tdStyle,
                          color: c.delta == null ? 'inherit' : c.delta >= 0 ? '#16A34A' : '#DC2626',
                          fontWeight: 600,
                        }}
                      >
                        {c.delta == null
                          ? '—'
                          : `${c.delta >= 0 ? '+' : '-'}${fmt(Math.abs(c.delta))}`}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 2 + 3: costo de herramientas + break-even, lado a lado */}
          <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
            {toolCosts && (
              <div style={{ flex: '1 1 320px' }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
                  {t('rentabilidad.tool_costs')}{' '}
                  <span style={{ fontWeight: 400, color: 'var(--color-muted)', fontSize: 11 }}>
                    · {refTier.uiCat}
                  </span>
                </div>
                <table style={matrixTableStyle}>
                  <thead>
                    <tr>
                      <th style={thStyle}>{t('rentabilidad.col_tool')}</th>
                      <th style={thStyle}>+pp</th>
                      <th style={thStyle}>{t('rentabilidad.cost')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {toolCosts.items.map((it) => (
                      <tr key={it.key} style={{ opacity: it.active ? 1 : 0.5 }}>
                        <td style={tdStyle}>
                          {it.label}
                          {it.active && (
                            <span style={{ color: '#16A34A', marginLeft: 4 }}>
                              ✓ {t('rentabilidad.active')}
                            </span>
                          )}
                        </td>
                        <td style={tdStyle}>+{it.pct.toFixed(it.key === 'mi_zona' ? 1 : 0)}</td>
                        <td style={{ ...tdStyle, color: '#DC2626' }}>−{fmt(it.cost)}</td>
                      </tr>
                    ))}
                    <tr>
                      <td style={{ ...tdStyle, fontWeight: 700 }}>
                        {t('rentabilidad.total_active')}
                      </td>
                      <td style={{ ...tdStyle, fontWeight: 700 }}>
                        +{toolCosts.totalPct.toFixed(1)}
                      </td>
                      <td style={{ ...tdStyle, fontWeight: 700, color: '#DC2626' }}>
                        −{fmt(toolCosts.totalCost)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}

            {breakEvens.length > 0 && (
              <div style={{ flex: '1 1 320px' }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
                  {t('rentabilidad.break_even')}{' '}
                  <span style={{ fontWeight: 400, color: 'var(--color-muted)', fontSize: 11 }}>
                    · {refTier.uiCat}
                  </span>
                </div>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.9 }}>
                  {breakEvens.map((be) => {
                    const map = {
                      always: { txt: t('rentabilidad.be_always'), color: '#16A34A' },
                      never: { txt: t('rentabilidad.be_never'), color: '#DC2626' },
                      from: {
                        txt: `${t('rentabilidad.be_from')} ${be.n} ${t('rentabilidad.trips_week')}`,
                        color: '#D97706',
                      },
                      until: {
                        txt: `${t('rentabilidad.be_until')} ${be.n} ${t('rentabilidad.trips_week')}`,
                        color: '#D97706',
                      },
                      nodata: { txt: t('rentabilidad.be_nodata'), color: 'var(--color-muted)' },
                    }
                    const v = map[be.type]
                    return (
                      <li key={be.comp}>
                        <strong>{be.comp}</strong>:{' '}
                        <span style={{ color: v.color, fontWeight: 600 }}>{v.txt}</span>
                      </li>
                    )
                  })}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// Toggle de herramienta Yango (estilo botón pill).
function ToolToggle({ active, onClick, label, sub }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 12px',
        borderRadius: 8,
        fontSize: 13,
        cursor: 'pointer',
        border:
          '1px solid ' + (active ? 'var(--color-yango, #E53935)' : 'var(--color-border, #e2e8f0)'),
        background: active ? 'var(--color-yango, #E53935)' : '#fff',
        color: active ? '#fff' : 'var(--color-muted)',
        fontWeight: active ? 600 : 400,
      }}
    >
      <span>{active ? '☑' : '☐'}</span>
      {label}
      {sub && <span style={{ fontSize: 10, opacity: 0.85, fontStyle: 'italic' }}>· {sub}</span>}
    </button>
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
const matrixTableStyle = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 13,
}
const thStyle = {
  textAlign: 'left',
  padding: '6px 10px',
  borderBottom: '2px solid var(--color-border, #e2e8f0)',
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--color-muted)',
  whiteSpace: 'nowrap',
}
const tdStyle = {
  padding: '7px 10px',
  borderBottom: '1px solid var(--color-border, #f1f5f9)',
  whiteSpace: 'nowrap',
}
const formulaBoxStyle = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 12,
  lineHeight: 1.7,
  background: 'var(--color-bg, #f8fafc)',
  border: '1px solid var(--color-border, #e2e8f0)',
  borderRadius: 6,
  padding: '12px 14px',
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
