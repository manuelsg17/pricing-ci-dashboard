// ============================================================
// Validación de ventanas horarias (rush_hour_windows, ci_timeslots)
// ============================================================
// Horas como 'HH:MM' (o 'HH:MM:SS' desde Postgres): la comparación de
// strings es válida porque el formato es de ancho fijo. Sin esto, la UI
// aceptaba ventanas 17:00→09:00 y solapes, y el filtro de hora pico
// dejaba de matchear en silencio (auditoría Config 2026-09-03, B12).

const norm = (t) => (t ? String(t).slice(0, 5) : '')

// 'order' si fin ≤ inicio, null si está bien.
export function timeOrderError(start, end) {
  const s = norm(start)
  const e = norm(end)
  if (!s || !e) return 'missing'
  return e <= s ? 'order' : null
}

// Devuelve la primera fila (≠ row) del mismo grupo cuyo rango se solapa con
// `row`, o null. `groupOf(r)` define qué filas compiten entre sí (ej. la
// ciudad; 'all' compite con todas).
export function findOverlap(rows, row, groupOf = () => 'all') {
  const s = norm(row.start_time)
  const e = norm(row.end_time)
  const g = groupOf(row)
  for (const other of rows || []) {
    if (other === row || other.id === row.id) continue
    if (other.is_active === false) continue
    const og = groupOf(other)
    if (g !== 'all' && og !== 'all' && og !== g) continue
    const os = norm(other.start_time)
    const oe = norm(other.end_time)
    if (!os || !oe) continue
    if (s < oe && os < e) return other
  }
  return null
}
