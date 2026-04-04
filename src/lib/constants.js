// ============================================================
// CONSTANTES DEL NEGOCIO
// Basadas en los archivos CSV reales (Dic 2025 – Mar 2026)
// ============================================================

// ── Ciudades (UI) ─────────────────────────────────────
// El usuario ve 3 ciudades. Airport y Corp son categorías de Lima.
export const CITIES = ['Lima', 'Trujillo', 'Arequipa']

// Ciudades a nivel DB (para Upload, Config, queries internas)
export const DB_CITIES = ['Lima', 'Trujillo', 'Arequipa', 'Airport', 'Corp']

// ── Categorías por ciudad (UI) ────────────────────────
export const CATEGORIES_BY_CITY = {
  Lima:     ['Economy', 'Comfort', 'Comfort+/Premier', 'TukTuk', 'XL', 'Aeropuerto', 'Corp'],
  Trujillo: ['Economy', 'Comfort/Comfort+'],
  Arequipa: ['Economy', 'Comfort/Comfort+'],
}

// Sub-categorías cuando se selecciona Aeropuerto
export const AEROPUERTO_SUBCATEGORIES = ['Economy', 'Comfort', 'Comfort+/Premier']

// ── Mapeo UI → DB ─────────────────────────────────────
// Cada combinación UI se traduce a { dbCity, dbCategory } para los RPCs
const CATEGORY_DB_MAP = {
  // Lima directo
  'Lima|||Economy':           { dbCity: 'Lima', dbCategory: 'Economy' },
  'Lima|||Comfort':           { dbCity: 'Lima', dbCategory: 'Comfort' },
  'Lima|||Comfort+/Premier':  { dbCity: 'Lima', dbCategory: 'Premier' },
  'Lima|||TukTuk':            { dbCity: 'Lima', dbCategory: 'TukTuk' },
  'Lima|||XL':                { dbCity: 'Lima', dbCategory: 'XL' },
  'Lima|||Corp':              { dbCity: 'Corp', dbCategory: 'Corp' },
  // Lima > Aeropuerto (necesita subCategory)
  'Lima|||Aeropuerto|||Economy':          { dbCity: 'Airport', dbCategory: 'Economy' },
  'Lima|||Aeropuerto|||Comfort':          { dbCity: 'Airport', dbCategory: 'Comfort' },
  'Lima|||Aeropuerto|||Comfort+/Premier': { dbCity: 'Airport', dbCategory: 'Premier' },
  // Trujillo
  'Trujillo|||Economy':         { dbCity: 'Trujillo', dbCategory: 'Economy' },
  'Trujillo|||Comfort/Comfort+': { dbCity: 'Trujillo', dbCategory: 'Comfort' },
  // Arequipa
  'Arequipa|||Economy':         { dbCity: 'Arequipa', dbCategory: 'Economy' },
  'Arequipa|||Comfort/Comfort+': { dbCity: 'Arequipa', dbCategory: 'Comfort' },
}

/**
 * Resuelve parámetros de UI a parámetros de DB.
 * @param {string} uiCity - 'Lima' | 'Trujillo' | 'Arequipa'
 * @param {string} uiCategory - categoría seleccionada en el dropdown
 * @param {string|null} subCategory - sub-categoría (solo para Aeropuerto)
 * @returns {{ dbCity: string, dbCategory: string }}
 */
export function resolveDbParams(uiCity, uiCategory, subCategory) {
  if (uiCategory === 'Aeropuerto' && subCategory) {
    const key = `${uiCity}|||${uiCategory}|||${subCategory}`
    return CATEGORY_DB_MAP[key] || { dbCity: 'Airport', dbCategory: subCategory }
  }
  const key = `${uiCity}|||${uiCategory}`
  return CATEGORY_DB_MAP[key] || { dbCity: uiCity, dbCategory: uiCategory }
}

