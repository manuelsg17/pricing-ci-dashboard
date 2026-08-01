// ════════════════════════════════════════════════════════════════════════
// Clave de idempotencia del cierre de sesión (SESIONES_HALLAZGOS.md P2-11).
//
// EL PROBLEMA
// El INSERT a `ci_sessions` no es atómico con `save_ci_batch`. Si el servidor
// ejecuta el INSERT pero la respuesta se pierde (red caída, timeout del
// proxy, la pestaña que se duerme en un celular), el hub ve "no se pudo
// cerrar la sesión" y reintenta — que es exactamente lo que la UI le pide que
// haga. Quedan DOS filas para el mismo cierre y la duración se cuenta dos
// veces en cualquier agregado.
//
// POR QUÉ NO ALCANZA UNA CONSTRAINT ÚNICA
// Reabrir una sesión ya cerrada para corregir una celda e insertar una fila
// nueva es DELIBERADO: es el rastro de revisiones que el user quiere
// conservar. Un `UNIQUE (city, zone, observed_date, user_email)` mataría el
// duplicado por reintento y también la corrección legítima, en silencio.
//
// LA DISTINCIÓN QUE FALTA es "reintento del MISMO cierre" vs "cierre NUEVO",
// y esa la sabe el cliente, no la base: el servidor no puede distinguir dos
// pedidos idénticos de un reintento. Por eso el cliente estampa una clave de
// idempotencia —un uuid por INTENTO DE CIERRE, no por request— y la base la
// usa como identidad de ese cierre (mig 197).
//
// EL CICLO DE VIDA ES TODO EL DISEÑO:
//   · se crea cuando el hub aprieta "Terminar" y todavía no hay token vivo;
//   · se REUSA en cada reintento del mismo cierre (incluso después de un F5:
//     vive en localStorage, no en un ref — CLAUDE.md §2, es el bug que este
//     proyecto ya tuvo dos veces);
//   · se BORRA cuando el cierre se confirma, para que el próximo "Terminar"
//     —una revisión legítima— inserte una fila nueva de verdad.
//
// La ventana de reintento existe como red de contención del único camino que
// rompería lo anterior: que el borrado post-éxito falle (localStorage lleno o
// deshabilitado). Sin ella, un token zombi se comería para siempre las
// revisiones de ese bucket. Con ella, el daño dura como mucho VENTANA.
//
// La extensión .js es OBLIGATORIA en los imports: estos módulos se testean con
// node plano y el resolvedor ESM de Node no la infiere (Vite sí).
// ════════════════════════════════════════════════════════════════════════

// Cuánto tiempo un token sigue representando "el mismo cierre".
//
// Tiene que cubrir con holgura el peor reintento realista —el hub pierde
// conexión, la recupera a los minutos y vuelve a apretar Terminar; o cierra
// la laptop, la abre y reintenta— y tiene que ser MUCHO más corto que el
// tiempo típico entre un cierre y una revisión posterior del mismo bucket.
// 30 minutos entra cómodo en las dos condiciones: los reintentos ocurren en
// segundos o minutos, y una revisión de una sesión ya cerrada llega horas
// después (o al día siguiente, desde el Historial).
//
// Ojo: esto NO es lo que hace idempotente al reintento normal. Ese camino
// funciona por el borrado explícito al confirmar. Esto es solo el techo del
// daño cuando ese borrado no se pudo hacer.
export const VENTANA_REINTENTO_MS = 30 * 60 * 1000

// Respaldo en memoria para cuando localStorage no está (modo privado de
// Safari, cuota llena, storage deshabilitado por política). Sin esto, cada
// reintento generaría un token nuevo y volveríamos al bug original en esos
// navegadores. Con esto, al menos el reintento dentro del mismo tab está
// protegido; un F5 en ese escenario degrada al comportamiento de hoy, y eso
// se informa en vez de disimularse.
const memoria = new Map()

/**
 * Clave de localStorage del cierre. Va por (usuario, bucket, fecha) porque un
 * mismo hub puede tener DOS cierres distintos en vuelo a la vez: Aeropuerto
 * "Ambos" cierra Punto A y Punto B con segundos de diferencia, y son cierres
 * distintos que no deben compartir token.
 */
export function claveDeCierre({ userEmail, bucketKey, fecha }) {
  return `de:close:${userEmail || 'anon'}:${bucketKey}:${fecha}`
}

