// Conteos puros del formulario de Ingresar CI (sin React). Extraídos de
// DataEntry.jsx (2026-09) tal cual estaban — son la fuente ÚNICA de verdad
// para el pill de progreso, el conteo del borrador restaurado y el escaneo
// de borradores sin terminar; divergencias entre esos tres ya causaron una
// pérdida silenciosa del recomendado de InDrive al restaurar un borrador.

// Cuenta solo celdas con un valor numérico real — una celda tipeada y
// después borrada de nuevo (queda como '' en `entries`) NO cuenta como
// "dato sin guardar".
export function countFilledEntries(entries) {
  return Object.values(entries || {}).filter((v) => v !== '' && !isNaN(parseFloat(v))).length
}

export function hasMeaningfulIndriveExtra(indriveExtra) {
  return Object.values(indriveExtra || {}).some(
    (extra) =>
      (extra?.bids || []).some((b) => b !== '') ||
      (extra?.minBid || '') !== '' ||
      (extra?.rec || '') !== ''
  )
}

// Cuenta TODAS las celdas "llenas": las que tienen número en `entries` + las
// celdas InDrive que solo tienen precio recomendado (viven en indriveExtra, no
// en entries, porque sin bids el promedio queda vacío).
export function countAllFilled(entries, indriveExtra) {
  let n = countFilledEntries(entries)
  for (const [k, ex] of Object.entries(indriveExtra || {})) {
    const recOk = ex?.rec != null && ex.rec !== '' && !isNaN(parseFloat(ex.rec))
    if (!recOk) continue
    const avg = (entries || {})[`${k}|InDrive`]
    const avgOk = avg != null && avg !== '' && !isNaN(parseFloat(avg))
    if (!avgOk) n++ // recomendado sin promedio de bids → no contado por entries
  }
  return n
}

// Timestamp (epoch ms) del `startedAt` más antiguo entre los turnos ya
// estampados, o null si no hay ninguno. Siembra el cronómetro de SESIÓN al
// retomar trabajo en curso — nunca un "ahora" (CLAUDE.md §2; bug real
// 2026-07-24: sesiones de horas registradas como "1 minuto" al reanudar).
export function earliestTurnoStart(timings) {
  if (!timings || typeof timings !== 'object') return null
  let min = null
  for (const t of Object.values(timings)) {
    const raw = t?.startedAt
    if (!raw) continue
    const ms = new Date(raw).getTime()
    if (!Number.isFinite(ms)) continue
    if (min === null || ms < min) min = ms
  }
  return min
}

// Progreso POR TURNO (Mañana/Tarde/Noche). Mismo criterio que countAllFilled
// pero separado por el 3er segmento de la clave (`uiCat|refId|tsLabel|comp`).
export function countFilledByTimeslot(entries, indriveExtra, naKeys, timeslots) {
  const m = {}
  for (const ts of timeslots) m[ts.label] = 0
  for (const [k, v] of Object.entries(entries || {})) {
    if (v === '' || isNaN(parseFloat(v))) continue
    const tsLabel = k.split('|')[2]
    if (tsLabel in m) m[tsLabel]++
  }
  for (const [k, ex] of Object.entries(indriveExtra || {})) {
    const recOk = ex?.rec != null && ex.rec !== '' && !isNaN(parseFloat(ex.rec))
    if (!recOk) continue
    const avg = (entries || {})[`${k}|InDrive`]
    const avgOk = avg != null && avg !== '' && !isNaN(parseFloat(avg))
    if (avgOk) continue // ya contado arriba vía `entries`
    const tsLabel = k.split('|')[2]
    if (tsLabel in m) m[tsLabel]++
  }
  for (const k of naKeys || []) {
    const tsLabel = k.split('|')[2]
    if (tsLabel in m) m[tsLabel]++
  }
  return m
}
