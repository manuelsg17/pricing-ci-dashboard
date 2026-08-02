// Escritor único del BORRADOR de "Ingresar CI" — lease por pestaña.
//
// POR QUÉ EXISTE ESTE ARCHIVO
// SESIONES_HALLAZGOS.md P1-10 tiene tres puntos de colisión entre dos
// pestañas del mismo hub. El guard de servidor (mig 191) ya cerró el peor: la
// BASE ya no deja que la pestaña B pise en `pricing_observations` lo que
// guardó la A. Queda la otra mitad, que es puramente de cliente:
//
//   Las dos pestañas escriben la MISMA clave de localStorage
//   `de:draft:{email}:{country}:{viewId}:{date}` con su `entries` COMPLETO.
//   No hay merge, no hay versión, no hay dueño: la última escritura gana y se
//   lleva puestas las celdas que la otra pestaña tenía tipeadas y todavía no
//   había mandado al servidor. Y como el autosave corre cada 1,5-3s, "la
//   última" cambia de pestaña varias veces por minuto.
//
// La solución es un LEASE: una sola pestaña por (usuario, país, vista, fecha)
// tiene permiso de escribir el borrador. Las demás siguen funcionando, pero en
// modo lectura/aviso — ver el parche de integración.
//
// DECISIONES DE DISEÑO (cada una tiene un antecedente en este repo):
//
// 1. NO SE FUSIONAN BORRADORES. Nunca. Es tentador combinar los `entries` de
//    las dos pestañas "para no perder nada", y es exactamente el bug con más
//    antecedentes acá: una celda que el hub BORRÓ a propósito en la pestaña A
//    reaparece porque la pestaña B todavía la tenía en memoria. Es el mismo
//    patrón que el guard anti-resurrección de CLAUDE.md §2 (auto-load que
//    repuebla lo que el usuario cerró a propósito) y que ya costó trabajo real.
//    Un borrado no se distingue de "todavía no lo escribí" mirando dos mapas:
//    ambos son "esta clave no está". Escritor único, y punto.
//
// 2. SE DEGRADA LA PESTAÑA NUEVA, NO LA VIEJA. Quien ya tiene el lease se lo
//    queda. La pestaña vieja es la que puede tener celdas tipeadas y sin
//    guardar; la nueva, por definición, acaba de abrirse y no tiene nada en
//    riesgo. First-writer-wins nunca castiga a quien tiene datos que perder.
//
// 3. EL TTL ES LARGO A PROPÓSITO (ver LEASE_TTL_MS). Un TTL corto no protege
//    más: mata el lease de una pestaña legítima que quedó en segundo plano.
//
// Módulo PURO: no toca localStorage, no lee el reloj salvo por default. Se
// testea con node plano — ver scripts/test-tab-lease.mjs. La extensión .js en
// los imports es OBLIGATORIA (el resolvedor ESM de Node no la infiere; Vite
// sí), mismo criterio que sessionPersistence.js y uploadParsers.js.

// ── Constantes ───────────────────────────────────────────────────────────

// Cuánto vale un lease sin renovar antes de que otra pestaña pueda robarlo.
//
// TIENE QUE SER BASTANTE MAYOR A 60s Y NO ES UN NÚMERO ARBITRARIO. Chrome (y
// Safari, y Firefox) estrangulan los timers de una pestaña en segundo plano a
// **una ejecución por minuto** (intensive throttling, a partir de ~5 min
// oculta). O sea: una pestaña perfectamente viva, con el trabajo del hub
// adentro, renueva su lease cada ~60s aunque le pidamos cada 30.
//
// Con TTL de 60s esa pestaña se declararía muerta sola y la de al lado le
// robaría el borrador — habríamos construido el bug que veníamos a matar, con
// más pasos. El TTL tiene que sobrevivir DOS ciclos estrangulados seguidos
// (2 × 60s) más margen para un GC largo o un tab congelado que despierta.
//
// El costo de un TTL largo está acotado, por eso se puede pagar:
//   · Un F5 NO espera: `SESSION_ID` vive en sessionStorage y sobrevive la
//     recarga, así que la misma pestaña se reconoce dueña y renueva.
//   · Cerrar la pestaña tampoco: el `pagehide` libera el lease (ver parche).
//   · Una pestaña dueña pero OCIOSA se puede reclamar ya, sin esperar el TTL.
// Solo se espera el TTL completo tras un crash duro del navegador, que es
// justo el caso donde apurarse es más peligroso.
export const LEASE_TTL_MS = 150_000

