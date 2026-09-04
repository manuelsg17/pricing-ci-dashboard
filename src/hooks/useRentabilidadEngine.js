import { useMemo, useCallback } from 'react'
import { getYangoDisplayName } from '../lib/constants'
import {
  YANGO_PARTNER_PCT,
  yangoBaseCommission,
  yangoToolsExtra,
  miZonaCommissionForRatio,
} from '../lib/yangoTools'
import { gmvInsideRatio, miZonaCommissionForSelection } from '../lib/limaZones'
import { resolveBonusWeekly, effectiveCommission } from '../lib/competitorBonus'
import { yangoGmvBonus } from '../lib/yangoGmvBonus'
import { isYangoBrand as isYango } from '../lib/normalize'

// Extraído de Rentabilidad.jsx (Fase 1.2) — el motor de pricing: comisión
// apilable de Yango (base ciudad + partner + herramientas) y las funciones
// de ganancia neta que alimentan gráficos, matriz de escenarios, break-even
// y el desglose del análisis.
//
// Fase D (2026-09-03): UNA sola fórmula. `netParts` es la única función que
// sabe cómo se compone el take-home semanal:
//   fareWeek  = precio · viajes · (1 − comisión_efectiva)
//   bonusWeek = bonos de competidor (motor único) + bono GMV de Yango
//   totalWeek = fareWeek + bonusWeek
// netFor / yangoNetAt / netPerTrip y el desglose del análisis son
// proyecciones de `netParts` (por viaje o por semana). Antes el mismo bloque
// estaba copiado en 4 lugares y el doc de diseño §9.1 avisaba que tocar uno
// solo desincronizaba los otros.
export function useRentabilidadEngine({
  dbCity,
  country,
  tools,
  archetype,
  hoursPerWeek,
  commissions,
  bonuses,
  pricesByCat,
  metric,
  branded,
  yangoGmvTiers,
  asOf, // ISO date o { from, to }: vigencia de bonos/escaleras (mig 237)
}) {
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

  // Clave de Yango para una categoría (Corp usa 'YangoEconomy', resto 'Yango').
  const yangoKeyFor = useCallback(
    (dbCategory) => getYangoDisplayName(country, dbCity, dbCategory),
    [country, dbCity]
  )

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
        asOf,
      })
      return total
    },
    [bonuses, hoursPerWeek, commissions, archetype, asOf]
  )

  // Comisión efectiva de un competidor: Yango = apilable; resto = % del DB
  // con descuento de ventana (comm_discount InDrive) según el arquetipo.
  const commissionFor = useCallback(
    (comp, dbCategory) =>
      isYango(comp)
        ? yangoCommission
        : effectiveCommission(commissions[comp] ?? 20, bonuses[comp], archetype.sharePeak, {
            dbCategory,
            segment: archetype.segment,
            asOf,
          }),
    [yangoCommission, commissions, bonuses, archetype, asOf]
  )

  // LA fórmula. Devuelve null si no hay precio. `commOverride` permite
  // evaluar Yango a una comisión arbitraria (matriz de escenarios).
  const netParts = useCallback(
    (comp, dbCategory, trips, commOverride = null) => {
      const pd = pricesByCat[dbCategory]?.[comp]
      if (!pd || !trips || isNaN(pd.avg)) return null
      const fare = pd.avg
      const comm = commOverride ?? commissionFor(comp, dbCategory)
      const gmv = isYango(comp)
        ? yangoGmvBonus(dbCity, dbCategory, branded, fare, trips, yangoGmvTiers, asOf)
        : 0
      const fareWeek = fare * trips * (1 - comm / 100)
      const bonusWeek = bonusFor(comp, dbCategory, trips, fare) + gmv
      return { fare, trips, comm, gmv, fareWeek, bonusWeek, totalWeek: fareWeek + bonusWeek }
    },
    [pricesByCat, commissionFor, bonusFor, dbCity, branded, yangoGmvTiers, asOf]
  )

  // Ganancia en la métrica activa (por viaje | semana).
  const netFor = useCallback(
    (dbCategory, comp, trips) => {
      const p = netParts(comp, dbCategory, trips)
      if (!p) return null
      return metric === 'trip' ? p.totalWeek / trips : p.totalWeek
    },
    [netParts, metric]
  )

  // Ganancia de Yango a una comisión arbitraria (para la matriz de escenarios).
  const yangoNetAt = useCallback(
    (dbCategory, trips, commPct) => {
      const p = netParts(yangoKeyFor(dbCategory), dbCategory, trips, commPct)
      if (!p) return null
      return metric === 'trip' ? p.totalWeek / trips : p.totalWeek
    },
    [netParts, yangoKeyFor, metric]
  )

  // Ganancia POR VIAJE a n viajes (siempre per-trip, para el break-even).
  const netPerTrip = useCallback(
    (dbCategory, comp, n) => {
      const p = netParts(comp, dbCategory, n)
      return p ? p.totalWeek / n : null
    },
    [netParts]
  )

  return {
    yangoBasePct,
    isLima,
    miZonaRatio,
    miZonaPct,
    yangoExtraPct,
    yangoCommission,
    bonusFor,
    commissionFor,
    netParts,
    netFor,
    yangoNetAt,
    yangoKeyFor,
    netPerTrip,
  }
}
