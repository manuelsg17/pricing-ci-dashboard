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
 * CARGA PEREZOSA POR CONSUMIDOR (auditoría frontend 2026-09-04):
 *   Antes el provider disparaba las 8 queries al montar, para TODAS las
 *   pantallas — Dashboard pagaba competitive_bands, yango_gmv_tiers,
 *   indrive_config, etc. que nunca lee. Ahora cada bloque se fetchea la
 *   primera vez que un consumidor lo LEE: el value del context expone
 *   getters con los mismos nombres de siempre (`weights`, `semaforo`, …),
 *   y leer uno marca el slice como "pedido" y habilita su
 *   useStaleWhileRevalidate. La API pública no cambia: destructurar
 *   `const { weights } = useConfigContext()` sigue funcionando igual.
 *
 *   Detalles que importan:
 *   · El "pedir" ocurre durante el render del consumidor; el setState del
 *     provider se difiere a un microtask para no actualizar un componente
 *     mientras se renderea otro (warning de React). Mientras tanto, el
 *     slice devuelve el cache de localStorage si existe (mismo render
 *     instantáneo de antes) o EMPTY.
 *   · Un slice pedido una vez queda habilitado para toda la sesión: el
 *     live-sync (`config:changed`) lo refresca igual que antes, y `refresh()`
 *     recarga solo los pedidos (los no pedidos no tienen nada que recargar).
 *   · `loading`/`error` agregan SOLO los slices pedidos hasta ese momento —
 *     antes eran fijos sobre weights/semaforo/thresholds. Competitividad,
 *     que lee `competitiveBands` y `loading`, ahora ve el loading de
 *     competitive_bands (antes miraba el de 3 tablas que no usa).
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
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import { sb } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useStaleWhileRevalidate } from '../hooks/useStaleWhileRevalidate'

const ConfigContext = createContext(null)

// Frozen empty array a nivel de módulo — referencia estable cuando
// loading o error. Sin esto, cada render entregaría un nuevo []
// y los consumidores memoizados dispararían re-render innecesario.
const EMPTY = Object.freeze([])

// Un fetcher por slice, a nivel de módulo (identidad estable, sin closures
// por render). La clave del objeto es el nombre público en el context.
const SLICES = {
  weights: {
    key: 'cfg.bracket_weights.all',
    table: 'bracket_weights',
    fetcher: async () => {
      const { data, error } = await sb.from('bracket_weights').select('*')
      if (error) throw error
      return data || []
    },
  },
  semaforo: {
    key: 'cfg.semaforo_config.all',
    table: 'semaforo_config',
    fetcher: async () => {
      const { data, error } = await sb
        .from('semaforo_config')
        .select('*')
        .order('band')
        .order('min_pct')
      if (error) throw error
      return data || []
    },
  },
  thresholds: {
    key: 'cfg.distance_thresholds.all',
    table: 'distance_thresholds',
    fetcher: async () => {
      const { data, error } = await sb.from('distance_thresholds').select('*')
      if (error) throw error
      return data || []
    },
  },
  priceRules: {
    key: 'cfg.price_validation_rules.all',
    table: 'price_validation_rules',
    fetcher: async () => {
      const { data, error } = await sb.from('price_validation_rules').select('*')
      if (error) throw error
      return data || []
    },
  },
  rushHour: {
    key: 'cfg.rush_hour_windows.all',
    table: 'rush_hour_windows',
    fetcher: async () => {
      const { data, error } = await sb
        .from('rush_hour_windows')
        .select('*')
        .order('city')
        .order('start_time')
      if (error) throw error
      return data || []
    },
  },
  indriveConfig: {
    key: 'cfg.indrive_config.all',
    table: 'indrive_config',
    fetcher: async () => {
      const { data, error } = await sb
        .from('indrive_config')
        .select('country, city, category, adjustment_pct, note')
      if (error) throw error
      return data || []
    },
  },
  competitiveBands: {
    key: 'cfg.competitive_bands.all',
    table: 'competitive_bands',
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
  },
  yangoGmvTiers: {
    key: 'cfg.yango_gmv_tiers.all',
    table: 'yango_gmv_tiers',
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
  },
}

