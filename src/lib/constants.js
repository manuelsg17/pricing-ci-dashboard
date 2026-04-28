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
    dbCities: ['Lima', 'Trujillo', 'Arequipa', 'Lima_Airport', 'Trujillo_Airport', 'Arequipa_Airport', 'Corp'],

    categoriesByCity: {
      Lima:     ['Economy/Comfort', 'Comfort+', 'Premier', 'XL', 'TukTuk', 'Aeropuerto', 'Corp'],
      Trujillo: ['Economy/Comfort', 'Comfort+', 'XL', 'Aeropuerto'],
      Arequipa: ['Economy/Comfort', 'Comfort+', 'XL', 'Aeropuerto'],
    },

    // Superset (retrocompatibilidad con consumidores que aún leen el campo plano)
    aeropuertoSubcategories: ['Economy/Comfort', 'Comfort+', 'Premier', 'XL'],
    // Por ciudad: Lima tiene Premier, Trujillo/Arequipa no
    aeropuertoSubcategoriesByCity: {
      Lima:     ['Economy/Comfort', 'Comfort+', 'Premier', 'XL'],
      Trujillo: ['Economy/Comfort', 'Comfort+', 'XL'],
      Arequipa: ['Economy/Comfort', 'Comfort+', 'XL'],
    },

    categoryDbMap: {
      'Lima|||Economy/Comfort':   { dbCity: 'Lima',     dbCategory: 'Economy/Comfort' },
      'Lima|||Comfort+':          { dbCity: 'Lima',     dbCategory: 'Comfort+'        },
      'Lima|||Premier':           { dbCity: 'Lima',     dbCategory: 'Premier'         },
      'Lima|||XL':                { dbCity: 'Lima',     dbCategory: 'XL'              },
      'Lima|||TukTuk':            { dbCity: 'Lima',     dbCategory: 'TukTuk'          },
      'Lima|||Corp':              { dbCity: 'Corp',     dbCategory: 'Corp'            },
      'Lima|||Aeropuerto|||Economy/Comfort': { dbCity: 'Lima_Airport', dbCategory: 'Economy/Comfort' },
      'Lima|||Aeropuerto|||Comfort+':        { dbCity: 'Lima_Airport', dbCategory: 'Comfort+'        },
      'Lima|||Aeropuerto|||Premier':         { dbCity: 'Lima_Airport', dbCategory: 'Premier'         },
      'Lima|||Aeropuerto|||XL':              { dbCity: 'Lima_Airport', dbCategory: 'XL'              },
      'Trujillo|||Economy/Comfort': { dbCity: 'Trujillo', dbCategory: 'Economy/Comfort' },
      'Trujillo|||Comfort+':        { dbCity: 'Trujillo', dbCategory: 'Comfort+'        },
      'Trujillo|||XL':              { dbCity: 'Trujillo', dbCategory: 'XL'              },
      'Trujillo|||Aeropuerto|||Economy/Comfort': { dbCity: 'Trujillo_Airport', dbCategory: 'Economy/Comfort' },
      'Trujillo|||Aeropuerto|||Comfort+':        { dbCity: 'Trujillo_Airport', dbCategory: 'Comfort+'        },
      'Trujillo|||Aeropuerto|||XL':              { dbCity: 'Trujillo_Airport', dbCategory: 'XL'              },
      'Arequipa|||Economy/Comfort': { dbCity: 'Arequipa', dbCategory: 'Economy/Comfort' },
      'Arequipa|||Comfort+':        { dbCity: 'Arequipa', dbCategory: 'Comfort+'        },
      'Arequipa|||XL':              { dbCity: 'Arequipa', dbCategory: 'XL'              },
      'Arequipa|||Aeropuerto|||Economy/Comfort': { dbCity: 'Arequipa_Airport', dbCategory: 'Economy/Comfort' },
      'Arequipa|||Aeropuerto|||Comfort+':        { dbCity: 'Arequipa_Airport', dbCategory: 'Comfort+'        },
      'Arequipa|||Aeropuerto|||XL':              { dbCity: 'Arequipa_Airport', dbCategory: 'XL'              },
    },

    // Orden canónico Perú: Yango, YangoComfort, Uber, Didi, InDrive, Cabify.
    // Mantener este orden en todas las (city, category) — el dashboard usa
    // el array tal cual para renderizar columnas y leyendas.
    competitorsByDbCityCategory: {
      Lima: {
        'Economy/Comfort': ['Yango', 'YangoComfort', 'Uber', 'Didi', 'InDrive', 'Cabify'],
        'Comfort+':        ['Yango', 'Uber', 'InDrive', 'Cabify'],
        Premier:           ['Yango', 'Uber', 'Cabify'],
        XL:                ['Yango', 'Uber', 'InDrive', 'Cabify'],
        TukTuk:            ['Yango', 'Uber'],
      },
      Trujillo: {
        'Economy/Comfort': ['Yango', 'YangoComfort', 'Uber', 'Didi', 'InDrive', 'Cabify'],
        'Comfort+':        ['Yango', 'Uber', 'InDrive', 'Cabify'],
        XL:                ['Yango', 'Uber', 'InDrive', 'Cabify'],
      },
      Arequipa: {
        'Economy/Comfort': ['Yango', 'YangoComfort', 'Uber', 'Didi', 'InDrive', 'Cabify'],
        'Comfort+':        ['Yango', 'Uber', 'InDrive', 'Cabify'],
        XL:                ['Yango', 'Uber', 'InDrive', 'Cabify'],
      },
      Lima_Airport: {
        'Economy/Comfort': ['Yango', 'YangoComfort', 'Uber', 'Didi', 'InDrive', 'Cabify'],
        'Comfort+':        ['Yango', 'Uber', 'InDrive', 'Cabify'],
        Premier:           ['Yango', 'Uber', 'Cabify'],
        XL:                ['Yango', 'Uber', 'InDrive', 'Cabify'],
      },
      Trujillo_Airport: {
        'Economy/Comfort': ['Yango', 'YangoComfort', 'Uber', 'Didi', 'InDrive', 'Cabify'],
        'Comfort+':        ['Yango', 'Uber', 'InDrive', 'Cabify'],
        XL:                ['Yango', 'Uber', 'InDrive', 'Cabify'],
      },
      Arequipa_Airport: {
        'Economy/Comfort': ['Yango', 'YangoComfort', 'Uber', 'Didi', 'InDrive', 'Cabify'],
        'Comfort+':        ['Yango', 'Uber', 'InDrive', 'Cabify'],
        XL:                ['Yango', 'Uber', 'InDrive', 'Cabify'],
      },
      Corp: {
        Corp: ['Yango Economy', 'Yango Comfort', 'Yango Comfort+', 'Yango Premier', 'Yango XL',
               'Cabify', 'Cabify Lite', 'Cabify Extra Comfort', 'Cabify XL'],
      },
    },

    yangoDisplayName: {
      Lima:             { 'Economy/Comfort': 'Yango', 'Comfort+': 'Yango', Premier: 'Yango', XL: 'Yango', TukTuk: 'Yango' },
      Trujillo:         { 'Economy/Comfort': 'Yango', 'Comfort+': 'Yango', XL: 'Yango' },
      Arequipa:         { 'Economy/Comfort': 'Yango', 'Comfort+': 'Yango', XL: 'Yango' },
      Lima_Airport:     { 'Economy/Comfort': 'Yango', 'Comfort+': 'Yango', Premier: 'Yango', XL: 'Yango' },
      Trujillo_Airport: { 'Economy/Comfort': 'Yango', 'Comfort+': 'Yango', XL: 'Yango' },
      Arequipa_Airport: { 'Economy/Comfort': 'Yango', 'Comfort+': 'Yango', XL: 'Yango' },
      Corp:             { Corp: 'Yango Economy' },
    },

    weightCities: ['all', 'Lima', 'Trujillo', 'Arequipa', 'Lima_Airport', 'Trujillo_Airport', 'Arequipa_Airport', 'Corp'],
    outlierThreshold: 100,
    maxPrice: 300,
    botCityMap: {
      'lima':              'Lima',
      'trujillo':          'Trujillo',
      'arequipa':          'Arequipa',
      'lima_airport':      'Lima_Airport',
      'trujillo_airport':  'Trujillo_Airport',
      'arequipa_airport':  'Arequipa_Airport',
    },

    // Reglas del bot → (competition_name, category).
    // Se resuelven contra (app, vehicle_category, observed_vehicle_category).
    // ovc = '*' coincide con cualquier observed_vehicle_category.
    // cities (opcional) restringe la regla a ciertos dbCity (Lima_Airport usa "Airport" implícito).
    botRules: [
      // Economy/Comfort
      { app: 'yango',   vc: 'economy', ovc: 'economy',  name: 'Yango',        category: 'Economy/Comfort' },
      { app: 'yango',   vc: 'comfort', ovc: 'comfort',  name: 'YangoComfort', category: 'Economy/Comfort' },
      { app: 'uber',    vc: 'economy', ovc: 'uberx',    name: 'Uber',         category: 'Economy/Comfort' },
      { app: 'indrive', vc: 'economy', ovc: 'viaje',    name: 'InDrive',      category: 'Economy/Comfort' },
      { app: 'didi',    vc: 'economy', ovc: 'express',  name: 'Didi',         category: 'Economy/Comfort' },
      // Comfort+
      { app: 'yango',   vc: 'comfort', ovc: 'comfort+', name: 'Yango',        category: 'Comfort+' },
      { app: 'uber',    vc: 'comfort', ovc: 'comfort',  name: 'Uber',         category: 'Comfort+' },
      { app: 'indrive', vc: 'comfort', ovc: 'confort',  name: 'InDrive',      category: 'Comfort+' },
      // Premier — solo Lima y Lima_Airport
      { app: 'yango',   vc: 'premium', ovc: 'premier',  name: 'Yango',        category: 'Premier', cities: ['Lima', 'Lima_Airport'] },
      { app: 'uber',    vc: 'premium', ovc: 'black',    name: 'Uber',         category: 'Premier', cities: ['Lima', 'Lima_Airport'] },
      // XL — todas las ciudades (regular + airport)
      { app: 'yango',   vc: 'xl',      ovc: 'xl',       name: 'Yango',        category: 'XL' },
      { app: 'uber',    vc: 'xl',      ovc: 'xl',       name: 'Uber',         category: 'XL' },
      { app: 'indrive', vc: 'xl',      ovc: 'xl',       name: 'InDrive',      category: 'XL' },
      // TukTuk — solo Lima
      { app: 'yango',   vc: 'tuktuk',  ovc: '*',        name: 'Yango',        category: 'TukTuk', cities: ['Lima'] },
      { app: 'uber',    vc: 'tuktuk',  ovc: '*',        name: 'Uber',         category: 'TukTuk', cities: ['Lima'] },
    ],
  },

  Nepal: {
    label:    'Nepal 🇳🇵',
    currency: 'NPR',
    locale:   'ne-NP',

    cities:   ['Kathmandu'],
    dbCities: ['Kathmandu'],

    categoriesByCity: {
      Kathmandu: ['Economy'],
    },

    aeropuertoSubcategories: [],

    categoryDbMap: {
      'Kathmandu|||Economy': { dbCity: 'Kathmandu', dbCategory: 'Economy' },
    },

    competitorsByDbCityCategory: {
      Kathmandu: {
        Economy: ['Yango', 'InDrive'],
      },
    },

    yangoDisplayName: {
      Kathmandu: { Economy: 'Yango' },
    },

    weightCities: ['all', 'Kathmandu'],
    outlierThreshold: 1000,
    maxPrice: 5000,
    botCityMap: {
      'kathmandu': 'Kathmandu',
    },
  },

  Bolivia: {
    label:    'Bolivia 🇧🇴',
    currency: 'BOB',
    locale:   'es-BO',

    cities:   ['Santa Cruz'],
    dbCities: ['Santa Cruz'],

    categoriesByCity: {
      'Santa Cruz': ['Economy'],
    },

    aeropuertoSubcategories: [],

    categoryDbMap: {
      'Santa Cruz|||Economy': { dbCity: 'Santa Cruz', dbCategory: 'Economy' },
    },

    competitorsByDbCityCategory: {
      'Santa Cruz': {
        Economy: ['Yango', 'InDrive'],
      },
    },

    yangoDisplayName: {
      'Santa Cruz': { Economy: 'Yango' },
    },

    weightCities: ['all', 'Santa Cruz'],
    outlierThreshold: 100,
    maxPrice: 500,
    botCityMap: {
      'santa cruz': 'Santa Cruz',
    },
  },

  Venezuela: {
    label:    'Venezuela 🇻🇪',
    currency: 'USD',
    locale:   'es-VE',

    cities:   ['Caracas'],
    dbCities: ['Caracas'],

    categoriesByCity: {
      Caracas: ['Economy'],
    },

    aeropuertoSubcategories: [],

    categoryDbMap: {
      'Caracas|||Economy': { dbCity: 'Caracas', dbCategory: 'Economy' },
    },

    competitorsByDbCityCategory: {
      Caracas: {
        Economy: ['Yango', 'InDrive'],
      },
    },

    yangoDisplayName: {
      Caracas: { Economy: 'Yango' },
    },

    weightCities: ['all', 'Caracas'],
    outlierThreshold: 10,
    maxPrice: 100,
    botCityMap: {
      'caracas': 'Caracas',
    },
  },

  Zambia: {
    label:    'Zambia 🇿🇲',
    currency: 'ZMW',
    locale:   'en-ZM',

    cities:   ['Lusaka'],
    dbCities: ['Lusaka'],

    categoriesByCity: {
      Lusaka: ['Economy'],
    },

    aeropuertoSubcategories: [],

    categoryDbMap: {
      'Lusaka|||Economy': { dbCity: 'Lusaka', dbCategory: 'Economy' },
    },

    competitorsByDbCityCategory: {
      Lusaka: {
        Economy: ['Yango', 'InDrive'],
      },
    },

    yangoDisplayName: {
      Lusaka: { Economy: 'Yango' },
    },

    weightCities: ['all', 'Lusaka'],
    outlierThreshold: 100,
    maxPrice: 1000,
    botCityMap: {
      'lusaka': 'Lusaka',
    },
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
    outlierThreshold: 300000,
    maxPrice: 1000000,
    botCityMap: {
      'bogota': 'Bogotá',
      'bogotá': 'Bogotá',
      'medellin': 'Medellín',
      'medellín': 'Medellín',
      'cali': 'Cali'
    }
  },
}

