/**
 * ConfigProvider — Sprint 2.4 — Cache global de configs read-only.
 *
 * PROBLEMA QUE RESUELVE:
 *   ANTES App.jsx hacía useStaleWhileRevalidate(bracket_weights) +
 *   useStaleWhileRevalidate(semaforo_config) y pasaba dbWeights/dbSemaforo
 *   como props a Dashboard/Market/Coverage. Otras pages que también
 *   necesitan estos (Upload, DriverEarnings) NO los recibían — accedían
 *   por su cuenta con fetcher propio → inconsistencia + duplicación.
 *
 *   AHORA cualquier page hace `const { weights, semaforo } = useConfigContext()`.
 *   Una sola fuente de verdad, live-sync compartido, render instantáneo
 *   desde cache compartido entre pages.
 *
 * ALCANCE:
 *   READ-ONLY. Para CRUD (editar pesos / umbrales / etc.) seguir usando
 *   el hook `useConfig()` en src/hooks/useConfig.js — ese hook está pensado
 *   para Config.jsx que edita + guarda. Este context es para los consumers
 *   que solo necesitan leer (Dashboard, Market, Coverage, etc.).
 *
 * LIVE-SYNC:
 *   Cada config tiene live-sync por su tabla. Si otra sesión edita weights
 *   desde /config, useStaleWhileRevalidate refetchea silenciosamente y
 *   todos los consumers re-renderean con la nueva data.
 *
 * SIN FILTRO DE COUNTRY:
 *   El fetch trae TODA la data (sin .eq('country')). Los consumers filtran
 *   por country localmente. Esto evita re-fetchear cuando el usuario cambia
 *   de Peru a Colombia — el cache ya tiene la data de ambos.
 */
import { createContext, useContext, useMemo } from 'react'
import { sb } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useStaleWhileRevalidate } from '../hooks/useStaleWhileRevalidate'

const ConfigContext = createContext(null)

// Frozen empty array a nivel de módulo — referencia estable cuando
// loading o error. Sin esto, cada render entregaría un nuevo []
// y los consumidores memoizados dispararían re-render innecesario.
const EMPTY = Object.freeze([])

export function ConfigProvider({ children }) {
  const { session } = useAuth()
  const enabled = !!session

  const weights = useStaleWhileRevalidate({
    key: 'cfg.bracket_weights.all',
    enabled,
    liveSyncTable: 'bracket_weights',
    fetcher: async () => {
      const { data, error } = await sb.from('bracket_weights').select('*')
      if (error) throw error
      return data || []
    },
  })

  const semaforo = useStaleWhileRevalidate({
    key: 'cfg.semaforo_config.all',
    enabled,
    liveSyncTable: 'semaforo_config',
    fetcher: async () => {
      const { data, error } = await sb
        .from('semaforo_config')
        .select('*')
        .order('band')
        .order('min_pct')
      if (error) throw error
      return data || []
    },
  })

  const thresholds = useStaleWhileRevalidate({
    key: 'cfg.distance_thresholds.all',
    enabled,
    liveSyncTable: 'distance_thresholds',
    fetcher: async () => {
      const { data, error } = await sb.from('distance_thresholds').select('*')
      if (error) throw error
      return data || []
    },
  })

  const priceRules = useStaleWhileRevalidate({
    key: 'cfg.price_validation_rules.all',
    enabled,
    liveSyncTable: 'price_validation_rules',
    fetcher: async () => {
      const { data, error } = await sb.from('price_validation_rules').select('*')
      if (error) throw error
      return data || []
    },
  })

  const rushHour = useStaleWhileRevalidate({
    key: 'cfg.rush_hour_windows.all',
    enabled,
    liveSyncTable: 'rush_hour_windows',
    fetcher: async () => {
      const { data, error } = await sb
        .from('rush_hour_windows')
        .select('*')
        .order('city')
        .order('start_time')
      if (error) throw error
      return data || []
    },
  })

  const indriveConfig = useStaleWhileRevalidate({
    key: 'cfg.indrive_config.all',
    enabled,
    liveSyncTable: 'indrive_config',
    fetcher: async () => {
      const { data, error } = await sb
        .from('indrive_config')
        .select('country, city, category, adjustment_pct, note')
      if (error) throw error
      return data || []
    },
  })

  const competitiveBands = useStaleWhileRevalidate({
    key: 'cfg.competitive_bands.all',
    enabled,
    liveSyncTable: 'competitive_bands',
    fetcher: async () => {
      // ORDER BY explícito: sin esto, Postgres no garantiza el orden de
      // retorno y el fallback countryBands[0] de Competitividad.jsx podría
      // "saltar" de banda entre refetches sin que el usuario lo pida.
      const { data, error } = await sb
        .from('competitive_bands')
        .select('*')
        .order('competitor_name')
        .order('category')
      if (error) throw error
      return data || []
    },
  })

  const yangoGmvTiers = useStaleWhileRevalidate({
    key: 'cfg.yango_gmv_tiers.all',
    enabled,
    liveSyncTable: 'yango_gmv_tiers',
    fetcher: async () => {
      const { data, error } = await sb
        .from('yango_gmv_tiers')
        // valid_from/valid_to (mig 237): sin ellas el cálculo no puede elegir la
        // versión vigente y mezclaría dos escaleras (gana el peldaño más alto).
        .select('country, city, variant, min_trips, pct, cap, is_active, valid_from, valid_to')
      // Tolerante a pre-migración (mig 116 sin aplicar) → [] y el cálculo usa
      // las tablas hardcodeadas de fallback.
      if (error) {
        console.warn('[ConfigProvider] yango_gmv_tiers no disponible:', error.message)
        return []
      }
      return data || []
    },
  })

  const value = useMemo(
    () => ({
      weights: weights.data ?? EMPTY,
      semaforo: semaforo.data ?? EMPTY,
      thresholds: thresholds.data ?? EMPTY,
      priceRules: priceRules.data ?? EMPTY,
      rushHour: rushHour.data ?? EMPTY,
      indriveConfig: indriveConfig.data ?? EMPTY,
      yangoGmvTiers: yangoGmvTiers.data ?? EMPTY,
      competitiveBands: competitiveBands.data ?? EMPTY,
      loading: weights.loading || semaforo.loading || thresholds.loading,
      error: weights.error || semaforo.error || thresholds.error,
      refresh: () =>
        Promise.all([
          weights.reload(),
          semaforo.reload(),
          thresholds.reload(),
          priceRules.reload(),
          rushHour.reload(),
          indriveConfig.reload(),
          yangoGmvTiers.reload(),
          competitiveBands.reload(),
        ]),
    }),
    // Deps granulares a propósito (.data/.loading/.reload por config) para
    // no invalidar el memo con cada render del hook SWR.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      weights.data,
      weights.loading,
      weights.error,
      weights.reload,
      semaforo.data,
      semaforo.loading,
      semaforo.error,
      semaforo.reload,
      thresholds.data,
      thresholds.loading,
      thresholds.error,
      thresholds.reload,
      priceRules.data,
      priceRules.reload,
      rushHour.data,
      rushHour.reload,
      indriveConfig.data,
      indriveConfig.reload,
      yangoGmvTiers.data,
      yangoGmvTiers.reload,
      competitiveBands.data,
      competitiveBands.reload,
    ]
  )

  return <ConfigContext.Provider value={value}>{children}</ConfigContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useConfigContext() {
  const ctx = useContext(ConfigContext)
  if (!ctx) throw new Error('useConfigContext debe estar dentro de <ConfigProvider>')
  return ctx
}
