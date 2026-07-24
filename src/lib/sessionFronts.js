// Frentes de una sesión de "Ingresar CI" — lógica pura, sin React ni Supabase
// (testeada en scripts/test-session-fronts.mjs).
//
// Contexto (pedido user 2026-07-24): desde que el hub puede saltar libremente
// entre pestañas dentro de una misma sesión, "una sesión = una ciudad" dejó de
// ser cierto. El latido (`ci_active_sessions`, mig 146) solo mandaba la vista
// ACTUAL, así que Monitoreo mostraba al hub donde estaba parado y sus otros
// frentes a medias eran invisibles — y la presencia (mig 152), que existe para
// que dos hubs no se pisen, tampoco los veía.
//
// Estas funciones arman la lista de frentes que viaja en el latido (mig 161):
// todos los que el hub tiene abiertos, marcando cuál está mirando AHORA.
import { getCityLabel } from './constants.js'
import { formatCityZoneLabel } from './monitoring.js'

// Tope defensivo del array que viaja al servidor. Un hub real no abre más de
// un puñado de frentes; esto solo evita que un estado corrupto (o un bug
// futuro que acumule buckets sin limpiar) haga crecer el jsonb sin techo en
// cada latido, que se manda cada ~25s.
export const MAX_FRONTS = 12

// Un bucketKey es `TT~<ciudad>~<distrito>` en TukTuk y la ciudad de BD a secas
// en cualquier otra vista (ver DataEntry.jsx). Devuelve las columnas tal como
// viven en pricing_observations / ci_active_sessions.
export function parseBucketKey(bucket) {
  if (typeof bucket !== 'string' || bucket === '') return null
  if (bucket.startsWith('TT~')) {
    const parts = bucket.split('~')
    // `TT~ciudad~distrito`: exactamente 3 partes y ninguna vacía. Algo con
    // más/menos separadores está corrupto — mejor descartarlo que mandar al
    // servidor una fila de presencia que no corresponde a ningún lado real.
    if (parts.length !== 3 || !parts[1] || !parts[2]) return null
    // `bucketKey` se arma interpolando (`TT~${dbCity}~${zone}`), así que un
    // zone null/undefined produce la STRING 'null'/'undefined' — pasa de
    // verdad al abrir la pestaña TukTuk de una ciudad sin distritos
    // habilitados. Antes era inocuo (clave de estado local); ahora viajaría al
    // servidor y saldría en Monitoreo como "Lima TukTuk · null" y como una
    // fila de presencia fantasma.
    if (parts[2] === 'null' || parts[2] === 'undefined') return null
    return { city: parts[1], zone: parts[2] }
  }
  return { city: bucket, zone: null }
}

// Label legible de un frente, única fuente para el aviso de "te falta cerrar"
// en Ingresar CI y para los chips de Monitoreo (antes cada pantalla tenía su
// propio formato).
export function frontLabel(bucket) {
  const parsed = parseBucketKey(bucket)
  if (!parsed) return String(bucket ?? '')
  const air = /^(.+)_Airport_([AB])$/.exec(parsed.city)
  if (air) return `${getCityLabel(air[1])} Aeropuerto · Punto ${air[2]}`
  return formatCityZoneLabel(parsed.city, parsed.zone)
}

// Arma el payload de frentes para el latido.
//
// - Une el alcance declarado (`scopeMembers`) + los frentes extra tocados
//   (`extraFronts`) + la vista actual, deduplicando y conservando el orden.
// - La vista actual SIEMPRE entra, aunque el hub no haya escrito nada todavía:
//   el user quiere ver "dónde está avanzando ahora mismo" incluso si recién
//   llegó a esa pestaña.
// - `total` queda en null si nunca se supo el total de ese frente (el cliente
//   solo conoce el total de las vistas que el hub ya visitó). Monitoreo debe
//   tratar null como "desconocido", no como 0.
export function buildFronts({
  scopeMembers = [],
  extraFronts = [],
  currentBucket = null,
  filledByBucket = {},
  totalByBucket = {},
} = {}) {
  const seen = new Set()
  const out = []
  const push = (bucket) => {
    if (out.length >= MAX_FRONTS) return
    const parsed = parseBucketKey(bucket)
    if (!parsed || seen.has(bucket)) return
    seen.add(bucket)
    const total = totalByBucket[bucket]
    const filled = filledByBucket[bucket]
    out.push({
      bucket,
      city: parsed.city,
      zone: parsed.zone,
      // null = DESCONOCIDO, no cero. La grilla se hidrata por bucket visitado,
      // así que tras un refresh el cliente no sabe cuánto tiene cargado un
      // frente en el que todavía no se paró. Mandar 0 haría que el admin viera
      // "Punto B 0" para un frente con 150 filas hechas y concluyera que nadie
      // lo arrancó — justo la decisión (reasignar/insistir) que este panel
      // tiene que informar bien.
      filled: filled === null || filled === undefined ? null : Number(filled) || 0,
      total: Number.isFinite(total) && total > 0 ? total : null,
      current: bucket === currentBucket,
    })
  }
  for (const b of scopeMembers) push(b)
  for (const b of extraFronts) push(b)
  push(currentBucket)
  // Si el tope recortó justo el frente actual, forzarlo: perder "dónde está
  // ahora" es peor que perder un pendiente de la cola.
  if (currentBucket && !seen.has(currentBucket) && out.length > 0) {
    out.pop()
    push(currentBucket)
  }
  return out
}
