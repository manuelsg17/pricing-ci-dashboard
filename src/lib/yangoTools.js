// ============================================================
// MODELO DE COMISIÓN DE YANGO — herramientas apilables
// ============================================================
// La comisión que paga el driver de Yango NO es un % plano: se compone de una
// base por ciudad + el fee de partner (siempre activo) + las herramientas que
// el driver tenga prendidas. Validado contra la matriz E1-E4 de la slide "04":
//
//   comisión_total = base_ciudad + partner(3%) + Mi Casa(5%) + Mis Destinos(5%)
//                    + Flex(6%) + Mi Zona(curva por cobertura de GMV)
//
//   E1 (mejor)  = 12 (Lima) + 3                       = 15%
//   E4 (peor)   = 12 + 3 + 6 (Flex) + 9 (Mi Zona min) = 30%
//
// Hoy los números viven acá como constantes (v1). Cuando se quieran editar sin
// deploy → tabla `yango_tools` (ver RENTABILIDAD_DESIGN §5.2). El framework usa
// estos helpers, así que mover la fuente a DB no toca la UI.

// Partner: 3% en todo Perú, SIEMPRE activo (no es toggle).
export const YANGO_PARTNER_PCT = 3

// Base por ciudad — Yango cobra el mismo % en todas las categorías; lo que
// cambia es la ciudad. Lima (y aeropuertos de Lima / Corp) 12%, provincias 9%.
export function yangoBaseCommission(dbCity = '') {
  const c = String(dbCity)
  if (c.startsWith('Trujillo') || c.startsWith('Arequipa')) return 9
  return 12
}

// Herramientas con comisión extra fija (puntos porcentuales sobre la base).
export const YANGO_TOOLS = {
  mi_casa: { key: 'mi_casa', label: 'Mi Casa', pct: 5 },
  mis_destinos: { key: 'mis_destinos', label: 'Mis Destinos', pct: 5 },
  flex: { key: 'flex', label: 'Flex', pct: 6, temporary: true },
}

// ── Mi Zona — modelo B (curva por gmv_inside_ratio) ────────────────────────
// El driver se "cierra" a un set de zonas y paga comisión extra: menos cobertura
// del GMV dentro de sus zonas = más comisión. ratio ≤ 0.251 → 9%; ratio ≥ 1 →
// 0%; intermedio = 9 − 9·t^γ con t=(ratio−0.251)/0.749, γ≈1.087.
// (La elección de zonas en mini-mapa que alimenta este ratio llega en Fase 3.)
export const MI_ZONA_MAX_PCT = 9
const MI_ZONA_RATIO_MIN = 0.251
const MI_ZONA_GAMMA = 1.087

export function miZonaCommissionForRatio(ratio) {
  const r = Math.max(0, Math.min(1, Number(ratio)))
  if (Number.isNaN(r) || r <= MI_ZONA_RATIO_MIN) return MI_ZONA_MAX_PCT
  if (r >= 1) return 0
  const t = (r - MI_ZONA_RATIO_MIN) / (1 - MI_ZONA_RATIO_MIN)
  return MI_ZONA_MAX_PCT * (1 - Math.pow(t, MI_ZONA_GAMMA))
}

// Estado inicial de las herramientas. mi_zona: en Lima se elige por mapa de
// zonas (zones[]); en provincias hay un slider de cobertura (ratio) de respaldo.
export const DEFAULT_TOOLS_STATE = {
  mi_casa: false,
  mis_destinos: false,
  flex: false,
  mi_zona: { on: false, zones: [], ratio: 0.5 },
}

// Suma de comisión extra de las herramientas activas. miZonaExtra = la comisión
// de Mi Zona ya computada afuera (en Lima sale del mapa vía gmv_inside_ratio,
// en provincias del slider) — se pasa como puntos %, default 0.
export function yangoToolsExtra(state = DEFAULT_TOOLS_STATE, miZonaExtra = 0) {
  let extra = 0
  if (state.mi_casa) extra += YANGO_TOOLS.mi_casa.pct
  if (state.mis_destinos) extra += YANGO_TOOLS.mis_destinos.pct
  if (state.flex) extra += YANGO_TOOLS.flex.pct
  extra += miZonaExtra
  return extra
}

// Presets de la matriz de escenarios (decisión cerrada: solo mejor y peor).
//   best (E1) = base + partner, sin herramientas (Mi Zona cobertura total).
//   worst (E4) = base + partner + Flex + Mi Zona al máximo (~2 zonas).
export function yangoScenarioCommission(dbCity, which) {
  const base = yangoBaseCommission(dbCity) + YANGO_PARTNER_PCT
  if (which === 'best') return base
  return base + YANGO_TOOLS.flex.pct + MI_ZONA_MAX_PCT
}
