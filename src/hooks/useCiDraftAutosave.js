import { useRef, useEffect, useCallback } from 'react'
import { SESSION_ID } from '../lib/supabase'
import { countFilledEntries, hasMeaningfulIndriveExtra } from '../lib/dataEntry/draftCounts'
import { leaseKey, ownsLease, serializeLease } from '../lib/tabLease'

const EMPTY_OBJ = {}
const EMPTY_SET = new Set()

// Extraído de DataEntry.jsx (revisión 2026-09, tercer corte del refactor —
// ver useCiTabLease.js y useCiHeartbeat.js para los dos anteriores).
// Autosave con debounce+techo (durabilidad R1) + flush síncrono al cambiar
// de ciudad/fecha o al cerrar la pestaña (durabilidad R2). Sin cambios de
// comportamiento — misma lógica, mismos comentarios de por qué.
//
// La HIDRATACIÓN del borrador (leerlo al montar/cambiar de ciudad) se queda
// en DataEntry.jsx: está entrelazada con demasiado estado de sesión
// (sessionActive, pendingScopeMembers, el auto-load de servidor) como para
// separarla sin arriesgar ese camino — es la clase de bug más cara del
// proyecto (CLAUDE.md §1) y no se toca a la ligera.
//
// @param {object} p
// @param {object} p.entries
// @param {object} p.indriveExtra
// @param {object} p.etaEntries
// @param {object} p.discEntries
// @param {boolean} p.surge
// @param {Set<string>} p.naKeys
// @param {string} p.draftKey
// @param {string} p.bucketKey
// @param {(key: string) => boolean} p.isJustFinished
// @param {string[]} p.pendingScopeMembers
// @param {unknown} p.pendingExtraFronts
// @param {unknown} p.turnoTimings
// @param {import('react').RefObject<boolean>} p.draftHydratedRef
// @param {import('react').RefObject<boolean>} p.leaseOwnerRef
// @param {import('react').RefObject<object>} p.perCityRef
// @param {import('react').RefObject<object>} p.actividadRef
// @param {import('react').RefObject<object>} p.editSeqRef
// @param {import('react').RefObject<object>} p.savedSeqRef
// @param {(v: number|null) => void} p.setLastDraftSavedAt
// @param {(v: boolean) => void} p.setStorageFailed
// @returns {{ persistirBorrador: (flushCity: string, flushKey: string) => void, clearDraft: () => void }}
export function useCiDraftAutosave({
  entries,
  indriveExtra,
  etaEntries,
  discEntries,
  surge,
  naKeys,
  draftKey,
  bucketKey,
  isJustFinished,
  pendingScopeMembers,
  pendingExtraFronts,
  turnoTimings,
  draftHydratedRef,
  leaseOwnerRef,
  perCityRef,
  actividadRef,
  editSeqRef,
  savedSeqRef,
  setLastDraftSavedAt,
  setStorageFailed,
}) {
  // Techo de espera del autosave (SESIONES_HALLAZGOS/durabilidad R1).
  //
  // El debounce era TRAILING PURO: cada tecla cancelaba el timer y lo
  // reprogramaba a 1500 ms. Un hub que teclea con pausas de menos de 1,5s
  // —o sea, un hub rápido— NUNCA disparaba el autosave. Simulado: 400 celdas
  // tecleadas cada 1499 ms = CERO escrituras en 10 minutos. El peor caso no
  // estaba acotado por 1,5s sino por cuánto aguantaba la persona sin pausar,
  // y ante un apagón se perdía toda esa racha.
  //
  // Con el techo, entre la primera tecla pendiente y la escritura nunca pasan
  // más de 3 segundos, sin perder el debounce en el uso normal.
  //
  // Costo: el JSON.stringify del borrador más grande medido son 0,042 ms, y
  // la grilla YA re-renderiza en cada tecla (setEntry hace setEntriesByCity y
  // no hay React.memo en src/components/dataentry/ — verificado). Así que esto
  // no agrega ninguna reconciliación que no esté ocurriendo, y no entra en
  // conflicto con los fixes P0/P1 de re-render de CLAUDE.md §5.
  const DEBOUNCE_BORRADOR_MS = 1500
  const TECHO_BORRADOR_MS = 3000
  const pendienteDesdeRef = useRef(null)

  useEffect(() => {
    if (!draftHydratedRef.current) return
    if (pendienteDesdeRef.current == null) pendienteDesdeRef.current = Date.now()
    const espera = Math.max(
      0,
      Math.min(DEBOUNCE_BORRADOR_MS, TECHO_BORRADOR_MS - (Date.now() - pendienteDesdeRef.current))
    )
    const id = setTimeout(() => {
      pendienteDesdeRef.current = null
      // Otra pestaña es la dueña del borrador (P1-10): esta NO escribe. Se
      // relee del storage y no del estado de React porque el lease pudo
      // cambiar durante el debounce.
      if (!leaseOwnerRef.current) return
      // Recién Terminada/Descartada: no reescribir por unos segundos, sin
      // importar qué diga `entries` en este momento (ver guardia arriba).
      if (isJustFinished(draftKey)) return
      try {
        const hasData =
          countFilledEntries(entries) > 0 ||
          countFilledEntries(etaEntries) > 0 ||
          countFilledEntries(discEntries) > 0 ||
          hasMeaningfulIndriveExtra(indriveExtra) ||
          naKeys.size > 0
        if (hasData) {
          const savedAt = Date.now()
          localStorage.setItem(
            draftKey,
            JSON.stringify({
              entries,
              indriveExtra,
              etaEntries,
              discEntries,
              surge,
              naKeys: Array.from(naKeys),
              // Alcance declarado (Aeropuerto "Ambos") — persistido para que
              // un refresh a mitad del PRIMER punto no lo "olvide" y deje
              // terminar la sesión entera con uno solo. Ver restauración en
              // el efecto de hidratación de DataEntry.jsx.
              pendingScopeMembers,
              // Frentes extra (Aeropuerto↔TukTuk simultáneo, punto 2) —
              // mismo motivo que pendingScopeMembers: sobrevivir un refresh
              // a mitad de trabajo sin perder el aviso de "todavía falta".
              pendingExtraFronts,
              turnoTimings,
              // LA TRAZA DEBE SOBREVIVIR AL F5 — lo dice idleDetection.js en su
              // cabecera y CLAUDE.md §2. Vivía SOLO en `actividadRef`, que nace
              // vacío en cada montaje: tras una recarga, `active_minutes` medía
              // desde el F5 y todo lo trabajado antes se escribía como
              // `idle_minutes`, con `actividadMedida = true`. O sea marcado
              // como medición buena.
              //
              // Medido: un F5 a las 12:30 de una jornada de 3 h escribía
              // active=30 / idle=150. Y `activity_trace` —el dato crudo que se
              // guarda justamente para recalibrar el umbral— viajaba truncado.
              actividad: actividadRef.current[bucketKey] || [],
              // Ver la restauración en el efecto de hidratación: sin esto, el
              // aviso de "sin guardar" daba falso positivo tras cada F5.
              editSeq: editSeqRef.current[bucketKey] ?? 0,
              savedSeq: savedSeqRef.current[bucketKey] ?? -1,
              savedAt,
            })
          )
          setLastDraftSavedAt(savedAt)
          setStorageFailed(false)
        } else {
          localStorage.removeItem(draftKey)
          setLastDraftSavedAt(null)
        }
      } catch {
        // Ver `storageFailed`: dejar esto mudo es lo que convertía un
        // navegador sin espacio en una pérdida silenciosa de trabajo.
        setStorageFailed(true)
      }
    }, espera)
    return () => clearTimeout(id)
  }, [
    entries,
    indriveExtra,
    etaEntries,
    discEntries,
    surge,
    naKeys,
    draftKey,
    isJustFinished,
    pendingScopeMembers,
    pendingExtraFronts,
    turnoTimings,
    // `bucketKey` entró a las dependencias al empezar a persistir la traza de
    // actividad, que se guarda por bucket. Re-disparar el autosave al cambiar
    // de bucket es correcto: es lo mismo que ya hace `draftKey`.
    bucketKey,
    // Refs: identidad estable entre renders, se agregan solo para que
    // exhaustive-deps no las marque (no disparan re-ejecuciones).
    draftHydratedRef,
    leaseOwnerRef,
    actividadRef,
    editSeqRef,
    savedSeqRef,
    setLastDraftSavedAt,
    setStorageFailed,
  ])

  // Flush SÍNCRONO del borrador al cambiar de ciudad/fecha o al SALIR de la
  // página (desmontar / navegar). El autosave con debounce podría no haber
  // disparado sus últimos ~1.5s; sin este flush, cambiar de ciudad y luego
  // refrescar perdía las últimas celdas de la ciudad vieja. Se capturan la
  // ciudad y la clave de ESTA corrida; el cleanup lee la rebanada de ESA ciudad
  // desde perCityRef (que retiene todas las ciudades), así flushea la ciudad
  // vieja bajo su clave vieja aunque ya se haya cambiado de ciudad.
  // Persistencia síncrona del borrador. Se usa desde DOS lugares: el cleanup
  // del efecto (cambio de ciudad/fecha, navegación interna) y el evento
  // `pagehide` (cerrar pestaña, cerrar navegador, bfcache, móvil).
  //
  // `pagehide` es necesario porque React NO corre cleanups de efectos al
  // descargar la página, y el `beforeunload` de más abajo solo muestra el
  // diálogo del navegador: no persiste nada. Sin esto, cerrar la pestaña
  // perdía todo lo tecleado desde la última escritura del autosave
  // (durabilidad R2). `pagehide` es el único evento confiable para esto —
  // `beforeunload` no dispara en móvil ni con bfcache.
  //
  // NO ayuda en un apagón: ahí no corre ningún evento. Para eso está el techo
  // del autosave (R1, arriba).
  const persistirBorrador = useCallback(
    (flushCity, flushKey) => {
      // Corre desde pagehide/visibilitychange y desde el cleanup del efecto:
      // clausuras que pueden tener un valor viejo. Por eso se lee el ref, que
      // siempre tiene la verdad del último render.
      if (!leaseOwnerRef.current) return
      if (isJustFinished(flushKey)) return
      try {
        const m = perCityRef.current
        const ent = m.entriesByCity[flushCity] || EMPTY_OBJ
        const ind = m.indriveByCity[flushCity] || EMPTY_OBJ
        const eta = m.etaByCity[flushCity] || EMPTY_OBJ
        const disc = m.discByCity[flushCity] || EMPTY_OBJ
        const na = m.naByCity[flushCity] || EMPTY_SET
        const hasData =
          countFilledEntries(ent) > 0 ||
          countFilledEntries(eta) > 0 ||
          countFilledEntries(disc) > 0 ||
          hasMeaningfulIndriveExtra(ind) ||
          na.size > 0
        if (hasData) {
          // Se MERGEA sobre lo que el autosave ya escribió, en vez de
          // reemplazarlo.
          //
          // Bug real (causa del "el contador se les reinicia", 2026-08-01):
          // este flush escribía un objeto NUEVO de 7 campos y pisaba los 10
          // del autosave — y como el cleanup del autosave cancela su timer
          // pendiente, esta era siempre la última escritura de la clave. Se
          // perdían tres campos, en orden de gravedad:
          //   · `turnoTimings` → al rehidratar, `earliestTurnoStart` devolvía
          //     null y `sessionStartRef` caía a Date.now(): cronómetro en
          //     00:00. Es el bug histórico #2 de sessionStartRef reintroducido
          //     por otro camino (CLAUDE.md §2).
          //   · `pendingScopeMembers` → un Aeropuerto con alcance "Ambos"
          //     volvía a alcance de un solo punto: el hub terminaba en A y la
          //     sesión cerraba como final SIN avisar que faltaba B, que
          //     quedaba sin medir y sin que nadie se enterara.
          //   · `pendingExtraFronts` → mismo problema con frentes simultáneos.
          //
          // Mergear en vez de enumerar campos hace que esto no se pueda
          // volver a romper: si mañana el autosave persiste un campo nuevo,
          // este flush lo conserva sin necesidad de conocerlo.
          let previo = {}
          try {
            previo = JSON.parse(localStorage.getItem(flushKey) || '{}') || {}
          } catch {
            previo = {}
          }
          localStorage.setItem(
            flushKey,
            JSON.stringify({
              ...previo,
              entries: ent,
              indriveExtra: ind,
              etaEntries: eta,
              discEntries: disc,
              surge: m.surgeByCity[flushCity] ?? false,
              naKeys: Array.from(na),
              // El flush cubre los ≤3 s entre el último autosave y el
              // pagehide: sin la traza acá, ese tramo final se perdía igual.
              actividad: actividadRef.current[flushCity] || previo.actividad || [],
              editSeq: editSeqRef.current[flushCity] ?? previo.editSeq ?? 0,
              savedSeq: savedSeqRef.current[flushCity] ?? previo.savedSeq ?? -1,
              savedAt: Date.now(),
            })
          )
        }
      } catch {
        setStorageFailed(true)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isJustFinished]
  )

  useEffect(() => {
    const flushCity = bucketKey
    const flushKey = draftKey
    return () => persistirBorrador(flushCity, flushKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey])

  // Cierre de pestaña / navegador / bfcache. Se lee el bucket y la clave de un
  // ref para que el listener no se re-suscriba en cada cambio de ciudad.
  const flushScopeRef = useRef({ bucketKey, draftKey })
  flushScopeRef.current = { bucketKey, draftKey }
  useEffect(() => {
    const onPageHide = () => {
      const f = flushScopeRef.current
      persistirBorrador(f.bucketKey, f.draftKey)
      // Al cerrar/recargar, el candado se marca OCIOSO en vez de borrarse.
      //
      // React no corre cleanups al descargar, así que sin esto cerrar la
      // pestaña dejaba el candado tomado hasta el TTL: el hub reabría y se
      // encontraba en modo lectura dos minutos y medio, sin ninguna otra
      // pestaña abierta.
      //
      // Pero BORRARLO tampoco sirve, y lo verifiqué en navegador: un F5 le
      // entregaba el candado a la otra pestaña, aunque la que recarga sea la
      // que tiene el trabajo. Marcarlo ocioso resuelve los dos casos —
      // `evaluateLease` deja reclamar un candado ocioso a quien SÍ tiene
      // trabajo, y el dueño original lo recupera solo al volver porque
      // conserva su SESSION_ID (sessionStorage sobrevive el F5).
      try {
        const lk = leaseKey(f.draftKey)
        if (ownsLease(localStorage.getItem(lk), SESSION_ID)) {
          localStorage.setItem(
            lk,
            serializeLease({ sid: SESSION_ID, now: Date.now(), engaged: false })
          )
        }
      } catch {
        /* sin storage no hay candado que marcar */
      }
    }
    window.addEventListener('pagehide', onPageHide)
    // `visibilitychange` cubre el caso de cerrar la tapa de la laptop o pasar
    // la app a segundo plano en un celular, donde `pagehide` puede no llegar.
    // `visibilitychange` cubre la DURABILIDAD (tapa de la laptop, app a segundo
    // plano en el celular, donde `pagehide` puede no llegar): solo persiste el
    // borrador. NO marca el candado como ocioso.
    //
    // POR QUÉ NO. Cambiar de pestaña no es cerrar la pestaña: esta sigue siendo
    // la que tiene el trabajo. Marcarla ociosa le entregaba el candado a la
    // otra, y como no hay handler de `visible`, al volver NO se recuperaba —
    // quedaba en solo lectura, sin autosave ni flush, mientras el hub seguía
    // tecleando. Todo lo escrito desde ese momento se perdía en el próximo F5.
    //
    // Y basta un alt-tab al simulador del competidor, que es el flujo NORMAL de
    // carga: la otra pestaña de la app ya estaba oculta, nunca vuelve a
    // disparar `hidden`, y su candado queda vivo para siempre.
    //
    // Si la pestaña muere de verdad sin `pagehide`, el candado vence solo por
    // TTL — que es exactamente para lo que existe el TTL.
    const onHidden = () => {
      if (document.visibilityState === 'hidden') {
        const f = flushScopeRef.current
        persistirBorrador(f.bucketKey, f.draftKey)
      }
    }
    document.addEventListener('visibilitychange', onHidden)
    return () => {
      window.removeEventListener('pagehide', onPageHide)
      document.removeEventListener('visibilitychange', onHidden)
    }
  }, [persistirBorrador])

  const clearDraft = useCallback(() => {
    try {
      localStorage.removeItem(draftKey)
    } catch {
      /* sin storage no hay nada que borrar */
    }
  }, [draftKey])

  return { persistirBorrador, clearDraft }
}
