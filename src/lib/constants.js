// ============================================================
// CONSTANTES DEL NEGOCIO — Multi-País
// ============================================================

// ── Colores de competidores (globales) ────────────────────
// Convención canónica desde mig 72/96: nombres concat sin espacios para
// Corp ('YangoEconomy', 'CabifyLite', etc.). Las claves con espacios se
// mantienen como retrocompat de pre-mig 72 (legacy reports/PDFs).
export const COMPETITOR_COLORS = {
  Yango: '#E53935',
  // Formato canónico CONCAT (post mig 72) — el que el Dashboard usa hoy
  YangoEconomy: '#E53935',
  YangoComfort: '#EF9A9A',
  'YangoComfort+': '#FF5722',
  YangoPremier: '#B71C1C',
  YangoXL: '#D32F2F',
  YangoPlus: '#C62828', // tono entre Comfort+ y Premier (mig 97)
  CabifyLite: '#AB47BC',
  CabifyExtraComfort: '#6A1B9A',
  CabifyXL: '#4A148C',
  // Formato legacy con espacios — retrocompat para reports/snapshots viejos
  'Yango Economy': '#E53935',
  'Yango Comfort': '#EF9A9A',
  'Yango Comfort+': '#FF5722',
  'Yango Premier': '#B71C1C',
  'Yango XL': '#D32F2F',
  'Cabify Lite': '#AB47BC',
  'Cabify Extra Comfort': '#6A1B9A',
  'Cabify XL': '#4A148C',
  Uber: '#276EF1',
  Didi: '#FF6D00',
  InDrive: '#2E7D32',
  Cabify: '#7B1FA2',
  Beat: '#00B4D8',
  Bolt: '#34D399',
  Rappi: '#FF5B26',
  Picap: '#FB923C', // Colombia/Bike — alinea con catalogs.js
}

// Formas con espacio pre-mig 72: solo para leer reportes/snapshots viejos.
// Nunca se ofrecen en un selector — en BD (mig 239) y en el cliente
// (canonicalCompetitorName) siempre se persiste la forma pegada.
export const LEGACY_SPACE_FORM_COMPETITORS = new Set(
  Object.keys(COMPETITOR_COLORS).filter((k) => k.includes(' '))
)

// Lo que un selector de competidor debe ofrecer: todo lo que tiene color,
// menos las formas legacy con espacio.
export const CANONICAL_COMPETITOR_NAMES = Object.keys(COMPETITOR_COLORS).filter(
  (k) => !LEGACY_SPACE_FORM_COMPETITORS.has(k)
)

// ── Brackets (globales) ───────────────────────────────────
export const BRACKETS = ['very_short', 'short', 'median', 'average', 'long', 'very_long']

export const BRACKET_LABELS = {
  very_short: 'Very Short',
  short: 'Short',
  median: 'Median',
  average: 'Average',
  long: 'Long',
  very_long: 'Very Long',
}

export const DEFAULT_WEIGHTS = {
  very_short: 0.0983,
  short: 0.1967,
  median: 0.1939,
  average: 0.1384,
  long: 0.075,
  very_long: 0.297,
}

// Mismos pesos que DEFAULT_WEIGHTS, en porcentaje (0-100) — la forma que
// espera el editor de pesos del wizard de onboarding de países.
export const DEFAULT_WEIGHTS_PCT = Object.fromEntries(
  Object.entries(DEFAULT_WEIGHTS).map(([bracket, w]) => [bracket, Number((w * 100).toFixed(2))])
)

// ── Presets de moneda (onboarding de países) ───────────────
// Usado por CountryWizard.jsx (alta de país nuevo) y CountriesConfig.jsx
// (edición). Única fuente: antes existían dos copias que podían
// desincronizarse en silencio si se agregaba/ajustaba una moneda en un
// solo lugar.
export const CURRENCY_PRESETS = {
  PEN: { locale: 'es-PE', outlier_threshold: 300, max_price: 1000 },
  COP: { locale: 'es-CO', outlier_threshold: 300000, max_price: 1000000 },
  BOB: { locale: 'es-BO', outlier_threshold: 500, max_price: 2000 },
  VES: { locale: 'es-VE', outlier_threshold: 200, max_price: 1000 },
  NPR: { locale: 'ne-NP', outlier_threshold: 5000, max_price: 20000 },
  ZMW: { locale: 'en-ZM', outlier_threshold: 500, max_price: 2000 },
  USD: { locale: 'en-US', outlier_threshold: 100, max_price: 1000 },
}

