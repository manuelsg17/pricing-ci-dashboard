// ════════════════════════════════════════════════════════════════════════
// "Quién más está trabajando este bucket ahora mismo".
//
// La lógica pura vive acá y no dentro de DataEntry.jsx por una razón muy
// concreta: DataEntry es un god-component de miles de líneas que importa CSS
// y media app, así que nada de lo que viva ahí adentro se puede testear en
// Node. Y esto SÍ hay que testearlo — ver abajo por qué.
// ════════════════════════════════════════════════════════════════════════

export const EMPTY_PRESENCE = []

/**
 * ¿La presencia que acaba de llegar es la MISMA que la que ya tengo?
 *
 * POR QUÉ EXISTE, Y NO ES UNA MICRO-OPTIMIZACIÓN
 * El sondeo corre cada 20 segundos y casi siempre devuelve exactamente lo
 * mismo, pero como llega un array NUEVO, `setPresence(data)` cambia la
 * identidad y React re-renderiza. En Ingresar CI eso son 108-324 celdas sin
 * `React.memo` (verificado): una reconciliación entera de la grilla cada 20
 * segundos, para mostrar el mismo texto. Es exactamente el caso que CLAUDE.md
 * §5 marca como prohibido — un efecto que se dispara por identidad recreada y
 * no por un cambio real.
 *
 * QUÉ SE COMPARA Y QUÉ NO
 * Solo lo que la UI muestra: quién, en qué ciudad, en qué zona y con qué
 * alcance declarado. `last_seen_at` queda AFUERA a propósito: cambia con cada
 * latido de cada hub, así que incluirlo haría que "cambió" fuese siempre
 * verdadero y esta función no serviría absolutamente para nada.
 *
 * El orden tampoco cuenta: la RPC no promete uno estable, y dos listas con
 * las mismas personas son la misma presencia aunque vengan al revés.
 */
export function mismaPresencia(a, b) {
  const x = a || EMPTY_PRESENCE
  const y = b || EMPTY_PRESENCE
  if (x.length !== y.length) return false
  const clave = (p) => `${p.user_email}|${p.city}|${p.zone ?? ''}|${p.scope_label ?? ''}`
  const setX = new Set(x.map(clave))
  return y.every((p) => setX.has(clave(p)))
}

/**
 * Los otros hubs que están parados en ESTE bucket.
 *
 * `zone` se compara normalizando null/undefined/'' a null: la RPC devuelve
 * NULL para lo que no es TukTuk ni Aeropuerto, el cliente a veces tiene '' y
 * a veces undefined, y tratarlos distinto haría que el aviso no salga nunca
 * justo en Corp, que es el caso para el que se construyó.
 */
export function presenciaEnBucket(presence, city, zone) {
  const z = zone == null || zone === '' ? null : zone
  return (presence || EMPTY_PRESENCE).filter(
    (p) => p.city === city && (p.zone == null || p.zone === '' ? null : p.zone) === z
  )
}
