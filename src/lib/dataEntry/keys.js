// Claves de Ingresar CI (sin React). Los TRES namespaces de identidad de un
// "bucket" NO son intercambiables (CLAUDE.md §1): `uiCity` (lo que ve el hub),
// `dbCity`/`bucketKey` (lo que persiste en BD / rebanada de estado en
// memoria) y `viewId` (parte "ciudad" de la clave de localStorage). Mezclarlos
// ya costó trabajo de un hub (2026-07-24). Concentrar los formatos acá evita
// que cada punto de uso los arme a mano de forma distinta.

// Claves de celda dentro de la rebanada de una vista.
export const priceKey = (uiCat, refId, tsLabel, comp) => `${uiCat}|${refId}|${tsLabel}|${comp}`
// `comp` (2026-09, subcategorías de Cargo): antes la clave no distinguía
// competidor porque solo existía UN InDrive por fila — con 4 subcategorías
// de InDrive en Cargo compartiendo (uiCat, refId, tsLabel), sin `comp`
// las 4 pisaban el mismo estado de bids/recomendado (bug real, hallado al
// probar en navegador antes de mergear).
export const indKey = (uiCat, refId, tsLabel, comp) => `${uiCat}|${refId}|${tsLabel}|${comp}`

// bucketKey: vista normal → la ciudad de BD; distrito de TukTuk → clave
// sintética única por distrito (TukTuk no es ciudad aparte en BD, se
// distingue por `zone`). El separador '~' no aparece en ciudades ni distritos.
//
// Delivery/Cargo (2026-09) son categorías de la MISMA ciudad de BD (Lima),
// no ciudades propias — mismo criterio que TukTuk (precedente ya probado):
// una categoría más de 'Lima', discriminada por `zone` SOLO para que este
// frente tenga su propia marca de agua de guardado (ci_bucket_writes) y no
// pise la de "Lima Normal". Prefijo 'CAT~' propio (no 'TT~') para que
// parseBucketKey pueda distinguir "distrito de TukTuk" de "categoría propia"
// al armar el label en Monitoreo — son casos con display distinto.
// Nombres reservados: una `zone` con uno de estos valores es SIEMPRE una
// categoría propia (Delivery/Cargo), nunca un distrito de TukTuk — hace falta
// en los puntos que reciben solo `zone` desde BD (ci_sessions) sin un `kind`
// explícito y necesitan decidir a cuál de los dos formatos armar la clave.
export const SPECIAL_CATEGORY_ZONES = new Set(['Delivery', 'Cargo'])

export function bucketKeyFor(dbCity, zone, isTukTuk) {
  if (isTukTuk) return `TT~${dbCity}~${zone}`
  if (zone) return `CAT~${dbCity}~${zone}`
  return dbCity
}

// viewId: vista normal → uiCity (sin cambios históricos); TukTuk y las
// categorías con zone propia (ver bucketKeyFor) llevan la clave completa,
// para que cada una tenga su propio borrador.
export function viewIdFor(uiCity, dbCity, zone, isTukTuk) {
  if (isTukTuk) return `TT~${dbCity}~${zone}`
  if (zone) return `CAT~${dbCity}~${zone}`
  return uiCity
}

// Borrador en localStorage, uno por (usuario, país, vista, fecha). El email
// es DELIBERADO: localStorage es por navegador, no por cuenta.
export function draftKeyFor(userEmail, country, viewId, date) {
  return `de:draft:${userEmail}:${country}:${viewId}:${date}`
}
export function legacyDraftKeyFor(country, viewId, date) {
  return `de:draft:${country}:${viewId}:${date}`
}
export function draftKeyPrefixFor(userEmail, country) {
  return `de:draft:${userEmail}:${country}:`
}

// Espejo en localStorage del guard "recién Terminado" (sobrevive un F5).
export function bucketFinishedLsKeyFor(userEmail, bucketKey, date) {
  return `de:finished:${userEmail}:${bucketKey}:${date}`
}

// Marca de agua de sincronización con el servidor (mig 191), en
// sessionStorage. Usa identidad de BD (dbCity/zone), NUNCA viewId.
export function syncSeqKeyFor(country, city, zone, date) {
  return `de:seq:${country}|${city}|${zone ?? ''}|${date}`
}