// ── Pesos históricos REALES de Perú (fijados en código) ────
// Snapshot inmediato ANTES del parche de emergencia 16.6% (recuperado del
// audit_log, 2026-07-07). El histórico de Perú (semanas <= 2026-W24, hasta el
// 8-jun) usa ESTOS pesos — NO la tabla bracket_weights de la BD — para que un
// futuro edit accidental de los pesos ya no pueda malograr los números
// presentados. Desde 2026-W25 (15-jun) el WA pasa a promedio simple (ver
// SIMPLE_AVG_SINCE en algorithms/weightedAverage.js), donde los pesos no aplican.
// Orden por bracket: [very_short, short, median, average, long, very_long].
// OJO: Lima/Arequipa/Trujillo tenían pesos CUSTOM (no los DEFAULT_WEIGHTS); los
// aeropuertos, curvas propias. `all` y `Corp` sí coincidían con los canónicos.
const PE_LEGACY_BY_CITY = {
  all: [0.0983, 0.1967, 0.1939, 0.1384, 0.075, 0.297],
  Corp: [0.0983, 0.1967, 0.1939, 0.1384, 0.075, 0.297],
  Lima: [0.0975, 0.2043, 0.1952, 0.133, 0.085, 0.285],
  Arequipa: [0.1003, 0.186, 0.2118, 0.0861, 0.1158, 0.2236],
  Trujillo: [0.1003, 0.186, 0.2118, 0.0861, 0.1158, 0.2236],
  Airport: [0.0666, 0.1221, 0.2222, 0, 0.5891, 0],
  Lima_Airport_A: [0.0666, 0.1221, 0.2222, 0, 0.5891, 0],
  Lima_Airport_B: [0.0666, 0.1221, 0.2222, 0, 0.5891, 0],
  Arequipa_Airport_A: [0.1003, 0.186, 0.2118, 0.0861, 0.1158, 0.3],
  Arequipa_Airport_B: [0.1003, 0.186, 0.2118, 0.0861, 0, 0.3336],
  Trujillo_Airport_A: [0.1003, 0.186, 0.2118, 0.0861, 0.4058, 0],
  Trujillo_Airport_B: [0.1003, 0.186, 0.2118, 0, 0, 0.4136],
}

// Forma consumible por buildWeightsMap: filas { city, category, bracket, weight }.
export const LEGACY_WEIGHTS_PE = Object.entries(PE_LEGACY_BY_CITY).flatMap(([city, w]) =>
  BRACKETS.map((bracket, i) => ({ city, category: 'all', bracket, weight: w[i] }))
)

