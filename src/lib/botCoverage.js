// Helpers puros para la frescura de la data del bot (matriz ciudad × bracket).
// Separados del componente para no romper react-refresh (un .jsx debe exportar
// solo componentes). Usados por BotCoverageMatrix.jsx y BotCoverageCard.jsx.
import { BRACKETS } from './constants.js'

export const STALE_WARN_MIN = 60 // amarillo si va >1h detrás del más fresco de su ciudad
export const STALE_BAD_MIN = 180 // rojo si va >3h detrás

export function cellInstant(row) {
  if (!row?.last_date || !row?.last_time) return null
  const ms = Date.parse(`${row.last_date}T${row.last_time}`)
  return Number.isNaN(ms) ? null : ms
}

export function hhmm(t) {
  if (!t) return '—'
  return String(t).slice(0, 5)
}

export function staleColors(gapMin) {
  if (gapMin == null) return { bg: '#f1f5f9', fg: '#94a3b8' } // sin data
  if (gapMin > STALE_BAD_MIN) return { bg: '#fee2e2', fg: '#991b1b' }
  if (gapMin > STALE_WARN_MIN) return { bg: '#fef9c3', fg: '#854d0e' }
  return { bg: '#dcfce7', fg: '#166534' }
}

// Pivotea filas de bot_coverage_recent en { city → { bracket → row } }
export function pivotByCity(rows) {
  const byCity = {}
  for (const r of rows || []) {
    if (!r?.city || !r?.distance_bracket) continue
    ;(byCity[r.city] ||= {})[r.distance_bracket] = r
  }
  return byCity
}

// Resumen de estado para el semáforo del dashboard: cuenta celdas atrasadas
// (rojo/amarillo) según su atraso relativo al bracket más fresco de su ciudad.
export function computeCoverageStatus(rows) {
  const byCity = pivotByCity(rows)
  let red = 0,
    amber = 0,
    ok = 0
  for (const city of Object.keys(byCity)) {
    const cityRows = byCity[city]
    const instants = BRACKETS.map((b) => cellInstant(cityRows[b])).filter((x) => x != null)
    const cityRef = instants.length ? Math.max(...instants) : null
    for (const b of BRACKETS) {
      const inst = cellInstant(cityRows[b])
      if (inst == null || cityRef == null) continue
      const gap = Math.round((cityRef - inst) / 60000)
      if (gap > STALE_BAD_MIN) red++
      else if (gap > STALE_WARN_MIN) amber++
      else ok++
    }
  }
  const level = red > 0 ? 'bad' : amber > 0 ? 'warn' : 'ok'
  return { red, amber, ok, level, cities: Object.keys(byCity).length }
}
