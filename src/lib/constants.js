// ============================================================
// CONSTANTES DEL NEGOCIO — Multi-País
// ============================================================

// ── Colores de competidores (globales) ────────────────────
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
  Uber:                '#276EF1',
  Didi:                '#FF6D00',
  InDrive:             '#2E7D32',
  Cabify:              '#7B1FA2',
  'Cabify Lite':       '#AB47BC',
  'Cabify Extra Comfort': '#6A1B9A',
  'Cabify XL':         '#4A148C',
  Beat:                '#00B4D8',
  Bolt:                '#34D399',
  Rappi:               '#FF5B26',
}

// ── Brackets (globales) ───────────────────────────────────
export const BRACKETS = ['very_short', 'short', 'median', 'average', 'long', 'very_long']

export const BRACKET_LABELS = {
  very_short: 'Very Short',
  short:      'Short',
  median:     'Median',
  average:    'Average',
  long:       'Long',
  very_long:  'Very Long',
}

export const DEFAULT_WEIGHTS = {
  very_short: 0.0983,
  short:      0.1967,
  median:     0.1939,
  average:    0.1384,
  long:       0.0750,
  very_long:  0.2970,
}

// ── Configuración por País ────────────────────────────────
export const COUNTRY_CONFIG = {
  Peru: {
    label:    'Perú 🇵🇪',
    currency: 'S/',
    locale:   'es-PE',

    cities:   ['Lima', 'Trujillo', 'Arequipa'],
    dbCities: ['Lima', 'Trujillo', 'Arequipa', 'Airport', 'Corp'],

    categoriesByCity: {
      Lima:     ['Economy', 'Comfort', 'Comfort+/Premier', 'TukTuk', 'XL', 'Aeropuerto', 'Corp'],
      Trujillo: ['Economy', 'Comfort/Comfort+'],
      Arequipa: ['Economy', 'Comfort/Comfort+', 'XL'],
    },

    aeropuertoSubcategories: ['Economy', 'Comfort', 'Comfort+/Premier'],

    categoryDbMap: {
      'Lima|||Economy':           { dbCity: 'Lima',     dbCategory: 'Economy' },
      'Lima|||Comfort':           { dbCity: 'Lima',     dbCategory: 'Comfort' },
      'Lima|||Comfort+/Premier':  { dbCity: 'Lima',     dbCategory: 'Premier' },
      'Lima|||TukTuk':            { dbCity: 'Lima',     dbCategory: 'TukTuk'  },
      'Lima|||XL':                { dbCity: 'Lima',     dbCategory: 'XL'      },
      'Lima|||Corp':              { dbCity: 'Corp',     dbCategory: 'Corp'    },
      'Lima|||Aeropuerto|||Economy':          { dbCity: 'Airport', dbCategory: 'Economy' },
      'Lima|||Aeropuerto|||Comfort':          { dbCity: 'Airport', dbCategory: 'Comfort' },
      'Lima|||Aeropuerto|||Comfort+/Premier': { dbCity: 'Airport', dbCategory: 'Premier' },
      'Trujillo|||Economy':           { dbCity: 'Trujillo', dbCategory: 'Economy' },
      'Trujillo|||Comfort/Comfort+':  { dbCity: 'Trujillo', dbCategory: 'Comfort' },
      'Arequipa|||Economy':           { dbCity: 'Arequipa', dbCategory: 'Economy' },
      'Arequipa|||Comfort/Comfort+':  { dbCity: 'Arequipa', dbCategory: 'Comfort' },
      'Arequipa|||XL':                { dbCity: 'Arequipa', dbCategory: 'XL' },
    },

    competitorsByDbCityCategory: {
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
        XL:       ['Yango', 'Uber', 'Didi', 'InDrive', 'Cabify'],
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
    },

    yangoDisplayName: {
      Lima:     { Premier: 'Yango (Comfort+)', Economy: 'Yango', Comfort: 'Yango', TukTuk: 'Yango', XL: 'Yango' },
      Trujillo: { Economy: 'Yango', Comfort: 'Yango (Comfort)' },
      Arequipa: { Economy: 'Yango', Comfort: 'Yango (Comfort)', XL: 'Yango' },
      Airport:  { Comfort: 'Yango', Premier: 'Yango (Comfort+)', Economy: 'Yango' },
      Corp:     { Corp: 'Yango Economy' },
    },

    weightCities: ['all', 'Lima', 'Trujillo', 'Arequipa', 'Airport', 'Corp'],
  },

  Colombia: {
    label:    'Colombia 🇨🇴',
    currency: 'COP',
    locale:   'es-CO',

    cities:   ['Bogotá', 'Medellín', 'Cali'],
    dbCities: ['Bogotá', 'Medellín', 'Cali'],

    categoriesByCity: {
      Bogotá:   ['Economy', 'Comfort', 'XL'],
      Medellín: ['Economy', 'Comfort'],
      Cali:     ['Economy'],
    },

    aeropuertoSubcategories: [],

    categoryDbMap: {
      'Bogotá|||Economy':   { dbCity: 'Bogotá',   dbCategory: 'Economy' },
      'Bogotá|||Comfort':   { dbCity: 'Bogotá',   dbCategory: 'Comfort' },
      'Bogotá|||XL':        { dbCity: 'Bogotá',   dbCategory: 'XL'      },
      'Medellín|||Economy': { dbCity: 'Medellín', dbCategory: 'Economy' },
      'Medellín|||Comfort': { dbCity: 'Medellín', dbCategory: 'Comfort' },
      'Cali|||Economy':     { dbCity: 'Cali',     dbCategory: 'Economy' },
    },

    competitorsByDbCityCategory: {
      Bogotá: {
        Economy: ['Yango', 'Uber', 'InDrive', 'Cabify', 'Beat'],
        Comfort: ['Yango', 'Uber', 'InDrive', 'Cabify'],
        XL:      ['Yango', 'Uber', 'InDrive'],
      },
      Medellín: {
        Economy: ['Yango', 'Uber', 'InDrive', 'Cabify', 'Beat'],
        Comfort: ['Yango', 'Uber', 'InDrive'],
      },
      Cali: {
        Economy: ['Yango', 'Uber', 'InDrive', 'Cabify'],
      },
    },

    yangoDisplayName: {
      Bogotá:   { Economy: 'Yango', Comfort: 'Yango', XL: 'Yango' },
      Medellín: { Economy: 'Yango', Comfort: 'Yango' },
      Cali:     { Economy: 'Yango' },
    },

    weightCities: ['all', 'Bogotá', 'Medellín', 'Cali'],
  },
}