// ── Configuración por País ────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────
// COUNTRY_CONFIG es un FALLBACK, no la fuente de verdad: la config real vive
// en la tabla `country_config` (mig 79+) y llega vía CountryContext.dbConfigs.
// Un bloque acá solo se usa cuando la tabla no está disponible (arranque
// offline, primer render sin cache) o cuando el país NO existe en la tabla.
//
// Qué se mantiene y por qué (auditoría frontend 2026-09-04):
//   · Peru: fallback de arranque de toda la app (getCountryConfig cae acá).
//   · Colombia y Bolivia: scripts/test-getcountryconfig.mjs asserta que
//     existen en la constante ("país conocido sin dbConfigs").
//   · Venezuela y Zambia: NO existen en country_config; si se borran de acá
//     desaparecen del selector (COUNTRIES) y CountriesConfig no puede
//     promocionarlos a la BD. Decisión de producto, no de código.
//   · Nepal: eliminado — en PROD country_config.status='active' (verificado
//     2026-09-04; la mig 129 lo sembró como 'draft' y alguien lo activó
//     después), así que CountryContext lo lista desde la BD y el bloque
//     hardcodeado estaba muerto. Si algún día vuelve a 'draft', desaparece
//     del selector: ese es el acoplamiento a vigilar.
// Las claves de este objeto también alimentan COUNTRIES (orden del selector),
// así que borrar un país acá cambia la UI aunque exista en la BD.
// ─────────────────────────────────────────────────────────────────────────
export const COUNTRY_CONFIG = {
  Peru: {
    label: 'Perú 🇵🇪',
    currency: 'S/',
    locale: 'es-PE',
    timezone: 'America/Lima',

    // Fallback estático (solo se usa si DB falla). Mantenemos sincronizado
    // con country_config.cities en DB (mig 79 + 84 + 85). Source-of-truth
    // real = DB; este bloque está para que la app no se rompa offline.
    cities: [
      'Lima',
      'Trujillo',
      'Arequipa',
      'Lima_Airport_A',
      'Lima_Airport_B',
      'Trujillo_Airport_A',
      'Trujillo_Airport_B',
      'Arequipa_Airport_A',
      'Arequipa_Airport_B',
      'Corp',
    ],
    dbCities: [
      'Lima',
      'Trujillo',
      'Arequipa',
      'Lima_Airport_A',
      'Lima_Airport_B',
      'Trujillo_Airport_A',
      'Trujillo_Airport_B',
      'Arequipa_Airport_A',
      'Arequipa_Airport_B',
      'Corp',
    ],

    categoriesByCity: {
      Lima: ['Economy/Comfort', 'Comfort+', 'Premier', 'XL', 'TukTuk', 'Corp'],
      Trujillo: ['Economy/Comfort', 'Comfort+', 'XL'],
      Arequipa: ['Economy/Comfort', 'Comfort+', 'XL'],
      Lima_Airport_A: ['Economy/Comfort', 'Comfort+', 'Premier', 'XL'],
      Lima_Airport_B: ['Economy/Comfort', 'Comfort+', 'Premier', 'XL'],
      Trujillo_Airport_A: ['Economy/Comfort', 'Comfort+', 'XL'],
      Trujillo_Airport_B: ['Economy/Comfort', 'Comfort+', 'XL'],
      Arequipa_Airport_A: ['Economy/Comfort', 'Comfort+', 'XL'],
      Arequipa_Airport_B: ['Economy/Comfort', 'Comfort+', 'XL'],
      Corp: ['Corp'],
    },

    // categoryDbMap: clave "uiName|||categoryName" → {dbCity, dbCategory}.
    // Post mig 79+84+85 los airport cities son top-level (no más subtab
    // "Aeropuerto" anidado bajo Lima/Trujillo/Arequipa).
    categoryDbMap: {
      'Lima|||Economy/Comfort': { dbCity: 'Lima', dbCategory: 'Economy/Comfort' },
      'Lima|||Comfort+': { dbCity: 'Lima', dbCategory: 'Comfort+' },
      'Lima|||Premier': { dbCity: 'Lima', dbCategory: 'Premier' },
      'Lima|||XL': { dbCity: 'Lima', dbCategory: 'XL' },
      'Lima|||TukTuk': { dbCity: 'Lima', dbCategory: 'TukTuk' },
      'Lima|||Corp': { dbCity: 'Corp', dbCategory: 'Corp' },
      'Trujillo|||Economy/Comfort': { dbCity: 'Trujillo', dbCategory: 'Economy/Comfort' },
      'Trujillo|||Comfort+': { dbCity: 'Trujillo', dbCategory: 'Comfort+' },
      'Trujillo|||XL': { dbCity: 'Trujillo', dbCategory: 'XL' },
      'Arequipa|||Economy/Comfort': { dbCity: 'Arequipa', dbCategory: 'Economy/Comfort' },
      'Arequipa|||Comfort+': { dbCity: 'Arequipa', dbCategory: 'Comfort+' },
      'Arequipa|||XL': { dbCity: 'Arequipa', dbCategory: 'XL' },
      'Lima_Airport_A|||Economy/Comfort': {
        dbCity: 'Lima_Airport_A',
        dbCategory: 'Economy/Comfort',
      },
      'Lima_Airport_A|||Comfort+': { dbCity: 'Lima_Airport_A', dbCategory: 'Comfort+' },
      'Lima_Airport_A|||Premier': { dbCity: 'Lima_Airport_A', dbCategory: 'Premier' },
      'Lima_Airport_A|||XL': { dbCity: 'Lima_Airport_A', dbCategory: 'XL' },
      'Lima_Airport_B|||Economy/Comfort': {
        dbCity: 'Lima_Airport_B',
        dbCategory: 'Economy/Comfort',
      },
      'Lima_Airport_B|||Comfort+': { dbCity: 'Lima_Airport_B', dbCategory: 'Comfort+' },
      'Lima_Airport_B|||Premier': { dbCity: 'Lima_Airport_B', dbCategory: 'Premier' },
      'Lima_Airport_B|||XL': { dbCity: 'Lima_Airport_B', dbCategory: 'XL' },
      'Trujillo_Airport_A|||Economy/Comfort': {
        dbCity: 'Trujillo_Airport_A',
        dbCategory: 'Economy/Comfort',
      },
      'Trujillo_Airport_A|||Comfort+': { dbCity: 'Trujillo_Airport_A', dbCategory: 'Comfort+' },
      'Trujillo_Airport_A|||XL': { dbCity: 'Trujillo_Airport_A', dbCategory: 'XL' },
      'Trujillo_Airport_B|||Economy/Comfort': {
        dbCity: 'Trujillo_Airport_B',
        dbCategory: 'Economy/Comfort',
      },
      'Trujillo_Airport_B|||Comfort+': { dbCity: 'Trujillo_Airport_B', dbCategory: 'Comfort+' },
      'Trujillo_Airport_B|||XL': { dbCity: 'Trujillo_Airport_B', dbCategory: 'XL' },
      'Arequipa_Airport_A|||Economy/Comfort': {
        dbCity: 'Arequipa_Airport_A',
        dbCategory: 'Economy/Comfort',
      },
      'Arequipa_Airport_A|||Comfort+': { dbCity: 'Arequipa_Airport_A', dbCategory: 'Comfort+' },
      'Arequipa_Airport_A|||XL': { dbCity: 'Arequipa_Airport_A', dbCategory: 'XL' },
      'Arequipa_Airport_B|||Economy/Comfort': {
        dbCity: 'Arequipa_Airport_B',
        dbCategory: 'Economy/Comfort',
      },
      'Arequipa_Airport_B|||Comfort+': { dbCity: 'Arequipa_Airport_B', dbCategory: 'Comfort+' },
      'Arequipa_Airport_B|||XL': { dbCity: 'Arequipa_Airport_B', dbCategory: 'XL' },
      'Corp|||Corp': { dbCity: 'Corp', dbCategory: 'Corp' },
    },

    // Orden canónico Perú: Yango, YangoComfort, Uber, Didi, InDrive, Cabify.
    // Mantener este orden en todas las (city, category) — el dashboard usa
    // el array tal cual para renderizar columnas y leyendas.
    competitorsByDbCityCategory: {
      Lima: {
        'Economy/Comfort': ['Yango', 'YangoComfort', 'Uber', 'Didi', 'InDrive', 'Cabify'],
        'Comfort+': ['Yango', 'Uber', 'InDrive', 'Cabify'],
        Premier: ['Yango', 'Uber', 'Cabify'],
        XL: ['Yango', 'Uber', 'InDrive', 'Cabify'],
        TukTuk: ['Yango', 'Uber', 'InDrive'],
      },
      Trujillo: {
        'Economy/Comfort': ['Yango', 'YangoComfort', 'Uber', 'Didi', 'InDrive', 'Cabify'],
        'Comfort+': ['Yango', 'Uber', 'InDrive', 'Cabify'],
        XL: ['Yango', 'Uber', 'InDrive', 'Cabify'],
      },
      Arequipa: {
        'Economy/Comfort': ['Yango', 'YangoComfort', 'Uber', 'Didi', 'InDrive', 'Cabify'],
        'Comfort+': ['Yango', 'Uber', 'InDrive', 'Cabify'],
        XL: ['Yango', 'Uber', 'InDrive', 'Cabify'],
      },
      Lima_Airport_A: {
        'Economy/Comfort': ['Yango', 'YangoComfort', 'Uber', 'Didi', 'InDrive', 'Cabify'],
        'Comfort+': ['Yango', 'Uber', 'InDrive', 'Cabify'],
        Premier: ['Yango', 'Uber', 'Cabify'],
        XL: ['Yango', 'Uber', 'InDrive', 'Cabify'],
      },
      Lima_Airport_B: {
        'Economy/Comfort': ['Yango', 'YangoComfort', 'Uber', 'Didi', 'InDrive', 'Cabify'],
        'Comfort+': ['Yango', 'Uber', 'InDrive', 'Cabify'],
        Premier: ['Yango', 'Uber', 'Cabify'],
        XL: ['Yango', 'Uber', 'InDrive', 'Cabify'],
      },
      Trujillo_Airport_A: {
        'Economy/Comfort': ['Yango', 'YangoComfort', 'Uber', 'Didi', 'InDrive', 'Cabify'],
        'Comfort+': ['Yango', 'Uber', 'InDrive', 'Cabify'],
        XL: ['Yango', 'Uber', 'InDrive', 'Cabify'],
      },
      Trujillo_Airport_B: {
        'Economy/Comfort': ['Yango', 'YangoComfort', 'Uber', 'Didi', 'InDrive', 'Cabify'],
        'Comfort+': ['Yango', 'Uber', 'InDrive', 'Cabify'],
        XL: ['Yango', 'Uber', 'InDrive', 'Cabify'],
      },
      Arequipa_Airport_A: {
        'Economy/Comfort': ['Yango', 'YangoComfort', 'Uber', 'Didi', 'InDrive', 'Cabify'],
        'Comfort+': ['Yango', 'Uber', 'InDrive', 'Cabify'],
        XL: ['Yango', 'Uber', 'InDrive', 'Cabify'],
      },
      Arequipa_Airport_B: {
        'Economy/Comfort': ['Yango', 'YangoComfort', 'Uber', 'Didi', 'InDrive', 'Cabify'],
        'Comfort+': ['Yango', 'Uber', 'InDrive', 'Cabify'],
        XL: ['Yango', 'Uber', 'InDrive', 'Cabify'],
      },
      Corp: {
        // Pegados sin espacio: matchea exactamente la columna "Competition
        // Name" del Excel original. Antes usábamos versiones con espacios
        // ("Yango Premier") como canónico, lo que requería normalizar en el
        // cliente Y en el trigger DB — fragilidad innecesaria que generó el
        // bug de Premier/Comfort+ aplastados a 'Yango'. Para display con
        // espacios en la UI, usar prettyCompetitor() de src/lib/normalize.js.
        Corp: [
          'YangoEconomy',
          'YangoComfort',
          'YangoComfort+',
          'YangoPremier',
          'YangoXL',
          'YangoPlus',
          'Cabify',
          'CabifyLite',
          'CabifyExtraComfort',
          'CabifyXL',
        ],
      },
    },

    yangoDisplayName: {
      Lima: {
        'Economy/Comfort': 'Yango',
        'Comfort+': 'Yango',
        Premier: 'Yango',
        XL: 'Yango',
        TukTuk: 'Yango',
      },
      Trujillo: { 'Economy/Comfort': 'Yango', 'Comfort+': 'Yango', XL: 'Yango' },
      Arequipa: { 'Economy/Comfort': 'Yango', 'Comfort+': 'Yango', XL: 'Yango' },
      Lima_Airport_A: {
        'Economy/Comfort': 'Yango',
        'Comfort+': 'Yango',
        Premier: 'Yango',
        XL: 'Yango',
      },
      Lima_Airport_B: {
        'Economy/Comfort': 'Yango',
        'Comfort+': 'Yango',
        Premier: 'Yango',
        XL: 'Yango',
      },
      Trujillo_Airport_A: { 'Economy/Comfort': 'Yango', 'Comfort+': 'Yango', XL: 'Yango' },
      Trujillo_Airport_B: { 'Economy/Comfort': 'Yango', 'Comfort+': 'Yango', XL: 'Yango' },
      Arequipa_Airport_A: { 'Economy/Comfort': 'Yango', 'Comfort+': 'Yango', XL: 'Yango' },
      Arequipa_Airport_B: { 'Economy/Comfort': 'Yango', 'Comfort+': 'Yango', XL: 'Yango' },
      Corp: { Corp: 'YangoEconomy' },
    },

    weightCities: [
      'all',
      'Lima',
      'Trujillo',
      'Arequipa',
      'Lima_Airport_A',
      'Lima_Airport_B',
      'Trujillo_Airport_A',
      'Trujillo_Airport_B',
      'Arequipa_Airport_A',
      'Arequipa_Airport_B',
      'Corp',
    ],
    outlierThreshold: 100,
    maxPrice: 300,
    botCityMap: {
      lima: 'Lima',
      trujillo: 'Trujillo',
      arequipa: 'Arequipa',
      lima_airport_a: 'Lima_Airport_A',
      lima_airport_b: 'Lima_Airport_B',
      trujillo_airport_a: 'Trujillo_Airport_A',
      trujillo_airport_b: 'Trujillo_Airport_B',
      arequipa_airport_a: 'Arequipa_Airport_A',
      arequipa_airport_b: 'Arequipa_Airport_B',
    },

    // Reglas del bot → (competition_name, category).
    // Se resuelven contra (app, vehicle_category, observed_vehicle_category).
    // ovc = '*' coincide con cualquier observed_vehicle_category.
    // cities (opcional) restringe la regla a ciertos dbCity (incluye splits *_Airport_A/B).
    botRules: [
      // Economy/Comfort
      { app: 'yango', vc: 'economy', ovc: 'economy', name: 'Yango', category: 'Economy/Comfort' },
      {
        app: 'yango',
        vc: 'comfort',
        ovc: 'comfort',
        name: 'YangoComfort',
        category: 'Economy/Comfort',
      },
      { app: 'uber', vc: 'economy', ovc: 'uberx', name: 'Uber', category: 'Economy/Comfort' },
      { app: 'indrive', vc: 'economy', ovc: 'viaje', name: 'InDrive', category: 'Economy/Comfort' },
      { app: 'didi', vc: 'economy', ovc: 'express', name: 'Didi', category: 'Economy/Comfort' },
      // Comfort+
      { app: 'yango', vc: 'comfort', ovc: 'comfort+', name: 'Yango', category: 'Comfort+' },
      { app: 'uber', vc: 'comfort', ovc: 'comfort', name: 'Uber', category: 'Comfort+' },
      { app: 'indrive', vc: 'comfort', ovc: 'confort', name: 'InDrive', category: 'Comfort+' },
      // Premier — solo Lima y splits del aeropuerto de Lima
      {
        app: 'yango',
        vc: 'premium',
        ovc: 'premier',
        name: 'Yango',
        category: 'Premier',
        cities: ['Lima', 'Lima_Airport_A', 'Lima_Airport_B'],
      },
      {
        app: 'uber',
        vc: 'premium',
        ovc: 'black',
        name: 'Uber',
        category: 'Premier',
        cities: ['Lima', 'Lima_Airport_A', 'Lima_Airport_B'],
      },
      // XL — todas las ciudades (regular + airport)
      { app: 'yango', vc: 'xl', ovc: 'xl', name: 'Yango', category: 'XL' },
      { app: 'uber', vc: 'xl', ovc: 'xl', name: 'Uber', category: 'XL' },
      { app: 'indrive', vc: 'xl', ovc: 'xl', name: 'InDrive', category: 'XL' },
      // TukTuk — solo Lima
      { app: 'yango', vc: 'tuktuk', ovc: '*', name: 'Yango', category: 'TukTuk', cities: ['Lima'] },
      { app: 'uber', vc: 'tuktuk', ovc: '*', name: 'Uber', category: 'TukTuk', cities: ['Lima'] },
    ],
  },

  Bolivia: {
    label: 'Bolivia 🇧🇴',
    currency: 'BOB',
    locale: 'es-BO',
    timezone: 'America/La_Paz',

    cities: ['Santa Cruz'],
    dbCities: ['Santa Cruz'],

    categoriesByCity: {
      'Santa Cruz': ['Economy'],
    },

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
    label: 'Venezuela 🇻🇪',
    currency: 'USD',
    locale: 'es-VE',
    timezone: 'UTC',

    cities: ['Caracas'],
    dbCities: ['Caracas'],

    categoriesByCity: {
      Caracas: ['Economy'],
    },

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
      caracas: 'Caracas',
    },
  },

  Zambia: {
    label: 'Zambia 🇿🇲',
    currency: 'ZMW',
    locale: 'en-ZM',
    timezone: 'UTC',

    cities: ['Lusaka'],
    dbCities: ['Lusaka'],

    categoriesByCity: {
      Lusaka: ['Economy'],
    },

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
      lusaka: 'Lusaka',
    },
  },

  Colombia: {
    label: 'Colombia 🇨🇴',
    currency: 'COP',
    locale: 'es-CO',
    timezone: 'America/Bogota',

    // Estructura real (mayo 2026): Bogotá, Cali, Barranquilla.
    // dbCities sin tilde para matchear el normalize del bot (helioho.st
    // emite city sin acento; ver supabase/38_sync_bot_quotes_fn.sql CASE).
    cities: ['Bogotá', 'Cali', 'Barranquilla'],
    dbCities: ['Bogota', 'Cali', 'Barranquilla'],

    categoriesByCity: {
      Bogotá: ['Economy', 'Bike', 'Comfort'],
      Cali: ['Economy', 'Bike', 'Comfort'],
      Barranquilla: ['Economy', 'Bike', 'Comfort'],
    },

    categoryDbMap: {
      'Bogotá|||Economy': { dbCity: 'Bogota', dbCategory: 'Economy' },
      'Bogotá|||Bike': { dbCity: 'Bogota', dbCategory: 'Bike' },
      'Bogotá|||Comfort': { dbCity: 'Bogota', dbCategory: 'Comfort' },
      'Cali|||Economy': { dbCity: 'Cali', dbCategory: 'Economy' },
      'Cali|||Bike': { dbCity: 'Cali', dbCategory: 'Bike' },
      'Cali|||Comfort': { dbCity: 'Cali', dbCategory: 'Comfort' },
      'Barranquilla|||Economy': { dbCity: 'Barranquilla', dbCategory: 'Economy' },
      'Barranquilla|||Bike': { dbCity: 'Barranquilla', dbCategory: 'Bike' },
      'Barranquilla|||Comfort': { dbCity: 'Barranquilla', dbCategory: 'Comfort' },
    },

    // Picap solo aparece en Bike (es app moto-only colombiana).
    competitorsByDbCityCategory: {
      Bogota: {
        Economy: ['Yango', 'Didi', 'InDrive', 'Uber'],
        Bike: ['Yango', 'Didi', 'InDrive', 'Picap'],
        Comfort: ['Yango', 'Didi', 'InDrive', 'Uber'],
      },
      Cali: {
        Economy: ['Yango', 'Didi', 'InDrive', 'Uber'],
        Bike: ['Yango', 'Didi', 'InDrive', 'Picap'],
        Comfort: ['Yango', 'Didi', 'InDrive', 'Uber'],
      },
      Barranquilla: {
        Economy: ['Yango', 'Didi', 'InDrive', 'Uber'],
        Bike: ['Yango', 'Didi', 'InDrive', 'Picap'],
        Comfort: ['Yango', 'Didi', 'InDrive', 'Uber'],
      },
    },

    yangoDisplayName: {
      Bogota: { Economy: 'Yango', Bike: 'Yango', Comfort: 'Yango' },
      Cali: { Economy: 'Yango', Bike: 'Yango', Comfort: 'Yango' },
      Barranquilla: { Economy: 'Yango', Bike: 'Yango', Comfort: 'Yango' },
    },

    weightCities: ['all', 'Bogota', 'Cali', 'Barranquilla'],
    outlierThreshold: 300000,
    maxPrice: 1000000,
    botCityMap: {
      bogota: 'Bogota',
      bogotá: 'Bogota',
      cali: 'Cali',
      barranquilla: 'Barranquilla',
      baq: 'Barranquilla',
    },
    botRules: [
      // Economy
      { app: 'yango', vc: 'economy', ovc: 'economy', name: 'Yango', category: 'Economy' },
      { app: 'yango_api', vc: 'economy', ovc: 'economy', name: 'Yango', category: 'Economy' },
      { app: 'uber', vc: 'economy', ovc: 'uberx', name: 'Uber', category: 'Economy' },
      { app: 'uber', vc: 'economy', ovc: 'uber_x', name: 'Uber', category: 'Economy' },
      { app: 'uber', vc: 'economy', ovc: '*', name: 'Uber', category: 'Economy' },
      { app: 'didi', vc: 'economy', ovc: 'express', name: 'Didi', category: 'Economy' },
      { app: 'didi', vc: 'economy', ovc: 'economy', name: 'Didi', category: 'Economy' },
      { app: 'indrive', vc: 'economy', ovc: 'viaje', name: 'InDrive', category: 'Economy' },
      // Comfort
      { app: 'yango', vc: 'comfort', ovc: 'comfort', name: 'Yango', category: 'Comfort' },
      { app: 'yango_api', vc: 'comfort', ovc: 'comfort', name: 'Yango', category: 'Comfort' },
      { app: 'uber', vc: 'comfort', ovc: 'comfort', name: 'Uber', category: 'Comfort' },
      { app: 'didi', vc: 'comfort', ovc: '*', name: 'Didi', category: 'Comfort' },
      { app: 'indrive', vc: 'comfort', ovc: 'confort', name: 'InDrive', category: 'Comfort' },
      { app: 'indrive', vc: 'comfort', ovc: 'comfort', name: 'InDrive', category: 'Comfort' },
      // Bike (sin Uber — Uber no opera moto en Colombia. Picap es moto-only.)
      { app: 'yango', vc: 'moto', ovc: '*', name: 'Yango', category: 'Bike' },
      { app: 'yango', vc: 'yango_moto', ovc: '*', name: 'Yango', category: 'Bike' },
      { app: 'yango', vc: 'bike', ovc: '*', name: 'Yango', category: 'Bike' },
      { app: 'yango_api', vc: 'moto', ovc: '*', name: 'Yango', category: 'Bike' },
      { app: 'yango_api', vc: 'yango_moto', ovc: '*', name: 'Yango', category: 'Bike' },
      { app: 'yango_api', vc: 'bike', ovc: '*', name: 'Yango', category: 'Bike' },
      { app: 'didi', vc: 'moto', ovc: '*', name: 'Didi', category: 'Bike' },
      { app: 'indrive', vc: 'moto', ovc: '*', name: 'InDrive', category: 'Bike' },
      { app: 'indrive', vc: 'bike', ovc: '*', name: 'InDrive', category: 'Bike' },
      { app: 'picap', vc: 'moto', ovc: '*', name: 'Picap', category: 'Bike' },
      { app: 'picap', vc: 'moto_a', ovc: '*', name: 'Picap', category: 'Bike' },
      { app: 'picap', vc: 'moto_b', ovc: '*', name: 'Picap', category: 'Bike' },
      { app: 'picap', vc: 'bike', ovc: '*', name: 'Picap', category: 'Bike' },
    ],
  },
}

