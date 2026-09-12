// Import con extensión explícita para que `node scripts/test-catalogs.mjs`
// (Node ESM strict, sin Vite/bundler) pueda resolver el módulo. Vite
// resuelve sin extensión, pero Node puro requiere la extensión.
import { toSnakeCase } from './normalize.js'
import { COMPETITOR_COLORS } from './competitorColors.js'

// Catálogos canónicos — fuente de verdad para dropdowns en /config y wizard
// de nuevo país. Previene typos (Economi → Economy, Indrive → InDrive, etc.).
//
// Diseño:
//   - Hardcoded en JS para que los dropdowns funcionen sin DB
//   - Cada item tiene `aliases` con variantes conocidas para normalización
//   - Tabla DB `catalog_extras` (mig 55) permite agregar overrides por país
//     sin necesidad de redeploy
//
// Fuente: COUNTRY_CONFIG de constants.js + bot_rules SQL + APP_KEY_MAP.
// Cualquier categoría/competidor nuevo que NO esté acá puede agregarse
// vía `Config → Países → + Custom` y queda en `catalog_extras`.

export const CATALOG_CATEGORIES = [
  {
    value: 'Economy',
    label: 'Economy',
    aliases: ['economy', 'economi', 'standard', 'basic', 'classic'],
  },
  {
    value: 'Economy/Comfort',
    label: 'Economy/Comfort',
    aliases: ['economy/comfort', 'economy_comfort', 'eco_comfort'],
  },
  { value: 'Comfort', label: 'Comfort', aliases: ['comfort', 'confort'] },
  {
    value: 'Comfort+',
    label: 'Comfort+',
    aliases: ['comfort+', 'comfort_plus', 'comfortplus', 'comfort_mas'],
  },
  {
    value: 'Premier',
    label: 'Premier',
    aliases: ['premier', 'premium', 'lujo', 'lux', 'business'],
  },
  {
    value: 'Bike',
    label: 'Bike',
    aliases: ['bike', 'moto', 'motorbike', 'motorcycle', 'mototaxi'],
  },
  { value: 'TukTuk', label: 'TukTuk', aliases: ['tuktuk', 'tuk_tuk', 'tuc_tuc', 'autorickshaw'] },
  { value: 'XL', label: 'XL', aliases: ['xl', 'extra_large', 'van', 'minivan', 'group'] },
  { value: 'Corp', label: 'Corp', aliases: ['corp', 'corporativo', 'corporate', 'empresa'] },
  { value: 'Aeropuerto', label: 'Aeropuerto', aliases: ['aeropuerto', 'airport', 'aeroporto'] },
]

