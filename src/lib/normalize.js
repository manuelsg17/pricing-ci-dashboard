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

// ════════════════════════════════════════════════════════════════════════
// normalizeCompetitorName — única fuente de verdad para competition_name
// en pricing_observations.
//
// La ingesta llegó por varios canales históricamente (Excel manual, bot,
// data entry) y cada uno emite un sub-dialecto distinto: 'uber' vs 'Uber',
// 'YangoEconomy' vs 'Yango Economy'. Esa heterogeneidad rompe el lookup
// por city/category en el dashboard (ver competitorsByDbCityCategory en
// constants.js — espera nombres canónicos exactos).
//
// La normalización tiene que ser CONTEXT-AWARE por city porque para
// city='Corp' (categoría B2B en Perú) el canónico usa nombres con espacios
// ('Yango Comfort', 'Cabify Extra Comfort') mientras que en el resto de
// las categorías ('Economy/Comfort', 'Comfort+', etc.) el canónico es
// pegado ('YangoComfort'). Aplicar el mapeo Corp fuera de Corp rompería
// data legítima.
// ════════════════════════════════════════════════════════════════════════

// Casing universal — se aplica en TODA city. Acá viven sólo nombres que
// son inequívocos (no chocan con sub-variantes). 'yango' → 'Yango' es OK
// porque el canónico de Yango en Economy/Comfort es 'Yango'; las variantes
// como 'YangoComfort' nunca llegan en minúsculas a este diccionario.
const UNIVERSAL_CASING = {
  uber:    'Uber',
  yango:   'Yango',
  didi:    'Didi',
  indrive: 'InDrive',
  cabify:  'Cabify',
}

// Aliases válidos sólo para city='Corp'. Las claves son la versión
// "fingerprint" (lowercase + sin espacios) para tolerar todas las
// variantes de input. Si agregás un destino nuevo, sumá fingerprints
// de TODAS las variantes plausibles (con/sin espacio, +/plus).
const CORP_ALIAS_FINGERPRINTS = {
  // Yango — Corp usa nombres con espacios; el bot/Excel mandó pegado
  yangoeconomy:           'Yango Economy',
  yangocomfort:           'Yango Comfort',
  'yangocomfort+':        'Yango Comfort+',
  yangocomfortplus:       'Yango Comfort+',
  yangoplus:              'Yango Comfort+',   // HIPÓTESIS — ver TODO abajo
  yangopremier:           'Yango Premier',
  yangoxl:                'Yango XL',
  // Cabify — mismas variantes
  cabifylite:             'Cabify Lite',
  cabifyextracomfort:     'Cabify Extra Comfort',
  cabifyxl:               'Cabify XL',
  // TODO(stakeholder): confirmar que 'YangoPlus' representa Yango Comfort+
  // (y no Yango Premier). Tenemos ~102 filas con ese valor en Perú/Corp;
  // por convención de naming "Plus" suele significar Comfort+ pero hay
  // riesgo de que sea Premier. Validar con product owner antes de cerrar.
}

/**
 * Devuelve el "fingerprint" de un nombre: lowercase, sin espacios.
 * Sólo para matching interno — nunca se persiste.
 */
function fingerprint(s) {
  return String(s).toLowerCase().replace(/\s+/g, '').trim()
}

/**
 * Normaliza competition_name a forma canónica. Idempotente y tolerante
 * a variantes (case, espacios). Es CONTEXT-AWARE por city porque en
 * city='Corp' la convención canónica usa nombres con espacios
 * ('Yango Comfort', 'Cabify Extra Comfort'), mientras que en el resto
 * de categorías el canónico es pegado ('YangoComfort').
 *
 * Es la ÚNICA fuente de verdad para qué string termina en
 * pricing_observations.competition_name. Llamar SIEMPRE antes de INSERT.
 *
 * Ejemplos:
 *   normalizeCompetitorName('uber') === 'Uber'
 *   normalizeCompetitorName('yangoeconomy', { city: 'Corp' }) === 'Yango Economy'
 *   normalizeCompetitorName('YangoComfort', { city: 'Lima' }) === 'YangoComfort'  // no toca
 *   normalizeCompetitorName('YangoComfort', { city: 'Corp' }) === 'Yango Comfort'
 *   normalizeCompetitorName('YangoPlus', { city: 'Corp' }) === 'Yango Comfort+'   // HIPÓTESIS
 */
export function normalizeCompetitorName(raw, { city } = {}) {
  if (raw == null) return raw
  const trimmed = String(raw).trim()
  if (trimmed === '') return trimmed

  // (1) Casing universal — sólo si el lowercase trim matchea exacto.
  // No afecta a sub-variantes como 'YangoComfort' (lowercase 'yangocomfort'
  // ≠ 'yango').
  const lc = trimmed.toLowerCase()
  if (UNIVERSAL_CASING[lc]) return UNIVERSAL_CASING[lc]

  // (2) Corp aliases. Sólo cuando city es exactamente 'Corp' — no podemos
  // tocar 'YangoComfort' en city='Lima' (es un valor legítimo distinto).
  if (city === 'Corp') {
    const fp = fingerprint(trimmed)
    if (CORP_ALIAS_FINGERPRINTS[fp]) return CORP_ALIAS_FINGERPRINTS[fp]
  }

  // (3) Nada matcheó — devolver tal cual. No inventamos canonicalizaciones
  // para evitar regresiones en data legítima desconocida.
  return trimmed === raw ? raw : trimmed
}