// Cada cuánto renueva la dueña. 30s ≈ el latido de sesión (25s), así que en
// primer plano el lease se refresca 5 veces por TTL. En segundo plano el
// navegador lo baja a ~60s, que sigue siendo 2,5 renovaciones por TTL.
// Invariante: LEASE_RENEW_MS * 3 < LEASE_TTL_MS (verificado en los tests).
export const LEASE_RENEW_MS = 30_000

/**
 * Clave de localStorage del lease para un borrador dado.
 *
 * El prefijo es `de:lease:` y NO `de:draft:` a propósito: DataEntry.jsx
 * escanea localStorage por `de:draft:{email}:{country}:` para listar borradores
 * activos y aplicar el tope de MAX_DRAFTS. Si el lease empezara con ese
 * prefijo, cada lease contaría como un borrador y el hub vería el cartel de
 * "llegaste al máximo de borradores" con la mitad de los que tiene.
 *
 * @returns {string|null} null si el draftKey no es utilizable.
 */
export function leaseKey(draftKey) {
  if (typeof draftKey !== 'string' || draftKey === '') return null
  const PREFIJO_BORRADOR = 'de:draft:'
  return draftKey.startsWith(PREFIJO_BORRADOR)
    ? `de:lease:${draftKey.slice(PREFIJO_BORRADOR.length)}`
    : `de:lease:${draftKey}`
}

/**
 * Lee un lease crudo de localStorage. NUNCA lanza.
 *
 * localStorage es texto que puede haber escrito una versión vieja de la app,
 * otra pestaña a mitad de escritura, o una extensión del navegador. Si un
 * `JSON.parse` sin try/catch tira acá, el efecto que lo llama se rompe y la
 * pestaña se queda sin autosave — o sea, el fallo del guard borraría trabajo
 * en vez de protegerlo. Ante cualquier duda devuelve null, que el evaluador
 * trata como "no hay lease" (camino seguro: se reclama).
 *
 * @returns {{sid: string, at: number, engaged: boolean}|null}
 */
export function parseLease(raw) {
  if (typeof raw !== 'string' || raw === '') return null

  let obj
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  // `JSON.parse('null')`, `'42'`, `'"hola"'` y `'[]'` no lanzan pero tampoco
  // son un lease.
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null

  // Sin dueño identificable el lease no sirve para nada: no se puede renovar
  // ni comparar. Se descarta en vez de inventarle una identidad.
  if (typeof obj.sid !== 'string' || obj.sid === '') return null

  // `at` faltante o basura → 0, que significa "infinitamente viejo" y por lo
  // tanto vencido. La alternativa (tratarlo como recién renovado) dejaría la
  // clave trabada para siempre por un lease corrupto: un deadlock permanente
  // es peor que una reclamación de más.
  //
  // OJO: 0 es un timestamp VÁLIDO y falsy. Nada acá puede usar `if (!at)`
  // para decidir "no tiene timestamp" — es el error clásico que rompe estos
  // guards, y por eso hay un test dedicado.
  const at = Number.isFinite(obj.at) ? obj.at : 0

  // `engaged` se normaliza con `=== true` estricto. Un valor raro ("si", 1,
  // undefined) NO puede bloquear a otra pestaña: en la duda, el dueño se
  // considera ocioso, que es el caso donde el lease se puede ceder.
  return { sid: obj.sid, at, engaged: obj.engaged === true }
}

/**
 * Arma el objeto de lease a persistir. Puro: recibe el reloj.
 *
 * `engaged` = "esta pestaña tiene trabajo en riesgo" (sesión activa o al menos
 * una celda tipeada), NO "esta pestaña existe". La diferencia es toda la
 * regla 4 de evaluateLease.
 */
export function makeLease({ sid, now = Date.now(), engaged = false } = {}) {
  return { sid, at: now, engaged: engaged === true }
}

/** Igual que makeLease pero listo para `localStorage.setItem`. */
export function serializeLease(args) {
  return JSON.stringify(makeLease(args))
}

/**
 * ¿El lease que hay ahora en la clave es MÍO?
 *
 * Se usa para la RELECTURA DE CONFIRMACIÓN después de reclamar. Dos pestañas
 * pueden reclamar en el mismo tick (Chrome restaura varias juntas al recuperar
 * de un crash): las dos ven la clave vacía, las dos escriben, y la segunda
 * escritura gana. Escribir NO es ganar; ganar es volver a leer y encontrarse a
 * uno mismo. Sin este paso las dos pestañas se creerían dueñas y estaríamos
 * como al principio.
 */
export function ownsLease(raw, mySid) {
  const lease = parseLease(raw)
  return !!lease && !!mySid && lease.sid === mySid
}

