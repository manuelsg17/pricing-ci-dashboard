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
  DEFAULT_WEIGHTS,
  getCompetitors,
  resolveDbParams,
  getYangoDisplayName,
} from '../lib/constants'
import { normalizeCompetitorName } from '../lib/normalize'
import { computeWeightedAvg, buildWeightsMap } from '../algorithms/weightedAverage'
import { useConfigContext } from '../context/ConfigProvider'
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
import { resolveBonusWeekly, effectiveCommission } from '../lib/competitorBonus'
import { yangoGmvBonus, yangoGmvDetail, hasYangoGmvTable } from '../lib/yangoGmvBonus'
import MiZonaMap from '../components/rentabilidad/MiZonaMap'
import CollapsibleSection from '../components/market/CollapsibleSection'

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
  const { weights: dbWeights } = useConfigContext()
  const uiCities = countryConfig.cities
  const { currency } = countryConfig

  const [uiCity, setUiCity] = useState(uiCities[0] || 'Lima')
  const [refYear, setRefYear] = useState(() => getISOYearWeek().year)
  const [refWeek, setRefWeek] = useState(() => getISOYearWeek().week)
  const [hoursPerWeek, setHoursPerWeek] = useState(40)
  const [segments, setSegments] = useState([60, 90])
  const [liveTrips, setLiveTrips] = useState(70)
  const [metric, setMetric] = useState('trip') // 'trip' | 'week'
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [tools, setTools] = useState(DEFAULT_TOOLS_STATE) // herramientas Yango
  // Arquetipo de driver: define a quién se evalúan los bonos (segmento) y los
  // parámetros de ventana/racha (alimentan comm_discount InDrive, surge y streak Didi).
  const [archetype, setArchetype] = useState({ segment: 'active', sharePeak: 0.25, streakDays: 3 })
  const [branded, setBranded] = useState(false) // bono Yango GMV: con/sin brandeo (default sin)

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
    // Mismo origen que el "Promedio Ponderado" del dashboard: el RPC _fast lee
    // la MV (bot + manual, precio efectivo) y devuelve el promedio por bracket.
    // Acá colapsamos surge por observación y aplicamos el WA con los mismos
    // pesos (buildWeightsMap) → el número coincide con el WA del dashboard, y
    // aparecen todos los competidores con data (Cabify, Didi, etc.).
    const perCat = await Promise.all(
      dbCategories.map((cat) =>
        sb
          .rpc('get_dashboard_data_weekly_fast', {
            p_city: dbCity,
            p_category: cat,
            p_country: country,
            p_week_start: refWeek,
            p_year_start: refYear,
            p_week_end: refWeek,
            p_year_end: refYear,
          })
          .then(({ data }) => ({ cat, rows: data || [] }))
      )
    )

    const result = {}
    for (const { cat, rows } of perCat) {
      // (comp, bracket) → promedio ponderado por observation_count (colapsa surge)
      const byComp = {}
      for (const r of rows) {
        const comp =
          normalizeCompetitorName(r.competition_name, { city: dbCity }) || r.competition_name
        if (!byComp[comp]) byComp[comp] = {}
        const b = byComp[comp][r.distance_bracket] || { sum: 0, w: 0 }
        b.sum += Number(r.avg_price) * Number(r.observation_count)
        b.w += Number(r.observation_count)
        byComp[comp][r.distance_bracket] = b
      }
      const weights = buildWeightsMap(dbWeights || [], dbCity, cat) || DEFAULT_WEIGHTS
      result[cat] = {}
      for (const [comp, brackets] of Object.entries(byComp)) {
        const bracketPrices = {}
        let count = 0
        for (const [bk, { sum, w }] of Object.entries(brackets)) {
          if (w > 0) bracketPrices[bk] = sum / w
          count += w
        }
        const wa = computeWeightedAvg(bracketPrices, weights)
        if (wa != null) result[cat][comp] = { avg: wa, count }
      }
    }
    setPricesByCat(result)
    setLoading(false)
  }, [country, dbCity, dbCategories, refYear, refWeek, dbWeights])

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

  // Por defecto se muestran TODOS los competidores con data (Yango primero,
  // rivales ordenados por volumen) — el analista pidió no tener que activar
  // Cabify/otros cada vez.
  const defaultSelection = useMemo(() => {
    const yangos = shownCompetitors.filter(isYango)
    const others = shownCompetitors
      .filter((c) => !isYango(c))
      .sort((a, b) => (compCounts[b] || 0) - (compCounts[a] || 0))
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
  // Delega en el motor único (peldaño-máximo, sin el bug de suma). cash semanal.
  const bonusFor = useCallback(
    (comp, dbCategory, trips, fare) => {
      const { total } = resolveBonusWeekly(bonuses[comp], {
        trips,
        hours: hoursPerWeek,
        dbCategory,
        fare,
        commPct: commissions[comp] ?? 20,
        segment: archetype.segment,
        sharePeak: archetype.sharePeak,
        streakDays: archetype.streakDays,
      })
      return total
    },
    [bonuses, hoursPerWeek, commissions, archetype]
  )

  const netFor = useCallback(
    (dbCategory, comp, trips) => {
      const pd = pricesByCat[dbCategory]?.[comp]
      if (!pd || !trips || isNaN(pd.avg)) return null
      // Yango: comisión apilable computada. Resto: % del DB con descuento de
      // ventana (comm_discount InDrive) según el arquetipo.
      const comm = isYango(comp)
        ? yangoCommission
        : effectiveCommission(commissions[comp] ?? 20, bonuses[comp], archetype.sharePeak, {
            dbCategory,
            segment: archetype.segment,
          })
      const gmv = isYango(comp) ? yangoGmvBonus(dbCity, dbCategory, branded, pd.avg, trips) : 0
      const week =
        pd.avg * trips * (1 - comm / 100) + bonusFor(comp, dbCategory, trips, pd.avg) + gmv
      return metric === 'trip' ? week / trips : week
    },
    [
      pricesByCat,
      commissions,
      bonuses,
      bonusFor,
      metric,
      yangoCommission,
      archetype,
      dbCity,
      branded,
    ]
  )

  // Ganancia de Yango a una comisión arbitraria (para la matriz de escenarios).
  // La key de Yango varía por ciudad/categoría (ej. Corp usa 'YangoEconomy'),
  // así que la resolvemos con getYangoDisplayName en vez de hardcodear 'Yango'.
  const yangoNetAt = useCallback(
    (dbCategory, trips, commPct) => {
      const yangoKey = getYangoDisplayName(country, dbCity, dbCategory)
      const pd = pricesByCat[dbCategory]?.[yangoKey]
      if (!pd || !trips || isNaN(pd.avg)) return null
      const week =
        pd.avg * trips * (1 - commPct / 100) +
        bonusFor(yangoKey, dbCategory, trips, pd.avg) +
        yangoGmvBonus(dbCity, dbCategory, branded, pd.avg, trips)
      return metric === 'trip' ? week / trips : week
    },
    [pricesByCat, bonusFor, metric, country, dbCity, branded]
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
      const comm = isYango(comp)
        ? yangoCommission
        : effectiveCommission(commissions[comp] ?? 20, bonuses[comp], archetype.sharePeak, {
            dbCategory,
            segment: archetype.segment,
          })
      const gmv = isYango(comp) ? yangoGmvBonus(dbCity, dbCategory, branded, pd.avg, n) : 0
      return pd.avg * (1 - comm / 100) + (bonusFor(comp, dbCategory, n, pd.avg) + gmv) / n
    },
    [pricesByCat, commissions, bonuses, bonusFor, yangoCommission, archetype, dbCity, branded]
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

  // Bonos "gancho 1 vez" (recurring=false) por competidor en el tier de ref, al
  // volumen vivo. Solo aparecen si el segmento del arquetipo coincide (ej. un
  // welcome 'new' o reconexión 'reactivado' no le salen a un activo).
  const oneOffs = useMemo(() => {
    if (!refTier) return []
    const comps = [yangoKeyFor(refTier.dbCategory), ...rivalCols]
    const out = []
    for (const comp of comps) {
      const { oneOff } = resolveBonusWeekly(bonuses[comp], {
        trips: liveTrips,
        hours: hoursPerWeek,
        dbCategory: refTier.dbCategory,
        fare: pricesByCat[refTier.dbCategory]?.[comp]?.avg,
        commPct: commissions[comp] ?? 20,
        segment: archetype.segment,
        sharePeak: archetype.sharePeak,
        streakDays: archetype.streakDays,
      })
      if (oneOff > 0) out.push({ comp, oneOff })
    }
    return out
  }, [
    refTier,
    rivalCols,
    bonuses,
    liveTrips,
    hoursPerWeek,
    pricesByCat,
    commissions,
    archetype,
    yangoKeyFor,
  ])

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

  // ── Desglose de ganancia: tarifa (neto) vs bonos/incentivos por competidor ──
  // Mismo cálculo que netFor: fare = precio·viajes·(1−comisión efectiva); bonos =
  // bonusFor (competitor_bonuses) + GMV de Yango. Hace visible cuánto pesa cada parte.
  const breakdown = useMemo(() => {
    if (!refTier || !hasData || !liveTrips) return []
    const div = metric === 'trip' ? liveTrips : 1
    const out = []
    for (const comp of visibleCompetitors) {
      const pd = pricesByCat[refTier.dbCategory]?.[comp]
      if (!pd || isNaN(pd.avg)) continue
      const comm = isYango(comp)
        ? yangoCommission
        : effectiveCommission(commissions[comp] ?? 20, bonuses[comp], archetype.sharePeak, {
            dbCategory: refTier.dbCategory,
            segment: archetype.segment,
          })
      const fareWeek = pd.avg * liveTrips * (1 - comm / 100)
      const gmv = isYango(comp)
        ? yangoGmvBonus(dbCity, refTier.dbCategory, branded, pd.avg, liveTrips)
        : 0
      const bonusWeek = bonusFor(comp, refTier.dbCategory, liveTrips, pd.avg) + gmv
      out.push({
        comp,
        comm,
        fare: fareWeek / div,
        bonus: bonusWeek / div,
        total: (fareWeek + bonusWeek) / div,
      })
    }
    return out
  }, [
    refTier,
    hasData,
    liveTrips,
    metric,
    visibleCompetitors,
    pricesByCat,
    yangoCommission,
    commissions,
    bonuses,
    archetype,
    dbCity,
    branded,
    bonusFor,
  ])

  // ── Resultado (hero): Yango vs mejor rival al volumen vivo + tiers ganados ──
  const hero = useMemo(() => {
    if (!refTier || !hasData) return null
    const netM = (dbCat, comp) =>
      metric === 'trip' ? netPerTrip(dbCat, comp, liveTrips) : netFor(dbCat, comp, liveTrips)
    const yNet = netM(refTier.dbCategory, yangoKeyFor(refTier.dbCategory))
    let bestComp = null
    let bestNet = null
    for (const comp of rivalCols) {
      const v = netM(refTier.dbCategory, comp)
      if (v == null) continue
      if (bestNet == null || v > bestNet) {
        bestNet = v
        bestComp = comp
      }
    }
    let won = 0
    let total = 0
    for (const { dbCategory } of catMap) {
      const y = netPerTrip(dbCategory, yangoKeyFor(dbCategory), liveTrips)
      if (y == null) continue
      let best = null
      for (const comp of rivalCols) {
        const v = netPerTrip(dbCategory, comp, liveTrips)
        if (v != null && (best == null || v > best)) best = v
      }
      if (best == null) continue
      total++
      if (y >= best) won++
    }
    const delta = yNet != null && bestNet != null ? yNet - bestNet : null
    return { yNet, bestComp, bestNet, delta, won, total }
  }, [refTier, hasData, rivalCols, catMap, yangoKeyFor, netPerTrip, netFor, metric, liveTrips])

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="rent-page" style={{ padding: '16px 20px', maxWidth: 1820 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 2 }}>{t('rentabilidad.title')}</h1>
      <p style={{ color: 'var(--color-muted)', fontSize: 13, marginBottom: 16 }}>
        {t('rentabilidad.subtitle')}
      </p>

      {/* ── RESULTADO (hero): la respuesta primero ── */}
      {hero && (
        <div
          style={{
            background: 'var(--color-panel, #fff)',
            border: '1px solid var(--color-border, #e2e8f0)',
            borderLeft: `4px solid ${hero.delta != null && hero.delta >= 0 ? '#16A34A' : '#DC2626'}`,
            borderRadius: 10,
            boxShadow: 'var(--shadow-sm)',
            padding: '14px 18px',
            marginBottom: 16,
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: 'var(--color-muted)',
              textTransform: 'uppercase',
              letterSpacing: 0.5,
            }}
          >
            📊 {refTier.uiCat} · {liveTrips} viajes/sem ·{' '}
            {metric === 'trip' ? t('rentabilidad.per_trip') : t('rentabilidad.per_week')}
          </div>
          <div
            style={{
              display: 'flex',
              gap: 24,
              flexWrap: 'wrap',
              alignItems: 'baseline',
              marginTop: 8,
            }}
          >
            <div>
              <span style={{ fontSize: 13, color: 'var(--color-muted)' }}>Yango </span>
              <span style={{ fontSize: 24, fontWeight: 800, color: 'var(--color-yango, #E53935)' }}>
                {fmt(hero.yNet)}
              </span>
            </div>
            {hero.bestComp && (
              <div>
                <span style={{ fontSize: 13, color: 'var(--color-muted)' }}>
                  vs {hero.bestComp}{' '}
                </span>
                <span style={{ fontSize: 20, fontWeight: 700 }}>{fmt(hero.bestNet)}</span>
              </div>
            )}
            {hero.delta != null && (
              <div
                style={{
                  fontSize: 20,
                  fontWeight: 800,
                  color: hero.delta >= 0 ? '#16A34A' : '#DC2626',
                }}
              >
                {hero.delta >= 0 ? '▲ +' : '▼ −'}
                {fmt(Math.abs(hero.delta))}
              </div>
            )}
          </div>
          {hero.total > 0 && (
            <div style={{ fontSize: 13, marginTop: 6 }}>
              Yango gana en{' '}
              <strong>
                {hero.won} de {hero.total}
              </strong>{' '}
              categorías a este volumen.
            </div>
          )}
        </div>
      )}

      {/* ── Parámetros ── */}
      <div className="rent-panel" style={panelStyle}>
        {/* ── Controles principales ── */}
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label={t('filter.city')}>
            <select value={uiCity} onChange={(e) => setUiCity(e.target.value)} style={selectStyle}>
              {uiCities.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>

          <Field label={t('earnings.week')}>
            <input
              type="number"
              value={refWeek}
              min="1"
              max="53"
              style={inputStyle}
              onChange={(e) => {
                const v = Number(e.target.value)
                if (v) setRefWeek(v)
              }}
            />
          </Field>

          <Field label={t('rentabilidad.metric')}>
            <div
              style={{
                display: 'inline-flex',
                border: '1px solid var(--color-border, #e2e8f0)',
                borderRadius: 8,
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

          <button
            type="button"
            onClick={() => setShowAdvanced((s) => !s)}
            style={advancedToggleStyle}
          >
            ⚙ Avanzado {showAdvanced ? '▴' : '▾'}
          </button>
        </div>

        {/* ── Avanzado: año, horas, segmentos (oculto por defecto) ── */}
        {showAdvanced && (
          <div
            style={{
              marginTop: 12,
              padding: 12,
              borderRadius: 8,
              background: 'var(--color-bg, #f8fafc)',
              border: '1px solid var(--color-border, #e2e8f0)',
              display: 'flex',
              gap: 18,
              flexWrap: 'wrap',
              alignItems: 'flex-end',
            }}
          >
            <Field label={t('earnings.year')}>
              <input
                type="number"
                value={refYear}
                min="2020"
                max="2030"
                style={inputStyle}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  if (v) setRefYear(v)
                }}
              />
            </Field>
            <Field label={t('earnings.hours_per_week')}>
              <input
                type="number"
                value={hoursPerWeek}
                min="1"
                max="80"
                style={inputStyle}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  if (v) setHoursPerWeek(v)
                }}
              />
            </Field>
            <Field label={t('rentabilidad.segments')}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
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
            </Field>
          </div>
        )}

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
            style={inputStyle}
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
      <CollapsibleSection
        id="rent-tools"
        title={t('rentabilidad.yango_tools')}
        subtitle={`${t('rentabilidad.total_commission')}: ${yangoCommission.toFixed(1)}% (${yangoBasePct}% ${t('rentabilidad.base_city')} + ${YANGO_PARTNER_PCT}% partner${yangoExtraPct > 0 ? ` + ${yangoExtraPct.toFixed(1)}% ${t('rentabilidad.tools_extra')}` : ''})`}
        defaultOpen={false}
      >
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
            active={tools.mi_zona.on}
            onClick={() =>
              setTools((s) => ({ ...s, mi_zona: { ...s.mi_zona, on: !s.mi_zona.on } }))
            }
            label={`Mi Zona +${miZonaPct.toFixed(1)}%`}
          />
          <ToolToggle
            active={branded}
            onClick={() => setBranded((b) => !b)}
            label={t('rentabilidad.branded')}
          />
        </div>

        {/* Readout del bono Yango por % de GMV (cash aditivo, no comisión) */}
        {hasYangoGmvTable(dbCity) &&
          refTier &&
          (() => {
            const fare = pricesByCat[refTier.dbCategory]?.[yangoKeyFor(refTier.dbCategory)]?.avg
            const d = yangoGmvDetail(dbCity, refTier.dbCategory, branded, fare, liveTrips)
            return (
              <div style={{ marginTop: 10, fontSize: 12, color: 'var(--color-muted)' }}>
                {t('rentabilidad.gmv_bonus')} (
                {branded ? t('rentabilidad.branded') : t('rentabilidad.unbranded')}) ·{' '}
                {refTier.uiCat} · {liveTrips} {t('rentabilidad.trips_week')}:{' '}
                {d ? (
                  <strong style={{ color: 'var(--color-yango, #E53935)' }}>
                    +{fmt(d.bono)} ({d.pct}% GMV, tope {currency} {d.cap})
                  </strong>
                ) : (
                  '—'
                )}
              </div>
            )
          })()}

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
      </CollapsibleSection>

      {/* ── Arquetipo de driver ── */}
      <CollapsibleSection
        id="rent-archetype"
        title={t('rentabilidad.archetype')}
        subtitle={`${archetype.segment} · ${Math.round(archetype.sharePeak * 100)}% en pico · racha ${archetype.streakDays}/7`}
        defaultOpen={false}
      >
        <div
          style={{ fontSize: 12, color: 'var(--color-text)', marginBottom: 12, lineHeight: 1.5 }}
        >
          El <strong>arquetipo</strong> es el perfil del conductor con el que comparás — sirve para
          evaluar los bonos de forma justa. Cada control afecta a un competidor distinto:
        </div>
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div>
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-muted)' }}>
              {t('rentabilidad.segment')}
            </span>
            <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
              {[
                ['active', 'seg_active'],
                ['new', 'seg_new'],
                ['reactivated', 'seg_reactivated'],
                ['all', 'seg_all'],
              ].map(([v, k]) => (
                <button
                  key={v}
                  onClick={() => setArchetype((s) => ({ ...s, segment: v }))}
                  style={toggleStyle(archetype.segment === v)}
                >
                  {t('rentabilidad.' + k)}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 10, color: 'var(--color-muted)', marginTop: 4 }}>
              filtra qué bonos aplican · todos los competidores
            </div>
          </div>
          <Field label={`${t('rentabilidad.share_peak')} · InDrive / surge`}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={archetype.sharePeak}
                onChange={(e) => setArchetype((s) => ({ ...s, sharePeak: Number(e.target.value) }))}
                style={{ width: 160, accentColor: 'var(--color-yango, #E53935)' }}
              />
              <span style={{ fontSize: 12, color: 'var(--color-muted)', minWidth: 34 }}>
                {Math.round(archetype.sharePeak * 100)}%
              </span>
            </div>
          </Field>
          <Field label={`${t('rentabilidad.streak_days')} · Didi`}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="range"
                min="0"
                max="7"
                step="1"
                value={archetype.streakDays}
                onChange={(e) =>
                  setArchetype((s) => ({ ...s, streakDays: Number(e.target.value) }))
                }
                style={{ width: 120, accentColor: 'var(--color-yango, #E53935)' }}
              />
              <span style={{ fontSize: 12, color: 'var(--color-muted)', minWidth: 28 }}>
                {archetype.streakDays}/7
              </span>
            </div>
          </Field>
        </div>
        <div
          style={{ fontSize: 11, color: 'var(--color-muted)', marginTop: 8, fontStyle: 'italic' }}
        >
          {t('rentabilidad.archetype_hint')}
        </div>
      </CollapsibleSection>

      <div style={{ fontSize: 12, color: 'var(--color-muted)', margin: '4px 2px 12px' }}>
        ℹ️ Cómo leer: cada barra es la <strong>ganancia neta del conductor</strong> (precio ×
        (1−comisión) + bonos). Más alta = mejor para el conductor.
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

      {/* ── Desglose de ganancia (tarifa vs bonos) ── */}
      {breakdown.length > 0 && (
        <div className="rent-panel" style={panelStyle}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 2 }}>
            Cómo se compone la ganancia
          </div>
          <div style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 10 }}>
            {refTier?.uiCat} · {liveTrips} viajes/sem ·{' '}
            {metric === 'trip' ? t('rentabilidad.per_trip') : t('rentabilidad.per_week')} — cuánto
            sale de la <strong>tarifa</strong> (después de comisión) y cuánto de{' '}
            <strong>bonos/incentivos</strong> del competidor.
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={matrixTableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Competidor</th>
                  <th style={thStyle}>Comisión efectiva</th>
                  <th style={thStyle}>Tarifa (neto)</th>
                  <th style={thStyle}>Bonos / incentivos</th>
                  <th style={thStyle}>Total</th>
                  <th style={thStyle}>% por bonos</th>
                </tr>
              </thead>
              <tbody>
                {breakdown.map((b) => (
                  <tr key={b.comp}>
                    <td style={{ ...tdStyle, fontWeight: 600 }}>
                      <span style={{ color: COMPETITOR_COLORS[b.comp] || '#64748b' }}>●</span>{' '}
                      {b.comp}
                    </td>
                    <td style={tdStyle}>{b.comm.toFixed(1)}%</td>
                    <td style={tdStyle}>{fmt(b.fare)}</td>
                    <td
                      style={{
                        ...tdStyle,
                        fontWeight: 600,
                        color: b.bonus > 0.005 ? '#16A34A' : 'var(--color-muted)',
                      }}
                    >
                      {b.bonus > 0.005 ? `+ ${fmt(b.bonus)}` : '—'}
                    </td>
                    <td style={{ ...tdStyle, fontWeight: 700 }}>{fmt(b.total)}</td>
                    <td style={tdStyle}>
                      {b.total > 0 && b.bonus > 0.005
                        ? `${Math.round((b.bonus / b.total) * 100)}%`
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 6, fontSize: 11, color: 'var(--color-muted)' }}>
            Los bonos salen de Config → Bonos (competitor_bonuses); el de Yango es el bono por % de
            GMV. Si una fila muestra “—” en bonos, ese competidor no tiene bono cargado para este
            segmento/volumen.
          </div>
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
                  <th style={thStyle}>Mi Zona</th>
                  <th style={thStyle}>{t('rentabilidad.col_commission')}</th>
                  <th style={thStyle}>{t('rentabilidad.col_net')}</th>
                  {rivalCols.map((c) => (
                    <th key={c} style={thStyle}>
                      vs {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[
                  {
                    key: 'best',
                    label: t('rentabilidad.scenario_best'),
                    comm: yangoScenarioCommission(dbCity, 'best'),
                    zona: '0%',
                    accent: '#16A34A',
                  },
                  {
                    key: 'current',
                    label: t('rentabilidad.scenario_current'),
                    comm: yangoCommission,
                    zona: tools.mi_zona.on ? `${miZonaPct.toFixed(1)}%` : '—',
                    accent: 'var(--color-yango, #E53935)',
                  },
                  {
                    key: 'worst',
                    label: t('rentabilidad.scenario_worst'),
                    comm: yangoScenarioCommission(dbCity, 'worst'),
                    zona: `${MI_ZONA_MAX_PCT}%`,
                    accent: '#DC2626',
                  },
                ].map((row) => {
                  const yNet = yangoNetAt(refTier.dbCategory, liveTrips, row.comm)
                  return (
                    <tr key={row.key}>
                      <td style={{ ...tdStyle, fontWeight: 600 }}>
                        <span style={{ color: row.accent }}>●</span> {row.label}
                      </td>
                      <td style={tdStyle}>{row.zona}</td>
                      <td style={{ ...tdStyle, fontWeight: 700 }}>{row.comm.toFixed(1)}%</td>
                      <td style={tdStyle}>{fmt(yNet)}</td>
                      {rivalCols.map((c) => {
                        const rNet = netFor(refTier.dbCategory, c, liveTrips)
                        const delta = yNet != null && rNet != null ? yNet - rNet : null
                        return (
                          <td
                            key={c}
                            style={{
                              ...tdStyle,
                              color: delta == null ? 'inherit' : delta >= 0 ? '#16A34A' : '#DC2626',
                              fontWeight: 600,
                            }}
                          >
                            {delta == null
                              ? '—'
                              : `${delta >= 0 ? '+' : '-'}${fmt(Math.abs(delta))}`}
                          </td>
                        )
                      })}
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
        <div style={{ display: 'grid', gap: 10 }}>
          <div style={formulaCardStyle}>
            <div style={formulaLabelStyle}>{t('rentabilidad.formula_competitor')}</div>
            <div style={formulaExprStyle}>
              neto/semana = precio × viajes × (1 − comisión) + bonos
            </div>
            <div style={formulaExprStyle}>neto/viaje = neto/semana ÷ viajes</div>
          </div>
          <div style={formulaCardStyle}>
            <div style={formulaLabelStyle}>Yango — {t('rentabilidad.formula_stacked')}</div>
            <div style={formulaExprStyle}>
              comisión_total = base_ciudad + partner(3%) + Σ herramientas
            </div>
            <div
              style={{
                ...formulaExprStyle,
                color: 'var(--color-yango, #E53935)',
                fontWeight: 700,
                fontSize: 14,
              }}
            >
              = {yangoBasePct}% ({dbCity}) + {YANGO_PARTNER_PCT}% + {yangoExtraPct.toFixed(1)}% ={' '}
              {yangoCommission.toFixed(1)}%
            </div>
            <div style={{ ...formulaExprStyle, color: 'var(--color-muted)', fontSize: 11 }}>
              herramientas: Mi Casa +5% · Mis Destinos +5% · Mi Zona 9·(1 − t^1.087)% · t =
              (cobertura_GMV − 0.251) / 0.749
            </div>
          </div>
          <div style={{ fontSize: 11, color: 'var(--color-muted)' }}>
            {t('rentabilidad.formula_note')}
          </div>
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

          {/* Bonos one-off (gancho de una sola vez, no entran al recurrente) */}
          {oneOffs.length > 0 && (
            <div style={{ fontSize: 12, marginBottom: 10 }}>
              <span style={{ fontWeight: 600 }}>{t('rentabilidad.one_off')}:</span>{' '}
              {oneOffs.map((o) => (
                <span key={o.comp} style={{ marginRight: 12 }}>
                  {o.comp} <strong style={{ color: '#D97706' }}>+{fmt(o.oneOff)}</strong>{' '}
                  <span style={{ fontSize: 10, color: 'var(--color-muted)' }}>1×</span>
                </span>
              ))}
            </div>
          )}

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

const inputStyle = {
  padding: '6px 10px',
  border: '1px solid var(--color-border, #e2e8f0)',
  borderRadius: 8,
  fontSize: 13,
  width: 90,
  background: '#fff',
}
const advancedToggleStyle = {
  padding: '6px 12px',
  border: '1px solid var(--color-border, #e2e8f0)',
  borderRadius: 8,
  background: '#fff',
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--color-muted)',
  cursor: 'pointer',
}
const panelStyle = {
  background: 'var(--color-panel, #fff)',
  border: '1px solid var(--color-border, #e2e8f0)',
  borderRadius: 10,
  padding: 16,
  marginBottom: 16,
  boxShadow: 'var(--shadow-sm)',
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
const formulaCardStyle = {
  background: '#fff',
  border: '1px solid var(--color-border, #e2e8f0)',
  borderRadius: 8,
  padding: '10px 14px',
}
const formulaLabelStyle = {
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  color: 'var(--color-muted)',
  marginBottom: 4,
}
const formulaExprStyle = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 12.5,
  lineHeight: 1.7,
  color: 'var(--color-text)',
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
const selectStyle = {
  padding: '6px 10px',
  border: '1px solid var(--color-border, #e2e8f0)',
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 600,
  background: '#fff',
  cursor: 'pointer',
  minWidth: 150,
}
function toggleStyle(active) {
  return {
    padding: '7px 14px',
    fontSize: 12,
    cursor: 'pointer',
    border: 'none',
    background: active ? 'var(--color-yango, #E53935)' : '#fff',
    color: active ? '#fff' : 'var(--color-muted)',
    fontWeight: active ? 700 : 500,
    transition: 'background 0.12s',
  }
}