// SIN `color` propio a propósito (hasta 2026-09-11 cada entrada tenía el
// suyo, y divergía del real: Uber #1F2937 acá vs #276EF1 en COMPETITOR_COLORS
// de constants.js, que es la paleta que de hecho se pinta en pantalla — el
// mismo patrón de bug ya encontrado y corregido en BracketMix.jsx con
// BRACKET_COLORS). `getCompetitorColor()` abajo lee de COMPETITOR_COLORS.
export const CATALOG_COMPETITORS = [
  {
    value: 'Yango',
    botApps: ['yango', 'yango_api'],
    aliases: ['yango', 'yango_api'],
  },
  {
    value: 'YangoComfort',
    botApps: ['yango'],
    aliases: ['yangocomfort', 'yango_comfort'],
  },
  // Sub-marcas SIEMPRE en forma pegada: es lo que persiste el bot en
  // pricing_observations y lo que exige el trigger de mig 239 en las tablas
  // de configuración. Las formas con espacio quedan solo como alias de entrada.
  {
    value: 'YangoEconomy',
    botApps: ['yango'],
    aliases: ['yango_economy', 'yangoeconomy', 'yango economy'],
  },
  {
    value: 'YangoPremier',
    botApps: ['yango'],
    aliases: ['yango_premier', 'yangopremier', 'yango premier'],
  },
  {
    value: 'YangoComfort+',
    botApps: ['yango'],
    aliases: ['yango_comfort+', 'yango comfort+', 'yangocomfortplus'],
  },
  {
    value: 'YangoPlus',
    botApps: ['yango'],
    aliases: ['yango_plus', 'yangoplus', 'yango plus'],
  },
  {
    value: 'YangoXL',
    botApps: ['yango'],
    aliases: ['yango_xl', 'yangoxl', 'yango xl'],
  },
  { value: 'Uber', botApps: ['uber'], aliases: ['uber'] },
  { value: 'Didi', botApps: ['didi'], aliases: ['didi', 'didi_express'] },
  {
    value: 'InDrive',
    botApps: ['indrive', 'indriver'],
    aliases: ['indrive', 'in_drive', 'indriver'],
  },
  { value: 'Cabify', botApps: ['cabify'], aliases: ['cabify'] },
  {
    value: 'CabifyLite',
    botApps: ['cabify'],
    aliases: ['cabify_lite', 'cabifylite', 'cabify lite'],
  },
  {
    value: 'CabifyExtraComfort',
    botApps: ['cabify'],
    aliases: ['cabify_extra_comfort', 'cabifyextracomfort', 'cabify extra comfort'],
  },
  {
    value: 'CabifyXL',
    botApps: ['cabify'],
    aliases: ['cabify_xl', 'cabifyxl', 'cabify xl'],
  },
  { value: 'Picap', botApps: ['picap'], aliases: ['picap'] },
  { value: 'Beat', botApps: ['beat'], aliases: ['beat'] },
  { value: 'Bolt', botApps: ['bolt'], aliases: ['bolt'] },
  { value: 'Rappi', botApps: ['rappi'], aliases: ['rappi'] },
  // Delivery/Cargo (2026-09): forma canónica sin espacio, mismo criterio que
  // las sub-marcas Yango — el nombre es la clave contra pricing_observations.
  {
    value: 'PedidosYa',
    botApps: ['pedidosya'],
    aliases: ['pedidosya', 'pedidos ya', 'peya', 'pedidos_ya'],
  },
  // Cargo (2026-09): subcategorías por tamaño de vehículo, no un competidor
  // más — cada una es su propia columna en la grilla de Cargo, de más chico
  // a más grande dentro de cada marca (mismo orden en que aparecen acá).
  // `botApps: []` porque el bot no las alimenta (categorías dormant, ver
  // mig 239/242) — solo carga manual del hub.
  {
    value: 'YangoCargoXP',
    botApps: [],
    aliases: ['camion extra pequeño', 'camion extra pequeno', 'yango cargo xp'],
  },
  {
    value: 'YangoCargoPickup',
    botApps: [],
    aliases: ['minivan', 'minivan/pickup', 'yango cargo pickup'],
  },
  {
    value: 'YangoCargoM',
    botApps: [],
    aliases: ['camion mediano', 'yango cargo mediano', 'yango cargo m'],
  },
  {
    value: 'YangoCargoXL',
    botApps: [],
    aliases: ['camion grande', 'yango cargo grande', 'yango cargo xl'],
  },
  {
    value: 'InDriveCargoPickup',
    botApps: [],
    aliases: ['pickup y suv', 'pickup/suv', 'indrive cargo pickup'],
  },
  {
    value: 'InDriveCargoVan',
    botApps: [],
    aliases: ['van', 'indrive cargo van'],
  },
  {
    value: 'InDriveCargoLiviano',
    botApps: [],
    aliases: ['camion liviano', 'indrive cargo liviano'],
  },
  {
    value: 'InDriveCargoGrande',
    botApps: [],
    aliases: ['camion', 'indrive cargo camion', 'indrive cargo grande'],
  },
]

// Subcategorías de Cargo que llevan contraofertas de InDrive (mismo mecanismo
// que la marca InDrive en el resto de la app — 5 bids + recomendado). Ver
// isInDriveVariant() en constants.js, que las trata igual que 'InDrive' a
// secas en cada punto donde la grilla decide si mostrar el campo de bids.
export const INDRIVE_CARGO_VARIANTS = [
  'InDriveCargoPickup',
  'InDriveCargoVan',
  'InDriveCargoLiviano',
  'InDriveCargoGrande',
]

// Competidores que tienen nombre corto/completo separado (subcategorías de
// Cargo — pedido user 2026-09-07, "que los nombres no sean tan largos").
// Las claves de traducción viven en i18n ('competitor.short.<value>' /
// 'competitor.full.<value>') — hasta 2026-09-11 el texto en español vivía
// hardcodeado acá mismo, sin pasar por t() (regla i18n §6 del proyecto).
// Ver getCompetitorShortLabel/getCompetitorFullLabel más abajo.
const COMPETITOR_SHORT_LABEL_KEYS = new Set([
  'YangoCargoXP',
  'YangoCargoPickup',
  'YangoCargoM',
  'YangoCargoXL',
  'InDriveCargoPickup',
  'InDriveCargoVan',
  'InDriveCargoLiviano',
  'InDriveCargoGrande',
])

/**
 * Nombre corto para la columna de la grilla, vía t(). Si el competidor no
 * tiene entrada (no es una subcategoría de Cargo), devuelve su nombre tal
 * cual, como siempre.
 */
export function getCompetitorShortLabel(t, comp) {
  if (COMPETITOR_SHORT_LABEL_KEYS.has(comp)) return t(`competitor.short.${comp}`)
  return comp
}

/**
 * Nombre completo para el tooltip del badge (CompBadge.jsx) — el nombre
 * corto no alcanza para distinguir "Mediano" de "Grande" sin contexto la
 * primera vez que un hub ve la grilla.
 */
export function getCompetitorFullLabel(t, comp) {
  if (COMPETITOR_SHORT_LABEL_KEYS.has(comp)) return t(`competitor.full.${comp}`)
  return null
}

