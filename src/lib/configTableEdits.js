// Lógica pura del hook useConfigTable (src/hooks/useConfigTable.js), sin
// React ni Supabase para poder testearla en Node
// (scripts/test-config-table.mjs). El hook solo la orquesta.

export const NEW_ID_PREFIX = 'new_'
export const isNewId = (id) => String(id).startsWith(NEW_ID_PREFIX)

// Dos clics en el mismo milisegundo daban la misma key con Date.now() solo.
export function makeTempId() {
  return `${NEW_ID_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
}

// Normaliza para comparar "¿el valor tipeado es distinto al de la BD?" sin
// que null/undefined/'' o números vs strings cuenten como cambio.
const norm = (v) => {
  if (v == null) return ''
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

// Filas del servidor + filas nuevas, con `edits` aplicados encima.
export function mergeRows(serverRows, newRows, edits) {
  const all = [...(serverRows || []), ...(newRows || [])]
  return all.map((r) => (edits[r.id] ? { ...r, ...edits[r.id] } : r))
}

// Nuevo mapa de edits tras tipear `val` en (id, field). Si el valor vuelve a
// coincidir con el base, la clave se saca: revertir a mano deja la fila
// limpia (mismo criterio que los clones que comparaban contra `original`).
export function applyEdit(edits, id, field, val, baseValue) {
  const cur = { ...(edits[id] || {}) }
  if (norm(val) === norm(baseValue)) delete cur[field]
  else cur[field] = val
  const next = { ...edits }
  if (Object.keys(cur).length === 0) delete next[id]
  else next[id] = cur
  return next
}

// Tras recargar del servidor, descarta los edits de filas que ya no existen
// (borradas por otra sesión) — nunca los de filas vivas ni los de `new_`.
// Las keys de un objeto son strings; los ids de BD pueden ser numéricos.
export function pruneEdits(edits, serverRows, newRows) {
  const alive = new Set([...(serverRows || []), ...(newRows || [])].map((r) => String(r.id)))
  const next = {}
  for (const [id, e] of Object.entries(edits)) if (alive.has(id)) next[id] = e
  return next
}