export const COUNTRIES = Object.keys(COUNTRY_CONFIG)

// ── Helper functions ──────────────────────────────────────
export function getCountryConfig(country) {
  return COUNTRY_CONFIG[country] || COUNTRY_CONFIG.Peru
}

export function resolveDbParams(uiCity, uiCategory, subCategory, country = 'Peru') {
  const config = getCountryConfig(country)
  if (uiCategory === 'Aeropuerto' && subCategory) {
    const key = `${uiCity}|||${uiCategory}|||${subCategory}`
    return config.categoryDbMap[key] || { dbCity: 'Airport', dbCategory: subCategory }
  }
  const key = `${uiCity}|||${uiCategory}`
  return config.categoryDbMap[key] || { dbCity: uiCity, dbCategory: uiCategory }
}

export function getCompetitors(uiCity, uiCategory, subCategory, country = 'Peru') {
  const config = getCountryConfig(country)
  const { dbCity, dbCategory } = resolveDbParams(uiCity, uiCategory, subCategory, country)
  return config.competitorsByDbCityCategory[dbCity]?.[dbCategory] || []
}

// ── Re-exports for backward compatibility (Peru defaults) ─
export const CITIES                = COUNTRY_CONFIG.Peru.cities
export const DB_CITIES             = COUNTRY_CONFIG.Peru.dbCities
export const CATEGORIES_BY_CITY    = COUNTRY_CONFIG.Peru.categoriesByCity
export const AEROPUERTO_SUBCATEGORIES = COUNTRY_CONFIG.Peru.aeropuertoSubcategories
export const YANGO_DISPLAY_NAME    = COUNTRY_CONFIG.Peru.yangoDisplayName
export const WEIGHT_CITIES         = COUNTRY_CONFIG.Peru.weightCities
