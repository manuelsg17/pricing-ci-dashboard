// ════════════════════════════════════════════════════════════════════════
// Paleta de colores de competidores — ÚNICA fuente de verdad.
//
// Vive en su propio módulo (y no en constants.js, donde estuvo hasta
// 2026-09-11) porque constants.js importa de catalogs.js (INDRIVE_CARGO_
// VARIANTS) y catalogs.js necesita esta paleta para getCompetitorColor().
// Ponerla en cualquiera de los dos genera un import circular real: Node
// (y el bundler en ciertos órdenes de carga) revienta con "Cannot access
// 'X' before initialization" porque un array top-level de un módulo se
// evalúa antes de que el otro módulo haya terminado de inicializar el
// suyo. Un módulo hoja sin dependencias evita el problema de raíz.
// ════════════════════════════════════════════════════════════════════════

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
  PedidosYa: '#FF0F3A', // Delivery Lima (2026-09) — alinea con catalogs.js
  // Cargo (2026-09): subcategorías por tamaño de vehículo — alinea con catalogs.js
  YangoCargoXP: '#EF9A9A',
  YangoCargoPickup: '#E57373',
  YangoCargoM: '#E53935',
  YangoCargoXL: '#B71C1C',
  InDriveCargoPickup: '#A5D6A7',
  InDriveCargoVan: '#66BB6A',
  InDriveCargoLiviano: '#2E7D32',
  InDriveCargoGrande: '#1B5E20',
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
