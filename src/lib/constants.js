// ============================================================
// CONSTANTES DEL NEGOCIO
// Basadas en los archivos CSV reales (Dic 2025 – Mar 2026)
// ============================================================

// Lima, Trujillo, Arequipa, Airport = CI regular
// Corp = análisis corporativo (Yango vs Cabify en segmento corporativo)
export const CITIES = ['Lima', 'Trujillo', 'Arequipa', 'Airport', 'Corp']

export const CATEGORIES_BY_CITY = {
  Lima:     ['Premier', 'Economy', 'Comfort', 'TukTuk', 'XL'],
  Trujillo: ['Economy', 'Comfort'],
  Arequipa: ['Economy', 'Comfort'],
  Airport:  ['Comfort', 'Premier', 'Economy'],
  Corp:     ['Corp'],
}

// Competidores reales por ciudad+categoría (extraídos de los CSV)
// Nota: "Premier" en BD = "Comfort+/Premier" en CSV (normalizado en Upload)
//       "Comfort" en BD = "Comfort/Comfort+" en CSV (normalizado en Upload)
export const COMPETITORS_BY_CITY_CATEGORY = {
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

// Brackets en orden
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
  Uber:                '#000000',
  Didi:                '#FF6D00',
  InDrive:             '#2E7D32',
  Cabify:              '#7B1FA2',
  'Cabify Lite':       '#AB47BC',
  'Cabify Extra Comfort': '#6A1B9A',
  'Cabify XL':         '#4A148C',
}

// Ciudades con configuración de pesos independiente
export const WEIGHT_CITIES = ['all', 'Lima', 'Trujillo', 'Arequipa', 'Airport', 'Corp']
