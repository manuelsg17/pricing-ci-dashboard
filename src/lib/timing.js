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
// vez por turno, nunca sobreescrito). Es más preciso que `duration_minutes`
// (tiempo transcurrido de sesión completa, que incluye pausas/otros frentes)
// para saber cuánto tardó un hub en llenar CADA turno. Compartido entre el
// Historial propio de Ingresar CI (DataEntry.jsx) y "Sesiones recientes" de
// Monitoreo (CompletedSessionsTable.jsx) — antes vivía solo en DataEntry.jsx.
export function turnoBreakdownLabel(turnoTimings) {
  if (!turnoTimings || typeof turnoTimings !== 'object') return ''
  return Object.entries(turnoTimings)
    .filter(([, t]) => t?.startedAt)
    .map(([label, t]) => {
      const mins = t.endedAt
        ? Math.round((new Date(t.endedAt) - new Date(t.startedAt)) / 60000)
        : null
      return `${label} ${mins != null ? mins + 'min' : '—'}`
    })
    .join(' · ')
}
