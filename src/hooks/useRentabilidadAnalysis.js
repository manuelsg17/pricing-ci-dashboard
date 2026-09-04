import { useMemo, useCallback } from 'react'
import { getYangoDisplayName } from '../lib/constants'
import { YANGO_TOOLS } from '../lib/yangoTools'
import { resolveBonusWeekly } from '../lib/competitorBonus'
import { isYangoBrand as isYango } from '../lib/normalize'

// Extraído de Rentabilidad.jsx (Fase 1.2) — análisis derivado que alimenta
// los gráficos, la matriz de escenarios y la sección "Análisis auto-generado":
// comparación por tier, costo de herramientas, break-even, bonos one-off,
// desglose de ganancia (tarifa vs bonos) y el resultado (hero).
export function useRentabilidadAnalysis({
  catMap,
  visibleCompetitors,
  netFor,
  segments,
  liveTrips,
  pricesByCat,
  country,
  dbCity,
  refTierCat,
  yangoKeyFor,
  metric,
  tools,
  miZonaPct,
  yangoExtraPct,
  netPerTrip,
  bonuses,
  hoursPerWeek,
  commissions,
  archetype,
  hasData,
  asOf, // ISO date: vigencia de bonos/escaleras (mig 237)
  netParts, // Fase D: la única fórmula de take-home (engine)
}) {
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
  const tiersWithData = useMemo(
    () =>
      catMap.filter(
        ({ dbCategory }) =>
          pricesByCat[dbCategory]?.[getYangoDisplayName(country, dbCity, dbCategory)]
      ),
    [catMap, pricesByCat, country, dbCity]
  )
  const refTier = useMemo(() => {
    if (refTierCat) {
      const sel = tiersWithData.find((c) => c.dbCategory === refTierCat)
      if (sel) return sel
    }
    return tiersWithData[0]
  }, [tiersWithData, refTierCat])

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
        asOf,
      })
      if (oneOff > 0) out.push({ comp, oneOff })
    }
    return out
  }, [
    asOf,
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

  // ── Desglose de ganancia: tarifa (neto) vs bonos/incentivos por competidor ──
  // Mismo cálculo que netFor: fare = precio·viajes·(1−comisión efectiva); bonos =
  // bonusFor (competitor_bonuses) + GMV de Yango. Hace visible cuánto pesa cada parte.
  const breakdown = useMemo(() => {
    if (!refTier || !hasData || !liveTrips) return []
    const div = metric === 'trip' ? liveTrips : 1
    const out = []
    for (const comp of visibleCompetitors) {
      // Fase D: misma fórmula que netFor, sin copiarla (engine.netParts).
      const p = netParts(comp, refTier.dbCategory, liveTrips)
      if (!p) continue
      const pd = { avg: p.fare }
      const { comm, fareWeek, bonusWeek } = p
      out.push({
        comp,
        comm,
        gross: (pd.avg * liveTrips) / div, // tarifa bruta (WA) en la misma métrica
        fare: fareWeek / div,
        bonus: bonusWeek / div,
        total: (fareWeek + bonusWeek) / div,
        // ── Magnitudes SEMANALES absolutas para la tabla "espejo del Excel" ──
        avgFare: pd.avg, // tarifa promedio por viaje (Avg Fare)
        trips: liveTrips, // # viajes/sem (constante por fila)
        gmvGross: pd.avg * liveTrips, // GMV bruto semanal
        gmvNet: fareWeek, // GMV − comisión (neto antes de bonos)
        incentiveWeek: bonusWeek, // incentivos/bonos semanales
        totalWeek: fareWeek + bonusWeek, // total semanal (neto + bonos)
        perTrip: liveTrips > 0 ? (fareWeek + bonusWeek) / liveTrips : 0, // ganancia por viaje
      })
    }
    return out
  }, [netParts, refTier, hasData, liveTrips, metric, visibleCompetitors])

  // Mejor competidor (mayor total) + posición de Yango en el ranking de rentabilidad.
  const breakdownStats = useMemo(() => {
    if (!breakdown.length) return { bestTotal: null, yangoRank: null, ranks: {} }
    // Rank/best por Total SEMANAL (totalWeek), que es lo que muestra la tabla —
    // así el rank no depende del toggle Por viaje/Semana (independiente de `metric`).
    const sorted = [...breakdown].sort((a, b) => b.totalWeek - a.totalWeek)
    const yangoBest = breakdown
      .filter((b) => isYango(b.comp))
      .sort((a, b) => b.totalWeek - a.totalWeek)[0]
    const ranks = {}
    sorted.forEach((b, i) => {
      ranks[b.comp] = i + 1
    })
    return {
      bestTotal: sorted[0].totalWeek,
      yangoRank: yangoBest ? sorted.findIndex((b) => b === yangoBest) + 1 : null,
      ranks,
    }
  }, [breakdown])

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

  return {
    chartDataFor,
    panels,
    tiersWithData,
    refTier,
    rivalCols,
    tierComparison,
    winSummary,
    toolCosts,
    breakEvens,
    oneOffs,
    breakdown,
    breakdownStats,
    hero,
  }
}
