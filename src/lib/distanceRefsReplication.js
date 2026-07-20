// Replicación "fill-if-missing" de distance_references: cuando se guarda una
// ruta de la categoría fuente (Economy/Comfort en la práctica — ver
// getSourceCategory), se copia a las categorías hermanas de la misma ciudad
// y, si la ciudad es un lado "_Airport_A" de un par definido en
// airport_markers, también a la ciudad "_Airport_B" pareja (con Punto A/B
// invertidos).
//
// Es solo una ayuda para no tipear lo mismo varias veces — NUNCA pisa un
// CAMPO que ya tenga dato propio, porque las categorías/ciudades hermanas
// pueden tener rutas genuinamente distintas a propósito.

// TukTuk, Corp y Bike son verticales distintas (otro tipo de vehículo / otra
// ciudad-tab entera) — no tiene sentido copiarles rutas de auto.
export const REPLICATION_EXCLUDED_CATEGORIES = ['TukTuk', 'Corp', 'Bike']

// Primera categoría de la ciudad que no esté excluida — nunca asume que
// categoriesByCity[0] es automáticamente válida (un país onboardeado a
// futuro podría cargar TukTuk/Bike primero).
export function getSourceCategory(categoriesForCity) {
  return (categoriesForCity || []).find((c) => !REPLICATION_EXCLUDED_CATEGORIES.includes(c)) || null
}

export function getSiblingCategories(categoriesForCity, sourceCategory) {
  return (categoriesForCity || []).filter(
    (c) => c !== sourceCategory && !REPLICATION_EXCLUDED_CATEGORIES.includes(c)
  )
}

export function hasRouteData(row) {
  return !!(
    row &&
    ((row.point_a && String(row.point_a).trim()) || (row.point_b && String(row.point_b).trim()))
  )
}

export function buildSiblingPayload(sourceRow, targetCategory) {
  return {
    category: targetCategory,
    bracket: sourceRow.bracket,
    point_a: sourceRow.point_a ?? null,
    coordinate_a: sourceRow.coordinate_a ?? null,
    point_b: sourceRow.point_b ?? null,
    coordinate_b: sourceRow.coordinate_b ?? null,
    waze_distance: sourceRow.waze_distance ?? null,
  }
}

export function buildMirroredBPayload(sourceRow, targetCategory) {
  return {
    category: targetCategory,
    bracket: sourceRow.bracket,
    point_a: sourceRow.point_b ?? null,
    coordinate_a: sourceRow.coordinate_b ?? null,
    point_b: sourceRow.point_a ?? null,
    coordinate_b: sourceRow.coordinate_a ?? null,
    waze_distance: sourceRow.waze_distance ?? null,
  }
}

const FILLABLE_FIELDS = ['point_a', 'coordinate_a', 'point_b', 'coordinate_b', 'waze_distance']

function isBlankField(v) {
  return v === null || v === undefined || String(v).trim() === ''
}

// Busca la fila (country, city, category, bracket). Si no existe, la
// inserta con `payload`. Si existe, completa SOLO los campos que esa fila
// tiene realmente vacíos — nunca pisa un campo que ya tenga su propio dato,
// aunque otro campo de esa misma fila esté vacío (ej. una fila con
// waze_distance cargado pero point_a/point_b aún sin llenar no debe perder
// su distancia solo porque "parece" una fila vacía).
async function fillIfMissing(sb, { country, city, category, bracket, payload }) {
  const { data: existingRows } = await sb
    .from('distance_references')
    .select('*')
    .eq('country', country)
    .eq('city', city)
    .eq('category', category)
    .eq('bracket', bracket)
    .limit(1)
  const existing = existingRows?.[0]

  if (!existing) {
    const { data: inserted } = await sb
      .from('distance_references')
      .insert({ ...payload, country, city, category, bracket })
      .select()
      .single()
    return { row: inserted, filled: !!inserted }
  }

  const patch = {}
  for (const field of FILLABLE_FIELDS) {
    if (isBlankField(existing[field]) && !isBlankField(payload[field])) {
      patch[field] = payload[field]
    }
  }

  if (Object.keys(patch).length === 0) {
    return { row: existing, filled: false }
  }

  const { data: updated } = await sb
    .from('distance_references')
    .update(patch)
    .eq('id', existing.id)
    .select()
    .single()
  return { row: updated, filled: !!updated }
}

// Orquestador. `savedRow` es la fila recién guardada (payload plano, no hace
// falta esperar el round-trip de saveRef). Best-effort: nunca lanza — un
// fallo acá no debe bloquear ni revertir el guardado principal que le
// importa al usuario.
//
// `visitedCities` evita un ciclo infinito si algún día airport_markers
// llegara a tener un par mal configurado (ej. dos filas que se apunten
// mutuamente A→B y B→A) — hoy no pasa con los pares reales, pero
// AirportMarkersTable.jsx no valida eso al guardar, así que el guard vive
// acá como red de seguridad.
export async function applyFillIfMissingCascade(
  sb,
  { country, dbCity, savedRow, categoriesForCity, visitedCities = new Set() }
) {
  const filled = []
  const sourceCategory = getSourceCategory(categoriesForCity)
  if (!sourceCategory || savedRow.category !== sourceCategory) return { filled }
  if (!savedRow.bracket || !hasRouteData(savedRow)) return { filled }
  if (visitedCities.has(dbCity)) return { filled }
  visitedCities.add(dbCity)

  for (const cat of getSiblingCategories(categoriesForCity, sourceCategory)) {
    const { filled: did } = await fillIfMissing(sb, {
      country,
      city: dbCity,
      category: cat,
      bracket: savedRow.bracket,
      payload: buildSiblingPayload(savedRow, cat),
    })
    if (did) filled.push({ city: dbCity, category: cat, bracket: savedRow.bracket })
  }

  const { data: markers } = await sb
    .from('airport_markers')
    .select('city_to')
    .eq('country', country)
    .eq('city_from', dbCity)
    .limit(1)
  const cityTo = markers?.[0]?.city_to
  if (cityTo && !visitedCities.has(cityTo)) {
    const { row: bRow, filled: didFillB } = await fillIfMissing(sb, {
      country,
      city: cityTo,
      category: sourceCategory,
      bracket: savedRow.bracket,
      payload: buildMirroredBPayload(savedRow, sourceCategory),
    })
    if (didFillB) filled.push({ city: cityTo, category: sourceCategory, bracket: savedRow.bracket })
    if (bRow) {
      const nested = await applyFillIfMissingCascade(sb, {
        country,
        dbCity: cityTo,
        savedRow: bRow,
        categoriesForCity,
        visitedCities,
      })
      filled.push(...nested.filled)
    }
  }

  return { filled }
}