export const CITY_DISPLAY_NAMES = {
  Lima: 'Lima',
  Trujillo: 'Trujillo',
  Arequipa: 'Arequipa',
  Corp: 'Corp',
  Bogotá: 'Bogotá',
  Medellín: 'Medellín',
  Cali: 'Cali',
  Kathmandu: 'Kathmandu',
  'Santa Cruz': 'Santa Cruz',
  Caracas: 'Caracas',
  Lusaka: 'Lusaka',
}

export function getCityLabel(dbCity) {
  return CITY_DISPLAY_NAMES[dbCity] || dbCity
}

// Orden explícito de países en el selector del topbar.
// Peru y Colombia primero (mercados principales en la presentación LATAM),
// el resto en orden alfabético. Países nuevos creados via wizard (DB-only)
// se agregan al final via availableCountries en CountryContext.
const PREFERRED_ORDER = ['Peru', 'Colombia']
const _allKeys = Object.keys(COUNTRY_CONFIG)
export const COUNTRIES = [
  ...PREFERRED_ORDER.filter((c) => _allKeys.includes(c)),
  ..._allKeys.filter((c) => !PREFERRED_ORDER.includes(c)).sort((a, b) => a.localeCompare(b)),
]

// ISO-3166 alpha-2 codes — usado para banderas SVG (flagcdn.com)
export const COUNTRY_ISO = {
  Peru: 'pe',
  Colombia: 'co',
  Nepal: 'np',
  Bolivia: 'bo',
  Venezuela: 'vg', // flagcdn usa 've' pero reasignamos abajo
  Zambia: 'zm',
}
// Fix: Venezuela = 've' (el 'vg' de arriba es British Virgin Islands — error)
COUNTRY_ISO.Venezuela = 've'

