// ════════════════════════════════════════════════════════════════════════
// Constantes de timing (ms) para toasts, reloads, debounces y caches.
//
// Centralizadas para evitar números mágicos dispersos. Antes 3500/5000/6000
// estaban hardcoded en Toast.jsx, 1500 en varios `setTimeout(reload, ...)`,
// y los TTL de SWR cache vivían en useStaleWhileRevalidate como default.
//
// REGLA: si un número se usa en 2+ lugares, importalo de acá.
// Si solo se usa en 1 lugar y es obvio del contexto (ej. debounce de 300ms
// dentro de un componente search), no hace falta moverlo.
// ════════════════════════════════════════════════════════════════════════

// Duración por defecto de notificaciones toast según severidad.
// info < warn < err porque el usuario necesita más tiempo para leer
// mensajes de error que confirmaciones rápidas.
export const TOAST_DURATION_MS = Object.freeze({
  info: 3500,
  ok: 3500,
  warn: 5000,
  err: 6000,
})

// TTL del cache de useStaleWhileRevalidate.
// `config`: tablas de configuración (bracket_weights, thresholds, etc.) —
//   5 min porque cambian raro y el live-sync ya refresca on-change.
// `country`: catálogo de países / ciudades / categorías — 24h porque solo
//   cambia cuando se agrega/quita un país (event raro).
export const SWR_TTL_MS = Object.freeze({
  config: 5 * 60 * 1000,
  country: 24 * 60 * 60 * 1000,
})

// Desglose de minutos por turno a partir de `ci_sessions.turno_timings`
// (mig 159 — jsonb `{ [label]: { startedAt, endedAt } }`, estampado una sola
// vez por turno, nunca sobreescrito). Compartido entre el Historial propio de
// Ingresar CI (DataEntry.jsx) y "Sesiones recientes" de Monitoreo
// (CompletedSessionsTable.jsx).
//
// Desde el rediseño de la duración, este desglose y `duration_minutes` salen
// del MISMO módulo (sessionDuration.js): la duración total es la unión de
// estos mismos tramos. Antes cada uno hacía su propia cuenta y podían no
// cerrar entre sí — el hub veía "Mañana 40min · Tarde 35min" al lado de un
// total de "0.1 min" sin ninguna explicación.
//
// El sufijo `*` marca un tramo RECORTADO al techo de TURNO_MAX_MS: laptop
// cerrada o turno heredado de ayer. Se muestra en vez de ocultarse, porque
// un número recortado que se presenta como exacto es la mentira que este
// rediseño vino a sacar.
import { tramosDeTurnos } from './sessionDuration.js'

export function turnoBreakdownLabel(turnoTimings) {
  return tramosDeTurnos(turnoTimings)
    .map((t) => {
      if (t.minutos == null) return `${t.label} —`
      return `${t.label} ${Math.round(t.minutos)}min${t.recortado ? '*' : ''}`
    })
    .join(' · ')
}