// ── Competidores por ciudad+categoría (DB-level) ──────
// Nota: "Premier" en BD = "Comfort+/Premier" en UI (normalizado en Upload)
//       "Comfort" en BD = "Comfort/Comfort+" en UI (normalizado en Upload)
const COMPETITORS_BY_DB_CITY_CATEGORY = {
  Lima: {
    Premier:  ['Yango', 'YangoPremier', 'Uber', 'Cabify'],
    Economy:  ['Yango', 'Uber', 'Didi', 'InDrive', 'Cabify'],
    Comfort:  ['Yango', 'Uber', 'InDrive', 'Cabify'],
    TukTuk:   ['Yango', 'Uber'],
    XL:       ['Yango', 'Uber', 'Didi', 'InDrive', 'Cabify'],
  },
  Trujillo: {
    Economy:  ['Yango', 'Uber', 'InDrive', 'Cabify'],
    Comfort:  ['Yango', 'YangoComfort+', 'Uber', 'InDrive', 'Cabify'],
  },
  Arequipa: {
    Economy:  ['Yango', 'Uber', 'Didi', 'InDrive', 'Cabify'],
    Comfort:  ['Yango', 'YangoComfort+', 'Uber', 'Didi', 'InDrive', 'Cabify'],
  },
  Airport: {
    Comfort:  ['Yango', 'Uber', 'Didi', 'InDrive', 'Cabify'],
    Premier:  ['Yango', 'YangoPremier', 'Uber', 'Didi', 'InDrive', 'Cabify'],
    Economy:  ['Yango', 'Uber', 'Didi', 'InDrive', 'Cabify'],
  },
  Corp: {
    Corp: ['Yango Economy', 'Yango Comfort', 'Yango Comfort+', 'Yango Premier', 'Yango XL',
           'Cabify', 'Cabify Lite', 'Cabify Extra Comfort', 'Cabify XL'],
  },
}

/**
 * Obtiene la lista de competidores para una selección de UI.
 * @param {string} uiCity
 * @param {string} uiCategory
 * @param {string|null} subCategory
 * @returns {string[]}
 */
export function getCompetitors(uiCity, uiCategory, subCategory) {
  const { dbCity, dbCategory } = resolveDbParams(uiCity, uiCategory, subCategory)
  return COMPETITORS_BY_DB_CITY_CATEGORY[dbCity]?.[dbCategory] || []
}

// Nombre mostrado de Yango según contexto
export const YANGO_DISPLAY_NAME = {
  Lima: {
    Premier:  'Yango (Comfort+)',
    Economy:  'Yango',
    Comfort:  'Yango',
    TukTuk:   'Yango',
    XL:       'Yango',
  },
  Trujillo: {
    Economy:  'Yango',
    Comfort:  'Yango (Comfort)',
  },
  Arequipa: {
    Economy:  'Yango',
    Comfort:  'Yango (Comfort)',
  },
  Airport: {
    Comfort:  'Yango',
    Premier:  'Yango (Comfort+)',
    Economy:  'Yango',
  },
  Corp: {
    Corp: 'Yango Economy',
  },
}

// ── Brackets ──────────────────────────────────────────
export const BRACKETS = ['very_short', 'short', 'median', 'average', 'long', 'very_long']

export const BRACKET_LABELS = {
  very_short: 'Very Short',
  short:      'Short',
  median:     'Median',
  average:    'Average',
  long:       'Long',
  very_long:  'Very Long',
}

// Pesos por defecto (se sobreescriben con los de la BD)
export const DEFAULT_WEIGHTS = {
  very_short: 0.0983,
  short:      0.1967,
  median:     0.1939,
  average:    0.1384,
  long:       0.0750,
  very_long:  0.2970,
}

// Colores de competidores para gráficos
export const COMPETITOR_COLORS = {
  Yango:               '#E53935',
  YangoPremier:        '#B71C1C',
  YangoComfort:        '#EF5350',
  'YangoComfort+':     '#FF5722',
  'Yango Economy':     '#E53935',
  'Yango Comfort':     '#EF9A9A',
  'Yango Comfort+':    '#FF5722',
  'Yango Premier':     '#B71C1C',
  'Yango XL':          '#D32F2F',
  Uber:                '#276EF1',  // Azul Uber (visible en fondo claro y oscuro)
  Didi:                '#FF6D00',
  InDrive:             '#2E7D32',
  Cabify:              '#7B1FA2',
  'Cabify Lite':       '#AB47BC',
  'Cabify Extra Comfort': '#6A1B9A',
  'Cabify XL':         '#4A148C',
}

// Ciudades con configuración de pesos independiente (DB-level)
export const WEIGHT_CITIES = ['all', 'Lima', 'Trujillo', 'Arequipa', 'Airport', 'Corp']