export function getCountryIso(country) {
  return COUNTRY_ISO[country] || 'pe'
}

// ── Helper functions ──────────────────────────────────────
//
// dbConfigs (opcional) toma precedencia sobre el hardcoded. Si el país
// no existe en ninguno, cae a Peru con warning visible — antes era
// fallback silencioso a Peru, que ocultaba bugs (usuario veía data de
// Peru bajo el header de otro país).
//
// Callers nuevos deberían pasar dbConfigs desde `useCountry()` para
// que los overrides editados en /config se reflejen inmediatamente.
const _warned = new Set()
export function getCountryConfig(country, dbConfigs = null) {
  if (dbConfigs && dbConfigs[country]) return dbConfigs[country]
  if (COUNTRY_CONFIG[country]) return COUNTRY_CONFIG[country]
  // No encontrado — warning una sola vez por país
  if (country && !_warned.has(country)) {
    _warned.add(country)
    // eslint-disable-next-line no-console
    console.warn(
      `[getCountryConfig] País "${country}" no encontrado ni en DB ni en constants.js. Usando Peru como fallback — esto indica un bug.`
    )
  }
  return COUNTRY_CONFIG.Peru
}

/**
 * Converts a country_config DB row (from Supabase) into the same shape
 * as a COUNTRY_CONFIG entry. Called synchronously from CountryContext.
 */
