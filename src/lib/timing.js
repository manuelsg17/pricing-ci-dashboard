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
  ok:   3500,
  warn: 5000,
  err:  6000,
})

// Delay antes de hacer reload() tras un guardado/sync que requiere
// re-fetch completo de la página (raro — la mayoría usa SWR + live-sync).
export const RELOAD_DELAY_MS = 1500

// Debounce de búsquedas en inputs (RawData filtros, etc.).
export const SEARCH_DEBOUNCE_MS = 300

// Auto-dismiss de banners de sync OK (banner-style, no toast).
export const SYNC_OK_BANNER_MS = 5000

// TTL del cache de useStaleWhileRevalidate.
// `config`: tablas de configuración (bracket_weights, thresholds, etc.) —
//   5 min porque cambian raro y el live-sync ya refresca on-change.
// `country`: catálogo de países / ciudades / categorías — 24h porque solo
//   cambia cuando se agrega/quita un país (event raro).
export const SWR_TTL_MS = Object.freeze({
  config:  5  * 60 * 1000,
  country: 24 * 60 * 60 * 1000,
})