export const CITY_DISPLAY_NAMES = {
  Lima:         'Lima',
  Trujillo:     'Trujillo',
  Arequipa:     'Arequipa',
  Airport:      'Aeropuerto',
  Corp:         'Corp',
  'Bogotá':     'Bogotá',
  'Medellín':   'Medellín',
  'Cali':       'Cali',
  Kathmandu:    'Kathmandu',
  'Santa Cruz': 'Santa Cruz',
  Caracas:      'Caracas',
  Lusaka:       'Lusaka',
}

export function getCityLabel(dbCity) {
  return CITY_DISPLAY_NAMES[dbCity] || dbCity
}

export const COUNTRIES = Object.keys(COUNTRY_CONFIG)

// ISO-3166 alpha-2 codes — usado para banderas SVG (flagcdn.com)
export const COUNTRY_ISO = {
  Peru:      'pe',
  Colombia:  'co',
  Nepal:     'np',
  Bolivia:   'bo',
  Venezuela: 'vg',  // flagcdn usa 've' pero reasignamos abajo
  Zambia:    'zm',
}
// Fix: Venezuela = 've' (el 'vg' de arriba es British Virgin Islands — error)
COUNTRY_ISO.Venezuela = 've'

export const COUNTRY_NATIVE_LABEL = {
  Peru:      'Perú',
  Colombia:  'Colombia',
  Nepal:     'Nepal',
  Bolivia:   'Bolivia',
  Venezuela: 'Venezuela',
  Zambia:    'Zambia',
}

