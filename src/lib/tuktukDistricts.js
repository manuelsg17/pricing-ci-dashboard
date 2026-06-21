// ============================================================
// DISTRITOS DE TUKTUK (Lima)
// ============================================================
// TukTuk solo opera dentro de ciertos distritos y los viajes son dentro del
// mismo distrito → la columna `zone` de pricing_observations = el distrito.
// Esta es la lista canónica (nombres tal como se muestran en el dashboard).
// Origen: equipo de pricing (2026-06). El normalizador acepta variantes
// (mayúsculas/acentos/nombre completo) y las mapea al canónico.

export const TUKTUK_DISTRICTS = [
  'Comas',
  'SJM',
  'Chorrillos',
  'VES',
  'SJL',
  'Ventanilla',
  'Carabayllo',
]

// Variante normalizada (lowercase, sin acentos, espacios colapsados) → canónico.
const ALIASES = {
  comas: 'Comas',
  sjm: 'SJM',
  'san juan de miraflores': 'SJM',
  chorrillos: 'Chorrillos',
  ves: 'VES',
  'villa el salvador': 'VES',
  sjl: 'SJL',
  'san juan de lurigancho': 'SJL',
  ventanilla: 'Ventanilla',
  carabayllo: 'Carabayllo',
}

function strip(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // saca acentos
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
}

// Devuelve el distrito canónico, o null si está vacío/desconocido.
export function normalizeTukTukDistrict(raw) {
  if (raw == null || raw === '') return null
  return ALIASES[strip(raw)] || null
}

export function isTukTukDistrict(raw) {
  return normalizeTukTukDistrict(raw) != null
}