export function dbConfigToInternal(row) {
  const cities = row.cities || []

  const uiCities = cities.filter((c) => !c.isVirtual).map((c) => c.uiName)
  const dbCities = cities.map((c) => c.dbName)

  const categoriesByCity = {}
  cities
    .filter((c) => !c.isVirtual)
    .forEach((c) => {
      categoriesByCity[c.uiName] = (c.categories || []).map((cat) => cat.name)
    })

  const categoryDbMap = {}
  cities
    .filter((c) => !c.isVirtual)
    .forEach((city) => {
      ;(city.categories || []).forEach((cat) => {
        categoryDbMap[`${city.uiName}|||${cat.name}`] = {
          dbCity: city.dbName,
          dbCategory: cat.dbName,
        }
      })
    })

  const competitorsByDbCityCategory = {}
  // Competidores que NO ofrecen esa categoría (típico aeropuerto) → se ocultan
  // SOLO en "Ingresar CI" (getCiCompetitors), pero siguen en `competitors` para
  // el dashboard/leyendas/histórico. Lista paralela para no cambiar el shape de
  // `competitors`. Default [] = todos ofrecen (retrocompatible).
  const ciHiddenByDbCityCategory = {}
  // Notas libres por competidor dentro de una categoría — caso real: Cabify
  // tuvo XL en Lima_Airport_A hasta el 27-jul y dejó de actualizarse (sigue
  // vivo en Lima_Airport_B). El competidor SIGUE listado (no es ciHidden, no
  // se oculta de nada) — esto es solo texto explicativo para que la leyenda
  // del dashboard aclare "no es un error" en vez de dejar la celda vacía sin
  // contexto. Default {} = sin nota (retrocompatible).
  const competitorNotesByDbCityCategory = {}
  cities.forEach((city) => {
    competitorsByDbCityCategory[city.dbName] = {}
    ciHiddenByDbCityCategory[city.dbName] = {}
    competitorNotesByDbCityCategory[city.dbName] = {}
    ;(city.categories || []).forEach((cat) => {
      competitorsByDbCityCategory[city.dbName][cat.dbName] = cat.competitors || []
      ciHiddenByDbCityCategory[city.dbName][cat.dbName] = Array.isArray(cat.ciHidden)
        ? cat.ciHidden
        : []
      competitorNotesByDbCityCategory[city.dbName][cat.dbName] =
        cat.competitorNotes && typeof cat.competitorNotes === 'object' ? cat.competitorNotes : {}
    })
  })

  const yangoDisplayName = {}
  cities.forEach((city) => {
    yangoDisplayName[city.dbName] = {}
    ;(city.categories || []).forEach((cat) => {
      yangoDisplayName[city.dbName][cat.dbName] = cat.yangoDisplayName || 'Yango'
    })
  })

  const botCityMap = {}
  cities.forEach((city) => {
    const key = city.botKey || city.dbName.toLowerCase()
    botCityMap[key] = city.dbName
  })

  // Mig 58: botRules persistido en row JSONB. Si la migración no se aplicó,
  // viene undefined y caemos a [] sin romper.
  const botRules = Array.isArray(row.bot_rules) ? row.bot_rules : []

  return {
    label: row.label,
    currency: row.currency || 'USD',
    locale: row.locale || 'en-US',
    // Zona horaria IANA (mig 183). Sin esto, "hoy" se calcula con la hora del
    // navegador/servidor: a las 22:11 de Lima ya son las 03:11 UTC del día
    // siguiente, y una tarea que vence HOY aparece como vencida. Bug real,
    // detectado corriendo la app — el fallback a UTC no alcanza.
    timezone: row.timezone || 'UTC',
    iso2: row.iso2 || null,
    nativeLabel: row.native_label || row.label,
    status: row.status || 'active',
    cities: uiCities,
    dbCities,
    categoriesByCity,
    categoryDbMap,
    competitorsByDbCityCategory,
    ciHiddenByDbCityCategory,
    competitorNotesByDbCityCategory,
    yangoDisplayName,
    weightCities: ['all', ...dbCities],
    outlierThreshold: Number(row.outlier_threshold ?? 100),
    maxPrice: Number(row.max_price ?? 1000),
    // Días de anticipación con los que una tarea se marca "en riesgo" en
    // Proyectos y en Monitoreo (mig 216). Estaba clavado en 2 en el cliente;
    // PROYECTOS_DESIGN.md §7 lo pedía configurable desde el principio.
    projectsRiskDays: Number(row.projects_risk_days ?? 2),
    botCityMap,
    botRules,
  }
}

