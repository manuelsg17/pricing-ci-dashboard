// ════════════════════════════════════════════════════════════════════════
// "Qué frentes tienen trabajo que todavía no está en el servidor".
//
// POR QUÉ EXISTE
// "Guardar progreso" guarda SOLO el frente donde estás parado. Eso nunca se
// dijo en pantalla, y el 2026-08-11 costó datos de verdad: dos hubs midiendo
// Corporativo apretaron Guardar estando en la pestaña de TukTuk y se fueron
// convencidos de haber guardado Corp. No fue un bug del guardado — guardó
// exactamente lo que decía guardar — fue que el botón no decía QUÉ guardaba.
//
// Esto alimenta las tres cosas que lo cierran: el nombre del frente en el
// botón, el aviso de lo que queda afuera, y la cola de "Guardar todo".
//
// Vive fuera de DataEntry.jsx porque DataEntry es un god-component que importa
// CSS y media app: nada de lo que viva ahí adentro se puede correr en Node, y
// esto SÍ hay que testearlo (ver scripts/test-frentes-pendientes.mjs).
// ════════════════════════════════════════════════════════════════════════

export const EMPTY_FRENTES = []

/**
 * ¿Este frente está 100% en el servidor?
 *
 * Misma comparación de contadores que `estadoDeGuardado` (sessionPersistence.js)
 * y a propósito: un segundo criterio para "está guardado" es exactamente el
 * pecado que CLAUDE.md §4 prohíbe — divergirían y el aviso mentiría en algún
 * borde.
 *
 * `savedSeq < 0` significa "en esta carga de página nunca se guardó este
 * frente". Tras un F5 los dos contadores arrancan vacíos, así que un borrador
 * rescatado de localStorage cae acá y se lo trata como PENDIENTE aunque quizá
 * ya estuviera guardado antes de la recarga. Es deliberado: el error caro es el
 * opuesto (decirle "ya está" a alguien que perdería el trabajo), y re-guardar
 * de más no rompe nada — el guardado es DELETE+INSERT por ruta exacta, o sea
 * idempotente.
 */
export function frenteGuardado({ editSeq = 0, savedSeq = -1 } = {}) {
  return savedSeq >= 0 && editSeq <= savedSeq
}

/**
 * Los frentes con trabajo sin asegurar, en el orden en que llegaron.
 *
 * `llenoPorFrente[bucket]` es la cuenta de celdas atendidas de ese frente, con
 * la MISMA convención que `buildFronts`: `null` = no lo sé (el hub no volvió a
 * abrir ese frente en esta carga de página, así que no hay rebanada en
 * memoria). Un frente desconocido NO se lista: no se puede prometer guardarlo
 * si no se tiene el dato, y afirmar "tenés N sin guardar" sobre algo que no se
 * midió sería inventar.
 */
export function frentesSinGuardar({
  fronts = EMPTY_FRENTES,
  llenoPorFrente = {},
  editSeq = {},
  savedSeq = {},
} = {}) {
  const vistos = new Set()
  const out = []
  // `fronts = EMPTY_FRENTES` en la firma solo cubre `undefined`, no `null`.
  // `pendingExtraFronts` y compañía se limpian a mano en varios puntos de
  // DataEntry, así que llegar con null acá es plausible — y reventar dejaría
  // la pantalla en blanco por un aviso informativo.
  for (const bucket of fronts || EMPTY_FRENTES) {
    if (!bucket || vistos.has(bucket)) continue
    vistos.add(bucket)
    const lleno = llenoPorFrente[bucket]
    // null/undefined = desconocido; 0 = sabido y vacío. Los dos quedan afuera,
    // pero por motivos distintos y conviene no confundirlos al leer esto.
    if (lleno == null || lleno <= 0) continue
    if (frenteGuardado({ editSeq: editSeq[bucket] ?? 0, savedSeq: savedSeq[bucket] ?? -1 }))
      continue
    out.push({ bucket, lleno })
  }
  return out
}