function leer(storage, clave) {
  let crudo = null
  try {
    crudo = storage?.getItem(clave) ?? null
  } catch {
    crudo = null
  }
  if (crudo == null) crudo = memoria.get(clave) ?? null
  if (crudo == null) return null
  try {
    const o = JSON.parse(crudo)
    if (!o || typeof o.token !== 'string' || !o.token) return null
    return { token: o.token, creadoEn: Number(o.creadoEn) || 0, intentos: Number(o.intentos) || 1 }
  } catch {
    // Registro corrupto: se descarta y se genera uno nuevo. Un token
    // ilegible es peor que no tener token — no identifica ningún cierre.
    return null
  }
}

function escribir(storage, clave, registro) {
  const crudo = JSON.stringify(registro)
  // Siempre en memoria: es el respaldo si el storage falla, y también evita
  // releer/parsear en el reintento inmediato.
  memoria.set(clave, crudo)
  try {
    storage?.setItem(clave, crudo)
    return true
  } catch {
    return false
  }
}

function uuidPorDefecto() {
  // `crypto.randomUUID` existe en todos los navegadores que esta app soporta
  // y en Node ≥ 19. Los respaldos están por completitud, en orden de calidad.
  try {
    if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
    if (typeof globalThis.crypto?.getRandomValues === 'function') {
      const b = globalThis.crypto.getRandomValues(new Uint8Array(16))
      b[6] = (b[6] & 0x0f) | 0x40
      b[8] = (b[8] & 0x3f) | 0x80
      const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
    }
  } catch {
    /* cae al respaldo de abajo */
  }
  // Último recurso. `Math.random` acá es aceptable —solo hace falta que dos
  // cierres distintos no colisionen, no resistencia criptográfica— pero si
  // algún día este módulo corre dentro de un Workflow hay que revisarlo
  // (CLAUDE.md §2).
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

/**
 * Token de idempotencia para ESTE intento de cierre.
 *
 * Llamarla dos veces seguidas para el mismo bucket+fecha devuelve el MISMO
 * token: eso es lo que hace que el reintento no duplique. Llamarla después de
 * `confirmarCierre` devuelve uno nuevo: eso es lo que deja pasar la revisión
 * legítima.
 *
 * @returns {{token:string, reintento:boolean, intentos:number, persistido:boolean}}
 *   `persistido:false` avisa que el token vive solo en memoria (localStorage
 *   no disponible): protege el reintento en este tab, pero no sobrevive un F5.
 */
export function tokenDeCierre(
  { userEmail, bucketKey, fecha },
  {
    storage = typeof localStorage !== 'undefined' ? localStorage : null,
    ahora = Date.now(),
    uuid = uuidPorDefecto,
    ventanaMs = VENTANA_REINTENTO_MS,
  } = {}
) {
  const clave = claveDeCierre({ userEmail, bucketKey, fecha })
  const previo = leer(storage, clave)

  if (previo && ahora - previo.creadoEn >= 0 && ahora - previo.creadoEn <= ventanaMs) {
    const registro = {
      token: previo.token,
      creadoEn: previo.creadoEn,
      intentos: previo.intentos + 1,
    }
    const persistido = escribir(storage, clave, registro)
    return { token: registro.token, reintento: true, intentos: registro.intentos, persistido }
  }

  const registro = { token: uuid(), creadoEn: ahora, intentos: 1 }
  const persistido = escribir(storage, clave, registro)
  return { token: registro.token, reintento: false, intentos: 1, persistido }
}

/**
 * El cierre quedó confirmado por el servidor: se retira el token para que el
 * próximo "Terminar" del mismo bucket sea un cierre nuevo y no un reintento.
 *
 * Se llama SOLO tras respuesta OK. Llamarla en el camino de error sería
 * volver a duplicar: el reintento generaría un token distinto y la fila que
 * ya se había insertado del otro lado quedaría huérfana como duplicado.
 */
export function confirmarCierre(
  { userEmail, bucketKey, fecha },
  { storage = typeof localStorage !== 'undefined' ? localStorage : null } = {}
) {
  const clave = claveDeCierre({ userEmail, bucketKey, fecha })
  memoria.delete(clave)
  try {
    storage?.removeItem(clave)
    return true
  } catch {
    // No se pudo borrar. La ventana de reintento acota el daño: dentro de
    // VENTANA_REINTENTO_MS una revisión de este bucket se tomaría por
    // reintento y no insertaría fila. Se informa para poder registrarlo.
    return false
  }
}

// Solo para tests: el respaldo en memoria es global al módulo y hay que poder
// dejarlo limpio entre casos.
export function _resetMemoria() {
  memoria.clear()
}