const SLICE_NAMES = Object.keys(SLICES)

// Los hooks no pueden ir dentro de un loop dinámico, pero SLICE_NAMES es una
// constante de módulo: el orden y la cantidad de llamadas es idéntico en
// cada render, que es lo que las reglas de hooks exigen.
function useSlice(name, enabled) {
  const { key, table, fetcher } = SLICES[name]
  return useStaleWhileRevalidate({ key, enabled, liveSyncTable: table, fetcher })
}

export function ConfigProvider({ children }) {
  const { session } = useAuth()
  const hasSession = !!session

  // Set de slices pedidos por algún consumidor. El ref es la verdad
  // síncrona (se actualiza durante el render del consumidor); el state es
  // lo que fuerza el re-render del provider para habilitar el fetch.
  const requestedRef = useRef(new Set())
  const [requested, setRequested] = useState(() => requestedRef.current)
  const flushScheduled = useRef(false)

  const request = useCallback((name) => {
    if (requestedRef.current.has(name)) return
    requestedRef.current = new Set(requestedRef.current).add(name)
    if (flushScheduled.current) return
    flushScheduled.current = true
    // Diferido: estamos dentro del render de un consumidor, no del provider.
    queueMicrotask(() => {
      flushScheduled.current = false
      setRequested(requestedRef.current)
    })
  }, [])

  /* eslint-disable react-hooks/rules-of-hooks -- SLICE_NAMES es constante de
     módulo: misma cantidad y orden de hooks en cada render. */
  const slices = {}
  for (const name of SLICE_NAMES) {
    slices[name] = useSlice(name, hasSession && requested.has(name))
  }
  /* eslint-enable react-hooks/rules-of-hooks */

  // Deps granulares a propósito (.data/.loading/.error/.reload por slice)
  // para no invalidar el memo con cada render del hook SWR.
  const deps = SLICE_NAMES.flatMap((n) => [
    slices[n].data,
    slices[n].loading,
    slices[n].error,
    slices[n].reload,
  ])

  const value = useMemo(() => {
    const isRequested = (n) => requestedRef.current.has(n)
    const obj = {
      // OJO: solo la lectura de un slice lo marca como pedido, así que un
      // consumidor que destructure `loading` ANTES que su slice lo vería en
      // false el primer render. Por eso también cuenta como "cargando" un
      // slice pedido que todavía no tiene datos.
      get loading() {
        return SLICE_NAMES.some(
          (n) => isRequested(n) && (slices[n].loading || slices[n].data == null)
        )
      },
      get error() {
        for (const n of SLICE_NAMES) if (isRequested(n) && slices[n].error) return slices[n].error
        return null
      },
      // Recarga los slices pedidos e INVALIDA el cache de los que no lo fueron:
      // el editor de Configuración suele no leer el slice que acaba de guardar
      // (CompetitiveBandsConfig solo usa `refresh`), y sin esto la pantalla de
      // análisis leía del cache viejo de localStorage (TTL 5 min).
      refresh: () => {
        for (const n of SLICE_NAMES) {
          if (isRequested(n)) continue
          try {
            localStorage.removeItem(SLICES[n].key)
          } catch {}
        }
        return Promise.all(SLICE_NAMES.filter(isRequested).map((n) => slices[n].reload()))
      },
    }
    // No enumerables: un spread, un Object.keys o un console.log del context
    // dispararía las 8 queries de golpe y anularía la carga perezosa.
    for (const k of ['loading', 'error', 'refresh']) {
      Object.defineProperty(obj, k, {
        ...Object.getOwnPropertyDescriptor(obj, k),
        enumerable: false,
      })
    }
    for (const name of SLICE_NAMES) {
      Object.defineProperty(obj, name, {
        enumerable: false,
        get() {
          request(name)
          return slices[name].data ?? EMPTY
        },
      })
    }
    return obj
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, requested, ...deps])

  return <ConfigContext.Provider value={value}>{children}</ConfigContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useConfigContext() {
  const ctx = useContext(ConfigContext)
  if (!ctx) throw new Error('useConfigContext debe estar dentro de <ConfigProvider>')
  return ctx
}