export function getCountryIso(country) {
  return COUNTRY_ISO[country] || 'pe'
}

export function getCountryNativeLabel(country) {
  return COUNTRY_NATIVE_LABEL[country] || country
}

// ── Helper functions ──────────────────────────────────────
export function getCountryConfig(country) {
  return COUNTRY_CONFIG[country] || COUNTRY_CONFIG.Peru
}

/**
 * Converts a country_config DB row (from Supabase) into the same shape
 * as a COUNTRY_CONFIG entry. Called synchronously from CountryContext.
 */
export function dbConfigToInternal(row) {
  const cities = row.cities || []

  const uiCities = cities.filter(c => !c.isVirtual).map(c => c.uiName)
  const dbCities = cities.map(c => c.dbName)

  const categoriesByCity = {}
  cities.filter(c => !c.isVirtual).forEach(c => {
    categoriesByCity[c.uiName] = (c.categories || []).map(cat => cat.name)
  })

  const categoryDbMap = {}
  cities.filter(c => !c.isVirtual).forEach(city => {
    ;(city.categories || []).forEach(cat => {
      categoryDbMap[`${city.uiName}|||${cat.name}`] = {
        dbCity: city.dbName,
        dbCategory: cat.dbName,
      }
    })
  })

  const competitorsByDbCityCategory = {}
  cities.forEach(city => {
    competitorsByDbCityCategory[city.dbName] = {}
    ;(city.categories || []).forEach(cat => {
      competitorsByDbCityCategory[city.dbName][cat.dbName] = cat.competitors || []
    })
  })

  const yangoDisplayName = {}
  cities.forEach(city => {
    yangoDisplayName[city.dbName] = {}
    ;(city.categories || []).forEach(cat => {
      yangoDisplayName[city.dbName][cat.dbName] = cat.yangoDisplayName || 'Yango'
    })
  })

  const botCityMap = {}
  cities.forEach(city => {
    const key = city.botKey || city.dbName.toLowerCase()
    botCityMap[key] = city.dbName
  })

  return {
    label:                        row.label,
    currency:                     row.currency  || 'USD',
    locale:                       row.locale    || 'en-US',
    cities:                       uiCities,
    dbCities,
    categoriesByCity,
    aeropuertoSubcategories:      [],
    categoryDbMap,
    competitorsByDbCityCategory,
    yangoDisplayName,
    weightCities:                 ['all', ...dbCities],
    outlierThreshold:             Number(row.outlier_threshold ?? 100),
    maxPrice:                     Number(row.max_price ?? 1000),
    botCityMap,
  }
}

export function resolveDbParams(uiCity, uiCategory, subCategory, country) {
  const config = getCountryConfig(country)
  if (uiCategory === 'Aeropuerto' && subCategory) {
    const key = `${uiCity}|||${uiCategory}|||${subCategory}`
    return config.categoryDbMap[key] || { dbCity: 'Airport', dbCategory: subCategory }
  }
  const key = `${uiCity}|||${uiCategory}`
  return config.categoryDbMap[key] || { dbCity: uiCity, dbCategory: uiCategory }
}

export function getCompetitors(uiCity, uiCategory, subCategory, country) {
  const config = getCountryConfig(country)
  const { dbCity, dbCategory } = resolveDbParams(uiCity, uiCategory, subCategory, country)
  return config.competitorsByDbCityCategory[dbCity]?.[dbCategory] || []
}

// (End of file)
