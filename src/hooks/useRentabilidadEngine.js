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
// de ganancia neta (bonusFor/netFor/yangoNetAt/netPerTrip) que alimentan
// gráficos, matriz de escenarios y el análisis auto-generado.
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
  asOf, // ISO date: vigencia de bonos/escaleras (mig 237)
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
            asOf,
          })
      const gmv = isYango(comp)
        ? yangoGmvBonus(dbCity, dbCategory, branded, pd.avg, trips, yangoGmvTiers, asOf)
        : 0
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
      yangoGmvTiers,
      asOf,
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
        yangoGmvBonus(dbCity, dbCategory, branded, pd.avg, trips, yangoGmvTiers, asOf)
      return metric === 'trip' ? week / trips : week
    },
    [pricesByCat, bonusFor, metric, country, dbCity, branded, yangoGmvTiers, asOf]
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
            asOf,
          })
      const gmv = isYango(comp)
        ? yangoGmvBonus(dbCity, dbCategory, branded, pd.avg, n, yangoGmvTiers, asOf)
        : 0
      return pd.avg * (1 - comm / 100) + (bonusFor(comp, dbCategory, n, pd.avg) + gmv) / n
    },
    [
      pricesByCat,
      commissions,
      bonuses,
      bonusFor,
      yangoCommission,
      archetype,
      dbCity,
      branded,
      yangoGmvTiers,
      asOf,
    ]
  )

  return {
    yangoBasePct,
    isLima,
    miZonaRatio,
    miZonaPct,
    yangoExtraPct,
    yangoCommission,
    bonusFor,
    netFor,
    yangoNetAt,
    yangoKeyFor,
    netPerTrip,
  }
}
