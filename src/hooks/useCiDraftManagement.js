import { toISODate } from '../lib/dateUtils'
import { debeReanudarTramo } from '../lib/sessionPersistence'
import { earliestTurnoStart } from '../lib/dataEntry/draftCounts'

function todayStr() {
  return toISODate(new Date())
}

// Extraído de DataEntry.jsx (revisión 2026-09, séptimo corte del refactor —
// ver useCiTabLease.js, useCiHeartbeat.js, useCiDraftAutosave.js,
// useCiDraftHydration.js, useCiSessionActions.js y useCiSessionHistory.js
// para los seis anteriores). Las dos acciones del panel "otros borradores
// sin terminar": reanudar uno (activa la sesión y funde su alcance con el
// actual, nunca lo reemplaza) y descartarlo (borra el borrador y limpia
// cualquier rastro en memoria para que no "resucite"). Sin cambios de
// comportamiento.
//
// @param {object} p
// @param {string} p.date
// @param {boolean} p.sessionActive
// @param {import('react').RefObject<number|null>} p.sessionStartRef
// @param {Function} p.setSessionActive
// @param {Function} p.setUiCity
// @param {Function} p.setActiveTukTuk
// @param {Function} p.setActiveSpecialCat
// @param {Function} p.setDate
// @param {Function} p.setMsg
// @param {Function} p.setPendingScopeMembers
// @param {Function} p.setPendingExtraFronts
// @param {Function} p.setTouchedFronts
// @param {(key: string) => void} p.markJustFinished
// @param {Function} p.setActiveDrafts
// @param {Function} p.setDraftScanTick
// @param {Function} p.setEntriesByCity
// @param {Function} p.setIndriveByCity
// @param {Function} p.setEtaByCity
// @param {Function} p.setDiscByCity
// @param {Function} p.setNaByCity
// @param {Function} p.setSurgeByCity
// @param {Function} p.setErrorKeysByCity
// @param {Function} p.setLoadedCombosByCity
// @param {Function} p.setTurnoTimingsByCity
// @param {import('react').RefObject<Set<string>>} p.hydratedCitiesRef
// @returns {{ resumeDraft: (d: object) => void, discardDraft: (d: object) => void }}
export function useCiDraftManagement({
  date,
  sessionActive,
  sessionStartRef,
  setSessionActive,
  setUiCity,
  setActiveTukTuk,
  setActiveSpecialCat,
  setDate,
  setMsg,
  setPendingScopeMembers,
  setPendingExtraFronts,
  setTouchedFronts,
  markJustFinished,
  setActiveDrafts,
  setDraftScanTick,
  setEntriesByCity,
  setIndriveByCity,
  setEtaByCity,
  setDiscByCity,
  setNaByCity,
  setSurgeByCity,
  setErrorKeysByCity,
  setLoadedCombosByCity,
  setTurnoTimingsByCity,
  hydratedCitiesRef,
}) {
  function resumeDraft(d) {
    // Bug real (revisión adversarial 2026-07-23): reanudar OTRO borrador
    // FUERA del alcance "Ambos" declarado (2+ miembros pendientes) pisaba
    // `pendingScopeMembers`/`uiCity` sin que el punto abandonado quedara
    // nunca marcado como terminado — la sesión original no volvía a poder
    // cerrarse bien. Reanudar un borrador que SÍ es parte del alcance
    // actual (ej. el otro punto declarado) sigue permitido sin más.
    const targetUi = d.resume?.uiCity ?? d.city
    // El alcance vive en espacio bucketKey (ver `resolvedStartMembers`).
    const targetBucket = d.bucketKey || targetUi
    // Ya NO hay guard acá: el bloqueo original existía porque reanudar
    // PISABA el alcance y dejaba los frentes declarados huérfanos. Ahora se
    // fusiona (ver abajo), así que reanudar es seguro — y mantenerlo era
    // incoherente con las pestañas, que desde el pedido 2b van libres: el hub
    // podía pararse en Corp pero no reanudar el borrador de Corp.
    // Reanudar es una señal explícita de "seguir trabajando" — activar la
    // sesión ya mismo (mismo criterio que "Abrir" del historial), no esperar
    // a que la hidratación async lo detecte sola.
    if (!sessionActive) {
      // Idem: reanudar un borrador de OTRA fecha, o de una jornada ya
      // cerrada, arranca un tramo nuevo en vez de heredar el reloj.
      sessionStartRef.current = debeReanudarTramo({
        loadDate: d.date,
        today: todayStr(),
        timings: d.turnoTimings,
      })
        ? earliestTurnoStart(d.turnoTimings) || Date.now()
        : Date.now()
      setSessionActive(true)
    }
    if (d.resume?.tukTuk) {
      setUiCity(d.resume.uiCity)
      setActiveTukTuk(d.resume.zone)
      setActiveSpecialCat(null)
    } else if (d.resume?.specialCat) {
      setUiCity(d.resume.uiCity)
      setActiveTukTuk(null)
      setActiveSpecialCat(d.resume.specialCat)
    } else {
      setUiCity(d.resume?.uiCity ?? d.city)
      setActiveTukTuk(null)
      setActiveSpecialCat(null)
    }
    setDate(d.date)
    setMsg(null)
    // Reanudar un borrador de-alcance-único (no relanza un "Ambos" — se puede
    // ampliar a mano con "+ agregar Punto B" si hace falta). Si el borrador
    // reanudado YA era parte del alcance "Ambos" actual (guard de arriba), no
    // hay que achicar `pendingScopeMembers` a un solo miembro — el otro
    // punto declarado sigue pendiente.
    // FUSIONAR, nunca pisar (bug real, revisión adversarial 2026-07-24):
    // reemplazar el alcance borraba los frentes declarados que seguían a medias
    // (ej. Punto A+B) sin registrarlos en ningún lado — "Terminar Sesión"
    // después cerraba la sesión como final y ese trabajo quedaba abandonado sin
    // aviso. Sumar es siempre seguro: de más, obliga a cerrar algo que el hub
    // igual tenía a medias.
    setPendingScopeMembers((prev) => (prev.includes(targetBucket) ? prev : [...prev, targetBucket]))
  }

  function discardDraft(d) {
    try {
      localStorage.removeItem(d.key)
    } catch {
      /* ignore */
    }
    markJustFinished(d.key)
    setActiveDrafts((prev) => prev.filter((x) => x.key !== d.key))
    setDraftScanTick((tk) => tk + 1)
    // Bug real (revisión adversarial 2026-07-23): descartar el borrador de
    // un punto declarado en un alcance "Ambos" (ej. abandonar Punto A
    // mientras se sigue con Punto B) no lo sacaba de `pendingScopeMembers`
    // — al terminar el punto que SÍ se completó, `remainingAfterThis` nunca
    // vaciaba (el descartado seguía "pendiente" para siempre) y la sesión
    // jamás cerraba, además de reenviar al hub a rellenar desde cero un
    // punto que él mismo acababa de vaciar. Descartar equivale a decidir
    // que ese punto ya no forma parte de esta sesión.
    // El alcance vive en espacio bucketKey (`resolvedStartMembers`), NO en
    // uiCity. En TukTuk el uiCity es la ciudad BASE ('Lima') mientras el
    // alcance es 'TT~Lima~Comas'; y en Colombia el uiCity es 'Bogotá' con
    // dbName 'Bogota'. Filtrando por uiCity el miembro nunca salía del alcance:
    // `isFinalInScope` no se cumplía NUNCA, el botón decía "Terminar punto"
    // para siempre, el latido no se borraba y el hub quedaba "en vivo" en
    // Monitoreo indefinidamente. La única salida era rellenar de cero la grilla
    // que acababa de descartar.
    //
    // Aeropuerto no lo sufría porque ahí uiName === dbName en las configs
    // sembradas — por eso el fix de 2026-07-23 pareció completo.
    //
    // Las dos líneas de abajo YA usaban d.bucketKey: la asimetría delataba el
    // olvido.
    const discardedScope = d.bucketKey ?? d.resume?.uiCity ?? d.city
    setPendingScopeMembers((prev) =>
      prev.includes(discardedScope) ? prev.filter((m) => m !== discardedScope) : prev
    )
    // Mismo criterio para un frente extra (punto 2) descartado: ya no debe
    // seguir bloqueando "Terminar Sesión" en las demás vistas.
    if (d.bucketKey) {
      setPendingExtraFronts((prev) =>
        prev.includes(d.bucketKey) ? prev.filter((bk) => bk !== d.bucketKey) : prev
      )
      // Igual que en handleFinishSession: si sigue "tocado", el efecto de
      // registro lo vuelve a agregar y el frente descartado revive.
      setTouchedFronts((prev) => prev.filter((bk) => bk !== d.bucketKey))
    }
    // Si el borrador descartado es de la FECHA/contexto actual, su rebanada
    // puede seguir viva en memoria (y la ciudad marcada como hidratada). Sin
    // limpiarla, volver a esa pestaña mostraría los datos "descartados" y el
    // autosave/flush los reescribiría → el borrador resucita (mismo problema que
    // el fix de Terminar Sesión). Si es de OTRA fecha, no hay rebanada en memoria
    // (se limpian al cambiar de fecha): alcanza con borrar la clave.
    if (d.date !== date) return
    const dc = d.bucketKey // rebanada en memoria = bucketKey (por-distrito en TukTuk)
    if (!dc) return
    const dropCity = (setter) =>
      setter((prev) => {
        if (!(dc in prev)) return prev
        const n = { ...prev }
        delete n[dc]
        return n
      })
    dropCity(setEntriesByCity)
    dropCity(setIndriveByCity)
    dropCity(setEtaByCity)
    dropCity(setDiscByCity)
    dropCity(setNaByCity)
    dropCity(setSurgeByCity)
    dropCity(setErrorKeysByCity)
    dropCity(setLoadedCombosByCity)
    dropCity(setTurnoTimingsByCity)
    // Re-permitir hidratar esa ciudad: al volver, re-lee localStorage (ya vacío)
    // y muestra la grilla limpia en vez de la rebanada en memoria vieja.
    hydratedCitiesRef.current.delete(dc)
  }

  return { resumeDraft, discardDraft }
}
