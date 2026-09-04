// Claves de Ingresar CI (sin React). Los TRES namespaces de identidad de un
// "bucket" NO son intercambiables (CLAUDE.md §1): `uiCity` (lo que ve el hub),
// `dbCity`/`bucketKey` (lo que persiste en BD / rebanada de estado en
// memoria) y `viewId` (parte "ciudad" de la clave de localStorage). Mezclarlos
// ya costó trabajo de un hub (2026-07-24). Concentrar los formatos acá evita
// que cada punto de uso los arme a mano de forma distinta.

// Claves de celda dentro de la rebanada de una vista.
export const priceKey = (uiCat, refId, tsLabel, comp) => `${uiCat}|${refId}|${tsLabel}|${comp}`
export const indKey = (uiCat, refId, tsLabel) => `${uiCat}|${refId}|${tsLabel}`

// bucketKey: vista normal → la ciudad de BD; distrito de TukTuk → clave
// sintética única por distrito (TukTuk no es ciudad aparte en BD, se
// distingue por `zone`). El separador '~' no aparece en ciudades ni distritos.
export function bucketKeyFor(dbCity, zone, isTukTuk) {
  return isTukTuk ? `TT~${dbCity}~${zone}` : dbCity
}

// viewId: vista normal → uiCity (sin cambios históricos); TukTuk → lleva el
// distrito, para que cada uno tenga su propio borrador.
export function viewIdFor(uiCity, dbCity, zone, isTukTuk) {
  return isTukTuk ? `TT~${dbCity}~${zone}` : uiCity
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
