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
  return String(input)
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
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
  return String(input)
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
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
  uber: 'Uber',
  yango: 'Yango',
  didi: 'Didi',
  indrive: 'InDrive',
  cabify: 'Cabify',
}

// Aliases válidos sólo para city='Corp'. Las claves son la versión
// "fingerprint" (lowercase + sin espacios). El valor es el canónico
// PEGADO sin espacios — convención adoptada tras feedback del product
// owner (2026-05-19): el Excel original ya viene con nombres pegados,
// normalizar a la misma forma elimina transformaciones intermedias y
// previene el bug histórico de Premier/Comfort+ aplastados a 'Yango'.
//
// Para mostrar "Yango Premier" con espacio en la UI, usar
// prettyCompetitor() — separa storage canónico de presentación.
const CORP_ALIAS_FINGERPRINTS = {
  yangoeconomy: 'YangoEconomy',
  yangocomfort: 'YangoComfort',
  'yangocomfort+': 'YangoComfort+',
  yangocomfortplus: 'YangoComfort+',
  // Mig 97 (2026-05-27): stakeholder confirma que YangoPlus es producto
  // independiente, NO alias de Comfort+. Ahora se preserva su identidad.
  yangoplus: 'YangoPlus',
  yangopremier: 'YangoPremier',
  yangoxl: 'YangoXL',
  cabifylite: 'CabifyLite',
  cabifyextracomfort: 'CabifyExtraComfort',
  cabifyxl: 'CabifyXL',
}

// Mapeo inverso: canónico pegado → display con espacios. Sólo para
// renderizado (headers, leyendas, tooltips, PDF). NUNCA persistir.
const CORP_DISPLAY_NAMES = {
  YangoEconomy: 'Yango Economy',
  YangoComfort: 'Yango Comfort',
  'YangoComfort+': 'Yango Comfort+',
  YangoPremier: 'Yango Premier',
  YangoXL: 'Yango XL',
  YangoPlus: 'Yango Plus',
  Cabify: 'Cabify',
  CabifyLite: 'Cabify Lite',
  CabifyExtraComfort: 'Cabify Extra Comfort',
  CabifyXL: 'Cabify XL',
}

/**
 * Convierte un nombre canónico de competidor (pegado: 'YangoEconomy',
 * 'CabifyLite') a su versión display con espacios ('Yango Economy',
 * 'Cabify Lite'). Si el nombre ya viene con espacios o no está en el
 * mapa, lo devuelve tal cual.
 *
 * Usar SOLO para render. NUNCA para storage o comparación interna —
 * comparar contra el canónico pegado siempre.
 *
 * Ejemplos:
 *   prettyCompetitor('YangoEconomy') === 'Yango Economy'
 *   prettyCompetitor('Cabify')       === 'Cabify'         // no cambia
 *   prettyCompetitor('Uber')         === 'Uber'           // no cambia
 *   prettyCompetitor(null)           === null
 */
export function prettyCompetitor(comp) {
  if (comp == null) return comp
  return CORP_DISPLAY_NAMES[comp] ?? comp
}

/**
 * Devuelve el "fingerprint" de un nombre: lowercase, sin espacios.
 * Sólo para matching interno — nunca se persiste.
 */
function fingerprint(s) {
  return String(s).toLowerCase().replace(/\s+/g, '').trim()
}

/**
 * ¿Este competition_name es una marca Yango (cualquier sub-marca) o un rival?
 *
 * Espejo EXACTO del predicado que usa la base para armar el lado rival de los
 * agregados (mig 163, `v_yango_rival_diff`):
 *
 *     WHERE v.competition_name !~~* 'Yango%'
 *
 * `!~~*` es `NOT ILIKE`, o sea prefijo 'yango' sin distinguir mayúsculas. Cubre
 * las dos convenciones que conviven en la tabla: la pegada de Economy/Comfort
 * ('YangoComfort', 'YangoPlus', 'YangoXL') y la separada de Corp
 * ('Yango Comfort', 'Yango Premier').
 *
 * POR QUÉ EXISTE, en una línea: el cliente comparaba contra `compareVs` a secas,
 * así que 'YangoComfort' entraba al promedio de la competencia, al ranking y al
 * "líder de mercado" — Yango compitiendo contra sí misma. La base nunca lo hizo;
 * la divergencia era solo del lado del dashboard.
 *
 * OJO: esto NO reemplaza a `compareVs`. Un usuario puede elegir deliberadamente
 * a Uber como base de comparación, y en ese caso las marcas Yango sí son sus
 * rivales. Ver `rivalsOf()`.
 *
 *   isYangoBrand('Yango')          === true
 *   isYangoBrand('YangoComfort')   === true
 *   isYangoBrand('Yango Comfort')  === true
 *   isYangoBrand('yangoplus')      === true
 *   isYangoBrand('Uber')           === false
 *   isYangoBrand(null)             === false
 */
export function isYangoBrand(comp) {
  if (comp == null) return false
  return String(comp).trim().toLowerCase().startsWith('yango')
}

/**
 * El set rival de una base de comparación, con el mismo criterio que la base.
 *
 * Si la base es una marca Yango, ninguna otra marca Yango es rival (es la misma
 * empresa). Si la base es un competidor real, se excluye solo a sí misma — un
 * análisis "Uber vs el resto" sí tiene que ver a Yango del otro lado.
 *
 *   rivalsOf(['Yango','YangoComfort','Uber','Didi'], 'Yango') → ['Uber','Didi']
 *   rivalsOf(['Yango','YangoComfort','Uber','Didi'], 'Uber')  → ['Yango','YangoComfort','Didi']
 */
export function rivalsOf(competitors, base) {
  if (!Array.isArray(competitors)) return []
  const baseEsYango = isYangoBrand(base)
  return competitors.filter((c) => c !== base && !(baseEsYango && isYangoBrand(c)))
}

/**
 * Normaliza competition_name a forma canónica. Idempotente y tolerante
 * a variantes (case, espacios). Es CONTEXT-AWARE por city: los alias de
 * sub-marca (fingerprint sin espacios → forma pegada 'YangoComfort') solo
 * se aplican en city='Corp', que es donde históricamente entraron con
 * espacio. Fuera de Corp no se toca nada que no sea casing universal, para
 * no reescribir data legítima desconocida. Para tablas de configuración
 * (comisiones, bonos, bandas), donde el nombre tiene que matchear
 * pricing_observations sin importar la ciudad, usar canonicalCompetitorName.
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

/**
 * Forma canónica de un nombre de competidor SIN contexto de ciudad — para
 * tablas de configuración (competitor_commissions, competitor_bonuses,
 * competitive_bands) cuyo nombre se usa como clave contra
 * pricing_observations.competition_name en cualquier ciudad.
 *
 * Aplica siempre el diccionario de sub-marcas (la forma pegada es la
 * canónica en TODA la base desde mig 72/96: 'Yango Comfort' → 'YangoComfort').
 * Es el espejo JS del trigger normalize_config_competitor_name (mig 239).
 *
 *   canonicalCompetitorName('Yango Comfort')  === 'YangoComfort'
 *   canonicalCompetitorName('yango premier')  === 'YangoPremier'
 *   canonicalCompetitorName('YangoComfort')   === 'YangoComfort'
 *   canonicalCompetitorName('uber')           === 'Uber'
 *   canonicalCompetitorName('Picap')          === 'Picap'
 */
export function canonicalCompetitorName(raw) {
  return normalizeCompetitorName(raw, { city: 'Corp' })
}
