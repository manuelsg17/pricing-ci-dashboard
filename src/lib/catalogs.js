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
  { value: 'Economy',         label: 'Economy',         aliases: ['economy', 'economi', 'standard', 'basic', 'classic'] },
  { value: 'Economy/Comfort', label: 'Economy/Comfort', aliases: ['economy/comfort', 'economy_comfort', 'eco_comfort'] },
  { value: 'Comfort',         label: 'Comfort',         aliases: ['comfort', 'confort'] },
  { value: 'Comfort+',        label: 'Comfort+',        aliases: ['comfort+', 'comfort_plus', 'comfortplus', 'comfort_mas'] },
  { value: 'Premier',         label: 'Premier',         aliases: ['premier', 'premium', 'lujo', 'lux', 'business'] },
  { value: 'Bike',            label: 'Bike',            aliases: ['bike', 'moto', 'motorbike', 'motorcycle', 'mototaxi'] },
  { value: 'TukTuk',          label: 'TukTuk',          aliases: ['tuktuk', 'tuk_tuk', 'tuc_tuc', 'autorickshaw'] },
  { value: 'XL',              label: 'XL',              aliases: ['xl', 'extra_large', 'van', 'minivan', 'group'] },
  { value: 'Corp',            label: 'Corp',            aliases: ['corp', 'corporativo', 'corporate', 'empresa'] },
  { value: 'Aeropuerto',      label: 'Aeropuerto',      aliases: ['aeropuerto', 'airport', 'aeroporto'] },
]

export const CATALOG_COMPETITORS = [
  { value: 'Yango',         color: '#E53935', botApps: ['yango', 'yango_api'],         aliases: ['yango', 'yango_api'] },
  { value: 'YangoComfort',  color: '#C62828', botApps: ['yango'],                       aliases: ['yangocomfort', 'yango_comfort'] },
  { value: 'Yango Premier', color: '#B71C1C', botApps: ['yango'],                       aliases: ['yango_premier', 'yangopremier', 'yango premier'] },
  { value: 'Yango Comfort+', color: '#D32F2F', botApps: ['yango'],                      aliases: ['yango_comfort+', 'yango comfort+', 'yangocomfortplus'] },
  { value: 'Yango XL',      color: '#EF5350', botApps: ['yango'],                       aliases: ['yango_xl', 'yangoxl'] },
  { value: 'Uber',          color: '#1F2937', botApps: ['uber'],                        aliases: ['uber'] },
  { value: 'Didi',          color: '#FF7E1B', botApps: ['didi'],                        aliases: ['didi', 'didi_express'] },
  { value: 'InDrive',       color: '#00C853', botApps: ['indrive', 'indriver'],         aliases: ['indrive', 'in_drive', 'indriver'] },
  { value: 'Cabify',        color: '#7B1FA2', botApps: ['cabify'],                      aliases: ['cabify'] },
  { value: 'Cabify Lite',   color: '#9C27B0', botApps: ['cabify'],                      aliases: ['cabify_lite', 'cabifylite'] },
  { value: 'Cabify XL',     color: '#AB47BC', botApps: ['cabify'],                      aliases: ['cabify_xl', 'cabifyxl'] },
  { value: 'Picap',         color: '#FB923C', botApps: ['picap'],                       aliases: ['picap'] },
  { value: 'Beat',          color: '#0EA5E9', botApps: ['beat'],                        aliases: ['beat'] },
  { value: 'Bolt',          color: '#84CC16', botApps: ['bolt'],                        aliases: ['bolt'] },
  { value: 'Rappi',         color: '#FF1744', botApps: ['rappi'],                       aliases: ['rappi'] },
]

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
  const key = String(input).trim().toLowerCase().replace(/[\s-]+/g, '_')
  return CATEGORY_BY_ALIAS.get(key) || null
}

/**
 * Devuelve el nombre canónico para un competidor, o null si no se reconoce.
 * Ej: 'indrive' → 'InDrive', 'Indrive' → 'InDrive', 'DiDi' → 'Didi'.
 */
export function normalizeCompetitor(input) {
  if (input == null) return null
  const key = String(input).trim().toLowerCase().replace(/\s+/g, ' ').replace(/-/g, '_')
  return COMPETITOR_BY_ALIAS.get(key) || null
}

/**
 * Devuelve el color asignado al competidor, con fallback determinístico.
 */
export function getCompetitorColor(name) {
  const canonical = normalizeCompetitor(name)
  if (canonical) {
    const entry = CATALOG_COMPETITORS.find(c => c.value === canonical)
    if (entry?.color) return entry.color
  }
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
    { app: 'yango',     vc: 'economy',    ovc: 'economy', competition_name: 'Yango',   category: 'Economy' },
    { app: 'yango_api', vc: 'economy',    ovc: 'economy', competition_name: 'Yango',   category: 'Economy' },
    { app: 'yango',     vc: 'comfort',    ovc: 'comfort', competition_name: 'Yango',   category: 'Comfort' },
    { app: 'yango_api', vc: 'comfort',    ovc: 'comfort', competition_name: 'Yango',   category: 'Comfort' },
    { app: 'didi',      vc: 'economy',    ovc: 'express', competition_name: 'Didi',    category: 'Economy' },
    { app: 'uber',      vc: 'economy',    ovc: 'uberx',   competition_name: 'Uber',    category: 'Economy' },
    { app: 'indrive',   vc: 'economy',    ovc: 'viaje',   competition_name: 'InDrive', category: 'Economy' },
  ],
  // Peru-like
  PEN: [
    { app: 'yango_api', vc: 'economy',    ovc: 'economy',  competition_name: 'Yango',   category: 'Economy/Comfort' },
    { app: 'yango_api', vc: 'comfort',    ovc: 'comfort',  competition_name: 'Yango',   category: 'Economy/Comfort' },
    { app: 'didi',      vc: 'economy',    ovc: 'express',  competition_name: 'Didi',    category: 'Economy/Comfort' },
    { app: 'uber',      vc: 'economy',    ovc: 'uberx',    competition_name: 'Uber',    category: 'Economy/Comfort' },
    { app: 'indrive',   vc: 'economy',    ovc: 'viaje',    competition_name: 'InDrive', category: 'Economy/Comfort' },
  ],
  // Bolivia / Nepal / Venezuela / Zambia — template mínimo genérico
  BOB: 'PEN', NPR: 'PEN', VES: 'PEN', ZMW: 'PEN', USD: 'PEN',
}

export function getBotRulesTemplate(currency) {
  const t = BOT_RULES_TEMPLATES[currency]
  if (typeof t === 'string') return BOT_RULES_TEMPLATES[t] || []
  return t || []
}