// IMPORTANTE: el parámetro `dbConfigs` (opcional) se pasa desde
// componentes que tienen acceso a useCountry().dbConfigs. Sin él, países
// onboardeados vía wizard (que viven SOLO en DB) caen al fallback de Peru
// hardcoded → datos completamente equivocados. Mantener compatibilidad:
// si no se pasa, se preserva el comportamiento legacy.
export function resolveDbParams(uiCity, uiCategory, subCategory, country, dbConfigs = null) {
  const config = getCountryConfig(country, dbConfigs)
  const key = `${uiCity}|||${uiCategory}`
  return config.categoryDbMap[key] || { dbCity: uiCity, dbCategory: uiCategory }
}

export function getCompetitors(uiCity, uiCategory, subCategory, country, dbConfigs = null) {
  const config = getCountryConfig(country, dbConfigs)
  const { dbCity, dbCategory } = resolveDbParams(
    uiCity,
    uiCategory,
    subCategory,
    country,
    dbConfigs
  )
  return config.competitorsByDbCityCategory[dbCity]?.[dbCategory] || []
}

// Competidores a MOSTRAR en "Ingresar CI": igual que getCompetitors pero sin los
// marcados "no ofrece" (ciHidden) para esa ciudad×categoría. Se usa SOLO en la
// grilla de carga (y su validación/conteo/guardado); el dashboard/histórico
// siguen usando getCompetitors (lista completa). Si no hay ciHidden configurado
// devuelve la lista completa (retrocompatible).
export function getCiCompetitors(uiCity, uiCategory, subCategory, country, dbConfigs = null) {
  const config = getCountryConfig(country, dbConfigs)
  const { dbCity, dbCategory } = resolveDbParams(
    uiCity,
    uiCategory,
    subCategory,
    country,
    dbConfigs
  )
  const all = config.competitorsByDbCityCategory[dbCity]?.[dbCategory] || []
  const hidden = config.ciHiddenByDbCityCategory?.[dbCity]?.[dbCategory]
  if (!hidden || hidden.length === 0) return all
  const hiddenSet = new Set(hidden)
  return all.filter((c) => !hiddenSet.has(c))
}

