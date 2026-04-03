// ============================================================
// CONSTANTES DEL NEGOCIO
// ============================================================

export const CITIES = ['Lima', 'Trujillo', 'Arequipa', 'Airport']

export const CATEGORIES_BY_CITY = {
  Lima:     ['Premier', 'TukTuk', 'XL', 'Economy', 'Comfort'],
  Trujillo: ['Economy', 'Comfort'],
  Arequipa: ['Economy', 'Comfort'],
  Airport:  ['Comfort', 'Premier'],
}

// Competidores disponibles según ciudad+categoría
// Nota: "YangoPremier" es el nombre normalizado en BD (limpiado desde "Yango premier")
export const COMPETITORS_BY_CITY_CATEGORY = {
  Lima: {
    Economy:  ['Yango', 'Uber', 'Didi', 'InDrive', 'Cabify'],
    Comfort:  ['Yango', 'Uber', 'Didi', 'InDrive', 'Cabify'],
    Premier:  ['Yango', 'YangoPremier', 'Uber', 'Didi', 'InDrive', 'Cabify'],
    TukTuk:   ['Yango', 'Uber'],
    XL:       ['Yango', 'Uber', 'Didi', 'InDrive', 'Cabify'],
  },
  Trujillo: {
    Economy:  ['Yango', 'InDrive'],
    Comfort:  ['Yango', 'YangoComfort+', 'Uber', 'Didi', 'InDrive', 'Cabify'],
  },
  Arequipa: {
    Economy:  ['Yango', 'InDrive'],
    Comfort:  ['Yango', 'YangoComfort+', 'Uber', 'Didi', 'InDrive', 'Cabify'],
  },
  Airport: {
    Comfort:  ['Yango', 'YangoPremier', 'Uber', 'Didi', 'InDrive', 'Cabify'],
    Premier:  ['Yango', 'YangoPremier', 'Uber', 'Didi', 'InDrive', 'Cabify'],
  },
}

// Nombre mostrado de Yango según contexto
export const YANGO_DISPLAY_NAME = {
  Lima: {
    Economy:  'Yango',
    Comfort:  'Yango',
    Premier:  'Yango (Comfort+)',
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
  Yango:        '#E53935',   // rojo
  YangoPremier: '#B71C1C',   // rojo oscuro
  YangoComfort: '#EF5350',   // rojo claro
  'YangoComfort+': '#FF5722',
  Uber:         '#000000',   // negro
  Didi:         '#FF6D00',   // naranja
  InDrive:      '#2E7D32',   // verde
  Cabify:       '#7B1FA2',   // morado
}

// Ciudades con configuración de pesos independiente
export const WEIGHT_CITIES = ['all', 'Lima', 'Trujillo', 'Arequipa', 'Airport']