// Lookup mapas — construidos una vez al cargar el módulo
const CATEGORY_BY_ALIAS = (() => {
  const m = new Map()
  for (const c of CATALOG_CATEGORIES) {
    m.set(c.value.toLowerCase(), c.value)
    for (const a of c.aliases) m.set(a.toLowerCase(), c.value)
  }
  return m
})()

const COMPETITOR_BY_ALIAS = (() => {
  const m = new Map()
  for (const c of CATALOG_COMPETITORS) {
    m.set(c.value.toLowerCase(), c.value)
    for (const a of c.aliases) m.set(a.toLowerCase(), c.value)
  }
  return m
})()

/**
 * Devuelve el nombre canónico para una categoría, o null si no se reconoce.
 * Ej: 'economi' → 'Economy', 'tuc_tuc' → 'TukTuk', 'foo' → null.
 */
export function normalizeCategory(input) {
  if (input == null) return null
  return CATEGORY_BY_ALIAS.get(toSnakeCase(input)) || null
}

/**
 * Devuelve el nombre canónico para un competidor, o null si no se reconoce.
 * Ej: 'indrive' → 'InDrive', 'Indrive' → 'InDrive', 'DiDi' → 'Didi'.
 *
 * Nota: NO usa toSnakeCase porque las claves del catálogo conservan espacios
 * (ej: "yango economy"). Solo colapsa whitespace y dashes en underscores.
 */
export function normalizeCompetitor(input) {
  if (input == null) return null
  const key = String(input).trim().toLowerCase().replace(/\s+/g, ' ').replace(/-/g, '_')
  return COMPETITOR_BY_ALIAS.get(key) || null
}

/**
 * Devuelve el color asignado al competidor, con fallback determinístico.
 * Fuente única: COMPETITOR_COLORS (constants.js) — la misma paleta que
 * pinta toda la UI. No mantener un color propio acá (ver comentario sobre
 * CATALOG_COMPETITORS más arriba).
 */
export function getCompetitorColor(name) {
  const canonical = normalizeCompetitor(name)
  if (canonical && COMPETITOR_COLORS[canonical]) return COMPETITOR_COLORS[canonical]
  if (COMPETITOR_COLORS[name]) return COMPETITOR_COLORS[name]
  // Hash determinístico para no-catalogados
  if (!name) return '#94a3b8'
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0
  const hue = Math.abs(h) % 360
  return `hsl(${hue}, 65%, 50%)`
}

// ── Bot rules templates por moneda ────────────────────────────────────
// Cuando el wizard crea un país, pre-rellena bot_rules según moneda
// para acelerar el setup. Cada template es un array de tuplas mínimas.
// El usuario puede editar antes de guardar.

export const BOT_RULES_TEMPLATES = {
  // Colombia-like — apps típicas LATAM con foco en COP
  COP: [
    { app: 'yango', vc: 'economy', ovc: 'economy', competition_name: 'Yango', category: 'Economy' },
    {
      app: 'yango_api',
      vc: 'economy',
      ovc: 'economy',
      competition_name: 'Yango',
      category: 'Economy',
    },
    { app: 'yango', vc: 'comfort', ovc: 'comfort', competition_name: 'Yango', category: 'Comfort' },
    {
      app: 'yango_api',
      vc: 'comfort',
      ovc: 'comfort',
      competition_name: 'Yango',
      category: 'Comfort',
    },
    { app: 'didi', vc: 'economy', ovc: 'express', competition_name: 'Didi', category: 'Economy' },
    { app: 'uber', vc: 'economy', ovc: 'uberx', competition_name: 'Uber', category: 'Economy' },
    {
      app: 'indrive',
      vc: 'economy',
      ovc: 'viaje',
      competition_name: 'InDrive',
      category: 'Economy',
    },
  ],
  // Peru-like
  PEN: [
    {
      app: 'yango_api',
      vc: 'economy',
      ovc: 'economy',
      competition_name: 'Yango',
      category: 'Economy/Comfort',
    },
    {
      app: 'yango_api',
      vc: 'comfort',
      ovc: 'comfort',
      competition_name: 'Yango',
      category: 'Economy/Comfort',
    },
    {
      app: 'didi',
      vc: 'economy',
      ovc: 'express',
      competition_name: 'Didi',
      category: 'Economy/Comfort',
    },
    {
      app: 'uber',
      vc: 'economy',
      ovc: 'uberx',
      competition_name: 'Uber',
      category: 'Economy/Comfort',
    },
    {
      app: 'indrive',
      vc: 'economy',
      ovc: 'viaje',
      competition_name: 'InDrive',
      category: 'Economy/Comfort',
    },
  ],
  // Bolivia / Nepal / Venezuela / Zambia — template mínimo genérico
  BOB: 'PEN',
  NPR: 'PEN',
  VES: 'PEN',
  ZMW: 'PEN',
  USD: 'PEN',
}

export function getBotRulesTemplate(currency) {
  const t = BOT_RULES_TEMPLATES[currency]
  if (typeof t === 'string') return BOT_RULES_TEMPLATES[t] || []
  return t || []
}