// Devuelve el label específico que Yango usa para una ciudad/categoría dada.
// Recibe dbCity/dbCategory porque los matrices del dashboard ya operan en
// espacio DB. Si no hay override configurado devuelve 'Yango'.
export function getYangoDisplayName(country, dbCity, dbCategory) {
  if (!country || !dbCity || !dbCategory) return 'Yango'
  const config = getCountryConfig(country)
  return config?.yangoDisplayName?.[dbCity]?.[dbCategory] || 'Yango'
}

// Etiqueta ESTABLE del turno (mig 148, DataEntry.jsx — Ingresar CI) a partir
// de la hora CANÓNICA del timeslot (nunca de la hora real de captura) —
// replica los mismos cortes que get_time_of_day() en
// supabase/42_time_of_day_filter.sql, así que si algún día se reconfigura
// un turno en CITimeslotsConfig, esto sigue derivando bien sin tocar
// código. Va a la columna `pricing_observations.timeslot` (ya usada por
// Upload.jsx con estos mismos valores en inglés).
export function timeslotLabel(hhmm) {
  if (!hhmm) return null
  if (hhmm >= '18:00') return 'Evening'
  if (hhmm >= '14:00') return 'Afternoon'
  if (hhmm >= '12:00') return 'Midday'
  if (hhmm >= '06:00') return 'Morning'
  return 'Early_morning'
}

// (End of file)
