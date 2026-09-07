// Lógica pura para el Monitoreo rediseñado (mig 146-147): clasificación de
// "vivo/reciente/vencido" de un latido de sesión activa, y el label de
// ciudad+distrito compartido entre paneles. Sin dependencias de React/Supabase
// — fácil de testear (ver scripts/test-monitoring.mjs).
import { getCityLabel } from './constants.js'
import { SPECIAL_CATEGORY_ZONES } from './dataEntry/keys.js'

// Umbrales de "sesión en vivo" (ver mig 146, comentario de ci_active_sessions):
// el latido se manda cada ~25s mientras sessionActive; 3 min de silencio ya es
// sospechoso (varios latidos perdidos seguidos), 15 min se considera
// abandonada del todo (refresh duro / laptop cerrada) y deja de listarse.
export const LIVE_STALE_MS = 3 * 60_000
export const DEBUG_WINDOW_MS = 15 * 60_000

// 'live': latido reciente, el hub está activo ahora.
// 'recent_inactive': sin latido hace un rato — probablemente cerró sin
//   Terminar, pero todavía vale la pena mostrarlo atenuado por si vuelve.
// 'expired': ya pasó la ventana de debug — Monitoreo no debe traer esta fila.
export function classifySession(lastSeenIso, nowMs = Date.now()) {
  if (!lastSeenIso) return 'expired'
  const lastSeenMs = new Date(lastSeenIso).getTime()
  if (Number.isNaN(lastSeenMs)) return 'expired'
  const age = nowMs - lastSeenMs
  if (age <= LIVE_STALE_MS) return 'live'
  if (age <= DEBUG_WINDOW_MS) return 'recent_inactive'
  return 'expired'
}

// Label legible "Ciudad" o "Ciudad TukTuk · Distrito" — única fuente para los
// paneles de Monitoreo. (Nota: DataEntry.jsx tiene 2 formatos ligeramente
// distintos ya en uso para otros fines — acá se estandariza al más explícito,
// sin tocar esos usos existentes.)
//
// Delivery/Cargo (2026-09): mismo `zone` que TukTuk usa para el distrito,
// pero acá NO es un distrito — es la categoría misma (ver
// SPECIAL_CATEGORY_ZONES). "Lima TukTuk · Delivery" confundiría al admin;
// debe leerse "Lima · Delivery", igual que frontLabel() en sessionFronts.js
// (misma regla, dos fuentes de datos: ahí llega bucketKey ya parseado con
// `kind`, acá llegan city/zone sueltos desde ci_active_sessions).
export function formatCityZoneLabel(city, zone) {
  const label = getCityLabel(city)
  if (!zone) return label
  if (SPECIAL_CATEGORY_ZONES.has(zone)) return `${label} · ${zone}`
  return `${label} TukTuk · ${zone}`
}
