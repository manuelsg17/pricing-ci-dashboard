// Replicación "fill-if-missing" de distance_references: cuando se guarda una
// ruta de la categoría fuente (Economy/Comfort en la práctica — ver
// getSourceCategory), se copia a las categorías hermanas de la misma ciudad
// y, si la ciudad es un lado "_Airport_A" de un par definido en
// airport_markers, también a la ciudad "_Airport_B" pareja (con Punto A/B
// invertidos).
//
// Es solo una ayuda para no tipear lo mismo varias veces — NUNCA pisa una
// fila que ya tenga datos propios, porque las categorías/ciudades hermanas
// pueden tener rutas genuinamente distintas a propósito.

// TukTuk y Corp son verticales distintas (otro tipo de vehículo / otra
// ciudad-tab entera) — no tiene sentido copiarles rutas de auto.
export const REPLICATION_EXCLUDED_CATEGORIES = ['TukTuk', 'Corp']

export function getSourceCategory(categoriesForCity) {
  return categoriesForCity?.[0] || null
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

// Busca la fila (country, city, category, bracket). Si no existe, la
// inserta con `payload`. Si existe pero está vacía, la completa. Si ya
// tiene datos propios, la deja intacta y solo la devuelve (para que el
// llamador pueda seguir la cascada de siblings con SUS datos actuales).
async function fillIfMissing(sb, { country, city, category, bracket, payload }) {
  const { data: existingRows } = await sb
    .from('distance_references')
    .select('id, point_a, point_b')
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

  if (!hasRouteData(existing)) {
    const { data: updated } = await sb
      .from('distance_references')
      .update(payload)
      .eq('id', existing.id)
      .select()
      .single()
    return { row: updated, filled: !!updated }
  }

  const { data: full } = await sb
    .from('distance_references')
    .select('*')
    .eq('id', existing.id)
    .single()
  return { row: full, filled: false }
}

// Orquestador. `savedRow` es la fila recién guardada (payload plano, no hace
// falta esperar el round-trip de saveRef). Best-effort: nunca lanza — un
// fallo acá no debe bloquear ni revertir el guardado principal que le
// importa al usuario.
export async function applyFillIfMissingCascade(
  sb,
  { country, dbCity, savedRow, categoriesForCity }
) {
  const filled = []
  const sourceCategory = getSourceCategory(categoriesForCity)
  if (!sourceCategory || savedRow.category !== sourceCategory) return { filled }
  if (!savedRow.bracket || !hasRouteData(savedRow)) return { filled }

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
  if (cityTo) {
    const { row: bRow, filled: didFillB } = await fillIfMissing(sb, {
      country,
      city: cityTo,
      category: sourceCategory,
      bracket: savedRow.bracket,
      payload: buildMirroredBPayload(savedRow, sourceCategory),
    })
    if (didFillB) filled.push({ city: cityTo, category: sourceCategory, bracket: savedRow.bracket })
    if (bRow) {
      // Un solo salto — airport_markers.city_from nunca es un "_Airport_B",
      // así que esta llamada recursiva no vuelve a encontrar pareja.
      const nested = await applyFillIfMissingCascade(sb, {
        country,
        dbCity: cityTo,
        savedRow: bRow,
        categoriesForCity,
      })
      filled.push(...nested.filled)
    }
  }

  return { filled }
}