/**
 * Decide qué hace ESTA pestaña con el lease del borrador.
 *
 * @param {object} p
 * @param {string|null} p.raw        contenido crudo de la clave (o null)
 * @param {string} p.mySid           SESSION_ID de esta pestaña (por pestaña,
 *                                   sobrevive un F5, muere con la pestaña)
 * @param {number} p.now             reloj
 * @param {number} p.ttlMs           TTL a aplicar
 * @param {boolean} p.myEngaged      ¿ESTA pestaña tiene trabajo en riesgo?
 * @returns {{action: 'claim'|'renew'|'demote', reason: string}}
 */
export function evaluateLease({
  raw,
  mySid,
  now = Date.now(),
  ttlMs = LEASE_TTL_MS,
  myEngaged = false,
} = {}) {
  // Sin identidad de pestaña no se puede participar del lease (sessionStorage
  // deshabilitado, Safari privado viejo). Se RECLAMA, no se degrada: degradar
  // dejaría a una pestaña única sin autosave, que es una forma NUEVA de perder
  // trabajo; reclamar, en el peor caso, reproduce el comportamiento que ya
  // había antes de este archivo. Un guard nunca puede ser más destructivo que
  // el bug que previene (CLAUDE.md §5).
  if (typeof mySid !== 'string' || mySid === '') {
    return { action: 'claim', reason: 'sin-identidad' }
  }

  const lease = parseLease(raw)

  // (1) Nadie lo tiene (o está corrupto/ilegible) → tomarlo.
  if (!lease) return { action: 'claim', reason: 'sin-lease' }

  // (2) Es mío → renovar. Va ANTES de mirar la antigüedad a propósito: un
  // lease propio vencido (pestaña que estuvo en segundo plano media hora, o
  // una máquina que volvió de suspensión) se renueva, no se abandona. Y por lo
  // mismo, `at: 0` en un lease propio también renueva.
  if (lease.sid === mySid) return { action: 'renew', reason: 'propio' }

  const edad = now - lease.at

  // (3) Venció: la dueña dejó de renovar hace más de un TTL. `>` y no `>=`:
  // justo en el umbral todavía cuenta como viva (mismo criterio de borde que
  // el resto del proyecto).
  if (edad > ttlMs) return { action: 'claim', reason: 'vencido' }

  // (3b) Reloj hacia atrás. `edad` negativa = el lease está sellado en el
  // FUTURO. Las dos pestañas corren en la misma máquina y comparten reloj, así
  // que esto solo pasa si el reloj del sistema retrocedió (corrección NTP, el
  // usuario cambió la hora) entre la escritura y esta lectura. Un salto chico
  // significa que el lease es genuinamente reciente → NO se roba.
  //
  // Un salto grande (más de un TTL hacia el futuro) es otra cosa: si la dueña
  // murió, ese lease no vencería hasta que el reloj alcance su sello, y la
  // clave quedaría trabada horas. Por eso se trata como inválido y se reclama.
  if (edad < -ttlMs) return { action: 'claim', reason: 'reloj-invertido' }

  // (4) La dueña está viva pero OCIOSA: no tiene sesión ni celdas cargadas.
  // Abrir una segunda pestaña "para mirar" no puede bloquear a la pestaña
  // donde el hub va a trabajar de verdad — el lease es para proteger trabajo,
  // y una pestaña sin trabajo no tiene nada que proteger.
  //
  // POR QUÉ ESTO EXIGE `myEngaged` Y NO ES INCONDICIONAL: si cualquier pestaña
  // pudiera robarle a una ociosa, dos pestañas recién abiertas (las dos
  // ociosas) se robarían el lease mutuamente en cada tick, para siempre —
  // ping-pong, dos "dueñas" alternándose y ninguna estable. Condicionarlo a
  // que la que reclama SÍ tenga trabajo hace la regla asimétrica, y por lo
  // tanto convergente: gana la que tiene datos en riesgo, que es exactamente
  // el criterio de la decisión 2. Con dos ociosas, se queda la que ya lo
  // tenía; en cuanto el hub teclea en la otra, esa pasa a `engaged` y lo toma.
  if (!lease.engaged) {
    if (myEngaged) return { action: 'claim', reason: 'dueno-ocioso' }
    return { action: 'demote', reason: 'ambos-ociosos' }
  }

  // (5) La dueña está viva Y con trabajo. Esta pestaña se degrada, tenga o no
  // datos propios: robarle el borrador a una pestaña que está tipeando es
  // precisamente el bug P1-10.
  return { action: 'demote', reason: 'dueno-activo' }
}
