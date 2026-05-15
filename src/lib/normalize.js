// ════════════════════════════════════════════════════════════════════════
// String normalization helpers
//
// Centraliza las distintas variantes de toLowerCase().replace() repartidas
// por el codebase. Antes había ~6 implementaciones ligeramente distintas:
//   - `String(x).toLowerCase().replace(/\s+/g, '_')`
//   - `String(x).toLowerCase().replace(/[\s-]+/g, '_')`
//   - `.normalize('NFD').replace(/\p{Mn}/gu, '')`
// Causaba bugs sutiles cuando dos partes del sistema "normalizaban" de
// forma distinta (ej: 'Lima-Norte' → 'lima_norte' en un lado y 'lima-norte'
// en otro).
// ════════════════════════════════════════════════════════════════════════

/**
 * Convierte a snake_case (lowercase + spaces/dashes → underscores).
 * Útil para distance_bracket, sheet names, etc.
 *   "Very Long"      → "very_long"
 *   "Zona-Centro"    → "zona_centro"
 *   "Spaces  And-dashes" → "spaces_and_dashes"
 */
export function toSnakeCase(input) {
  if (input == null) return ''
  return String(input).trim().toLowerCase().replace(/[\s-]+/g, '_')
}

/**
 * Quita acentos/diacríticos (Combining Marks unicode U+0300..U+036F).
 * No cambia case ni espacios.
 *   "Bogotá"  → "Bogota"
 *   "São Paulo" → "Sao Paulo"
 *   "नेपाल"   → "नेपाल"  (devanagari no usa combining marks → unchanged)
 */
export function stripAccents(input) {
  if (input == null) return ''
  return String(input).normalize('NFD').replace(/\p{Mn}/gu, '')
}

/**
 * Combinación canónica para keys de DB: sin acentos + snake_case.
 *   "Bogotá Norte" → "bogota_norte"
 *   "Lima-Aeropuerto" → "lima_aeropuerto"
 *
 * Usado por el wizard para auto-sugerir dbName/botKey desde uiName.
 */
export function toDbKey(input) {
  return toSnakeCase(stripAccents(input))
}

/**
 * Normaliza un distance_bracket a una forma canónica.
 *   "Very Short" → "very_short"
 *   "  Long  "   → "long"
 *
 * Si pasaste algo no-string o vacío, devuelve null para que el caller
 * pueda decidir si dropear la fila.
 */
export function normalizeBracket(input) {
  if (input == null) return null
  const s = toSnakeCase(input)
  return s || null
}

/**
 * Compara dos strings ignorando case y acentos. Útil para matches de
 * usuario (city, category) que pueden venir con typos de encoding.
 *   ciEqual('Bogotá', 'bogota') → true
 *   ciEqual('Lima', 'lima')     → true
 */
export function ciEqual(a, b) {
  if (a == null || b == null) return false
  return stripAccents(String(a)).toLowerCase() === stripAccents(String(b)).toLowerCase()
}
