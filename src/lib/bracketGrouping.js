import { BRACKETS } from './constants.js'

// Agrupa las rutas de distance_references por bracket para el flujo
// "Ingresar CI" por bracket (ver src/pages/DataEntry.jsx). Cada grupo ancla
// en UNA ruta de `sourceCategory` para ese bracket. Una categoría hermana
// solo se empareja con esa ancla si tiene EXACTAMENTE una ruta en ese
// bracket (y la ancla también) — si tiene 0, no hay ruta (queda fuera de
// `byCategory`, la UI lo muestra en `missingCats`); si tiene 2+, no hay
// forma confiable de saber cuál corresponde a cuál posición del ancla
// (emparejar por índice de array podría mezclar rutas sin ninguna relación
// real entre sí, ej. TukTuk con varias rutas por distrito en el mismo
// bracket) — esas quedan en `extras`, cada una con su propia cabecera de
// ruta, en vez de arriesgar un emparejamiento incorrecto y silencioso.
export function buildRefsByBracket(refsByUICat, categories, sourceCategory) {
  // Sin categoría "ancla" (getSourceCategory devolvió null): la ciudad solo tiene
  // categorías excluidas de la replicación — ej. la ciudad-tab "Corp" (única
  // categoría Corp) o una ciudad solo-TukTuk. NO hay rutas hermanas que emparejar,
  // pero SÍ hay rutas para cargar: se muestra cada ruta como "extra" con su propia
  // cabecera. Antes se devolvía [] y la grilla decía "no hay rutas configuradas"
  // aunque distance_references sí tuviera rutas para esa ciudad (bug de Corp).
  if (!sourceCategory) {
    return BRACKETS.map((bracket) => {
      const extras = []
      for (const uiCat of categories) {
        for (const ref of (refsByUICat[uiCat] || []).filter((r) => r.bracket === bracket)) {
          extras.push({ uiCat, ref })
        }
      }
      return { bracket, groups: [], extras }
    }).filter((b) => b.extras.length > 0)
  }
  const anchorRefs = refsByUICat[sourceCategory] || []
  return BRACKETS.map((bracket) => {
    const bracketAnchors = anchorRefs.filter((r) => r.bracket === bracket)
    const byCatBracket = {}
    for (const uiCat of categories) {
      byCatBracket[uiCat] = (refsByUICat[uiCat] || []).filter((r) => r.bracket === bracket)
    }
    const canPairSafely = bracketAnchors.length === 1
    const groups = bracketAnchors.map((anchorRef) => {
      const byCategory = {}
      for (const uiCat of categories) {
        if (uiCat === sourceCategory) {
          byCategory[uiCat] = anchorRef
        } else if (canPairSafely && byCatBracket[uiCat].length === 1) {
          byCategory[uiCat] = byCatBracket[uiCat][0]
        }
      }
      return { anchorRef, byCategory }
    })
    const extras = []
    for (const uiCat of categories) {
      if (uiCat === sourceCategory) continue
      if (canPairSafely && byCatBracket[uiCat].length === 1) continue // ya emparejada arriba
      for (const ref of byCatBracket[uiCat]) {
        extras.push({ uiCat, ref })
      }
    }
    return { bracket, groups, extras }
  }).filter((b) => b.groups.length > 0 || b.extras.length > 0)
}
