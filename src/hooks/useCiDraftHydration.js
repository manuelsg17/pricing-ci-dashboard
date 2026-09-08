import { useEffect } from 'react'
import { toISODate } from '../lib/dateUtils'
import { normalizarActividad } from '../lib/idleDetection'
import { capIndriveExtraBids } from '../lib/indriveAvg'
import { debeReanudarTramo, debeHidratarBorrador } from '../lib/sessionPersistence'
import {
  countFilledEntries,
  countAllFilled,
  earliestTurnoStart,
} from '../lib/dataEntry/draftCounts'
import { deleteActiveSession } from './useDataEntryPersistence'

function todayStr() {
  return toISODate(new Date())
}

// Extraído de DataEntry.jsx (revisión 2026-09, cuarto corte del refactor —
// ver useCiTabLease.js, useCiHeartbeat.js y useCiDraftAutosave.js para los
// tres anteriores). Restaura el borrador de localStorage al montar o al
// cambiar de ciudad/fecha/país, y si no hay borrador agenda el auto-load
// del servidor. Sin cambios de comportamiento — misma lógica, mismos
// comentarios de por qué.
//
// A diferencia de los tres cortes anteriores, este NO es un subsistema
// aislado: decide si arranca la sesión, siembra el cronómetro, restaura el
// alcance de Aeropuerto y evita el conflicto falso de la marca de agua
// (durabilidad R3). Por eso recibe (y muta) los mismos refs que el resto de
// DataEntry.jsx usa para lo mismo — `hydratedCitiesRef` en particular se
// lee/escribe también fuera de este hook (terminar sesión, descartar
// borrador, cambio de bucket) y tiene que ser la MISMA instancia, no una
// copia.
//
// @param {object} p
// @param {string} p.bucketKey
// @param {string} p.country
// @param {string} p.date
// @param {string} p.userEmail
// @param {string} p.draftKey
// @param {string} p.legacyDraftKey
// @param {string} p.dbCity
// @param {string|null} p.zone
// @param {boolean} p.sessionActive
// @param {(t: string, params?: object) => string} p.t
// @param {(msg: {type: string, text: string}) => void} p.setMsg
// @param {(city: string, zone: string|null, date: string, savedAt: number|null) => void} p.sincronizarMarcaDesdeBorrador
// @param {(v: object) => void} p.setPendingLoad
// @param {(v: number|null) => void} p.setLastDraftSavedAt
// @param {Function} p.setEntriesByCity
// @param {Function} p.setIndriveByCity
// @param {Function} p.setEtaByCity
// @param {Function} p.setDiscByCity
// @param {Function} p.setNaByCity
// @param {Function} p.setSurgeByCity
// @param {Function} p.setTurnoTimingsByCity
// @param {Function} p.setErrorKeysByCity
// @param {Function} p.setLoadedCombosByCity
// @param {Function} p.setTouchedFronts
// @param {Function} p.setPendingExtraFronts
// @param {Function} p.setPendingScopeMembers
// @param {(v: boolean | ((prev: boolean) => boolean)) => void} p.setSessionActive
// @param {import('react').RefObject<string|null>} p.loadedContextRef
// @param {import('react').RefObject<Set<string>>} p.hydratedCitiesRef
// @param {import('react').RefObject<number|null>} p.sessionStartRef
// @param {import('react').RefObject<object>} p.actividadRef
// @param {import('react').RefObject<object>} p.editSeqRef
// @param {import('react').RefObject<object>} p.savedSeqRef
// @param {import('react').RefObject<boolean>} p.draftHydratedRef
export function useCiDraftHydration({
  bucketKey,
  country,
  date,
  userEmail,
  draftKey,
  legacyDraftKey,
  dbCity,
  zone,
  sessionActive,
  t,
  setMsg,
  sincronizarMarcaDesdeBorrador,
  setPendingLoad,
  setLastDraftSavedAt,
  setEntriesByCity,
  setIndriveByCity,
  setEtaByCity,
  setDiscByCity,
  setNaByCity,
  setSurgeByCity,
  setTurnoTimingsByCity,
  setErrorKeysByCity,
  setLoadedCombosByCity,
  setTouchedFronts,
  setPendingExtraFronts,
  setPendingScopeMembers,
  setSessionActive,
  loadedContextRef,
  hydratedCitiesRef,
  sessionStartRef,
  actividadRef,
  editSeqRef,
  savedSeqRef,
  draftHydratedRef,
}) {
  useEffect(() => {
    draftHydratedRef.current = false
    setLastDraftSavedAt(null)
    const targetCity = bucketKey
    const ctx = `${country}::${date}`
    // ¿Cambió el contexto (país/fecha)? Entonces todas las ciudades cargadas son
    // de la fecha vieja → limpiar TODO y re-permitir hidratar cada ciudad. Se
    // hace acá (no en un effect aparte) para que el orden limpiar→hidratar sea
    // correcto: si estuviera en otro effect, este leería datos "por limpiar" y
    // saltaría la hidratación de la fecha nueva.
    if (loadedContextRef.current !== ctx) {
      loadedContextRef.current = ctx
      hydratedCitiesRef.current = new Set()
      setEntriesByCity({})
      setIndriveByCity({})
      setEtaByCity({})
      setDiscByCity({})
      setErrorKeysByCity({})
      setLoadedCombosByCity({})
      setSurgeByCity({})
      setNaByCity({})
      // Bug real (hallado al generalizar, 2026-07-24): sin esto los timings
      // por turno de la fecha VIEJA sobrevivían al cambio de fecha, y como el
      // efecto de estampado nunca pisa un `startedAt` ya existente, la sesión
      // de la fecha nueva heredaba la hora de inicio de la anterior — una
      // duración por turno de horas o días, silenciosamente falsa.
      setTurnoTimingsByCity({})
      // Los frentes pendientes son de la fecha VIEJA (bucketKey no lleva
      // fecha): sin limpiarlos, el aviso seguía exigiendo "completá Corp"
      // pero en la fecha nueva, donde Corp está vacío — y completarlo ahí
      // escribía observaciones con la fecha equivocada.
      setTouchedFronts([])
      setPendingExtraFronts([])
      setPendingScopeMembers([])

      // Y la SESIÓN también se cierra (SESIONES_HALLAZGOS.md P1-7).
      //
      // Hasta acá se limpiaba todo el estado de trabajo pero `sessionActive`
      // y `sessionStartRef` quedaban intactos: el hub cambiaba la fecha para
      // corregir algo de ayer y el cronómetro seguía corriendo desde la hora
      // de la fecha anterior. El próximo "Terminar" insertaba en ci_sessions
      // una duración que incluía todo el trabajo de OTRO día.
      //
      // Cambiar de fecha es tan inequívoco como cambiar de país: se abandona
      // la sesión en curso. Lo ya guardado con "Guardar Progreso" queda
      // intacto en la BD; esto solo cierra el estado en vivo.
      if (sessionActive) {
        setSessionActive(false)
        sessionStartRef.current = null
        if (userEmail) {
          deleteActiveSession(userEmail).then(
            () => {},
            () => {}
          )
        }
      }
    }
    // Hidratar esta ciudad UNA vez por contexto. Al intercalar A↔B, la 2da vez
    // ya está en el set → no se re-hidrata (la memoria, más nueva, manda).
    //
    // `userEmail &&` NO es defensivo: es la corrección de una PÉRDIDA DE DATOS
    // real, reproducida en navegador contra local (2026-08-02).
    //
    // `draftKey` lleva el email adentro (`de:draft:<email>:<país>:<vista>:<fecha>`)
    // y `userEmail` llega ASÍNCRONO, después del primer render. Sin este guard
    // la secuencia era:
    //
    //   1. Monta con userEmail vacío → draftKey queda `de:draft::Peru:Lima:…`
    //      (segmento del email en blanco) → no encuentra NINGÚN borrador.
    //   2. Igual marca la ciudad en `hydratedCitiesRef`, así que cuando el
    //      email llega y `draftKey` cambia, el efecto vuelve a correr pero ya
    //      NO re-hidrata: el borrador bueno queda huérfano para siempre.
    //   3. Como `draftApplied` quedó en false, se agenda el auto-load del
    //      servidor. Ese llega con la grilla en memoria vacía, así que
    //      `conservarTecleado` cae en la rama `!actual` y REEMPLAZA entero.
    //   4. El autosave escribe ese estado —el del servidor— encima del
    //      borrador. El trabajo sin guardar del hub desaparece del disco.
    //
    // Medido: borrador con 7 celdas → 4 después de un F5, y un valor editado
    // (88.88) revertido al del servidor (11.01). Es exactamente el "estado que
    // debe sobrevivir un F5" de CLAUDE.md §2, y la clase de bug más repetida
    // del proyecto.
    //
    // El guard alcanza porque `draftKey` ya está en las dependencias del
    // efecto: apenas el email aparece, el efecto se re-dispara y esta vez
    // hidrata con la clave correcta, ANTES de que nadie marque la ciudad.
    //
    // La decisión vive en `debeHidratarBorrador` (src/lib/sessionPersistence.js)
    // y tiene sus propias pruebas — así la regla no se puede volver a perder
    // en una línea suelta de este componente.
    if (
      debeHidratarBorrador({ userEmail, yaHidratado: hydratedCitiesRef.current.has(targetCity) })
    ) {
      hydratedCitiesRef.current.add(targetCity)
      let draftApplied = false
      // Momento de la última escritura del borrador — lo necesita R3 para
      // decidir si la marca del servidor es más vieja que lo que hay acá.
      let borradorSavedAt = null
      try {
        let raw = localStorage.getItem(draftKey)
        // Migración única de borradores del formato viejo (sin email, previo
        // a la revisión de aislamiento por usuario) — adoptarlo para QUIEN
        // esté mirando esta ciudad+fecha ahora mismo, igual que ya pasaba de
        // hecho hasta hoy, pero de acá en más queda escrito bajo la clave
        // nueva (por usuario) y la vieja se borra — no vuelve a ser visible
        // para otro hub que entre después en la misma compu.
        let migratedFromLegacy = false
        if (!raw && userEmail) {
          const legacyRaw = localStorage.getItem(legacyDraftKey)
          if (legacyRaw) {
            raw = legacyRaw
            migratedFromLegacy = true
          }
        }
        if (raw) {
          const parsed = JSON.parse(raw)
          const etaFilled = countFilledEntries(parsed.etaEntries)
          const discFilled = countFilledEntries(parsed.discEntries)
          const { capped, avgUpdates } = capIndriveExtraBids(parsed.indriveExtra || {})
          const mergedEntries = { ...parsed.entries, ...avgUpdates }
          // Contar incluyendo celdas InDrive solo-recomendado (viven en
          // indriveExtra) — si acá se usara solo countFilledEntries(entries), un
          // borrador rec-only daría count 0 y NO se restauraría: el recomendado
          // se perdía en silencio pese a que el autosave sí lo persistió.
          const restored = countAllFilled(mergedEntries, capped)
          const naArr = Array.isArray(parsed.naKeys) ? parsed.naKeys : []
          if (restored > 0 || etaFilled > 0 || discFilled > 0 || naArr.length > 0) {
            setEntriesByCity((prev) => ({ ...prev, [targetCity]: mergedEntries }))
            setIndriveByCity((prev) => ({ ...prev, [targetCity]: capped }))
            setEtaByCity((prev) => ({ ...prev, [targetCity]: parsed.etaEntries || {} }))
            setDiscByCity((prev) => ({ ...prev, [targetCity]: parsed.discEntries || {} }))
            if (naArr.length) setNaByCity((prev) => ({ ...prev, [targetCity]: new Set(naArr) }))
            if (typeof parsed.surge === 'boolean')
              setSurgeByCity((prev) => ({ ...prev, [targetCity]: parsed.surge }))
            if (parsed.turnoTimings && typeof parsed.turnoTimings === 'object') {
              setTurnoTimingsByCity((prev) => ({ ...prev, [targetCity]: parsed.turnoTimings }))
            }
            // Se FUSIONA con lo que ya haya en memoria —el hub pudo teclear
            // antes de que termine la hidratación async— y se normaliza:
            // `normalizarActividad` ordena y fusiona tramos, así que rehidratar
            // no inventa un hueco donde no lo hubo.
            if (Array.isArray(parsed.actividad)) {
              actividadRef.current[targetCity] = normalizarActividad([
                ...(actividadRef.current[targetCity] || []),
                ...parsed.actividad,
              ])
            }
            setLastDraftSavedAt(parsed.savedAt || null)
            borradorSavedAt = parsed.savedAt || null
            setMsg({
              type: 'ok',
              text: t('dataentry.draft_restored', { n: restored + naArr.length }),
            })
            draftApplied = true
            // Borrador con data real restaurado — activar sesión (mismo
            // motivo que el auto-load de servidor en loadObservationsIntoForm):
            // sessionActive no sobrevive un refresh de página, así que sin
            // esto el hub ve su grilla llena pero solo "Iniciar Sesión" en
            // vez de Guardar/Terminar, como si nunca hubiera empezado nada.
            // MISMO guard que el auto-load (debeReanudarTramo). La hidratación
            // del borrador sembraba el cronómetro desde los turnoTimings sin
            // mirar de qué FECHA eran: reabrir una sesión del historial de
            // otro día dejaba un borrador con los timings históricos, y la
            // siguiente hidratación arrancaba el reloj 4 días atrás.
            // Reproducido en navegador: ⏱ 99:37:59.
            const reanudaBorrador = debeReanudarTramo({
              loadDate: date,
              today: todayStr(),
              timings: parsed.turnoTimings,
            })
            setSessionActive((prev) => {
              if (prev) return prev
              sessionStartRef.current = reanudaBorrador
                ? earliestTurnoStart(parsed.turnoTimings) || Date.now()
                : Date.now()
              return true
            })
            // Restaurar el alcance declarado (Aeropuerto "Ambos") si el
            // borrador lo traía persistido (mig 151-plan, ver autosave más
            // abajo) — si no, cae al comportamiento de siempre (un solo
            // miembro: esta vista). Solo si todavía no hay alcance en
            // memoria, para no pisar el de OTRO miembro ya hidratado antes.
            setPendingScopeMembers((prev) =>
              prev.length
                ? prev
                : Array.isArray(parsed.pendingScopeMembers) && parsed.pendingScopeMembers.length
                  ? parsed.pendingScopeMembers
                  : [targetCity]
            )
            // Frentes extra (punto 2) — mismo criterio: solo si todavía no
            // hay nada en memoria, para no perder lo que ya trajo otra vista
            // hidratada antes en esta misma sesión de navegador.
            if (Array.isArray(parsed.pendingExtraFronts) && parsed.pendingExtraFronts.length) {
              setPendingExtraFronts((prev) => (prev.length ? prev : parsed.pendingExtraFronts))
            }
            // Contadores de edición vs. guardado — CLAUDE.md §2: si tiene que
            // sobrevivir un F5, no puede vivir solo en un ref. Nacen vacíos en
            // cada montaje, y sin restaurarlos un frente YA guardado volvía a
            // contarse como pendiente después de cada recarga. Verificado en
            // navegador: tras F5, Trujillo estaba entero en el servidor y el
            // aviso igual reclamaba 18 celdas sin guardar. Una alarma que
            // suena cuando no pasa nada enseña a ignorar la que sí importa.
            if (Number.isFinite(parsed.editSeq)) {
              editSeqRef.current[targetCity] = parsed.editSeq
            }
            if (Number.isFinite(parsed.savedSeq)) {
              savedSeqRef.current[targetCity] = parsed.savedSeq
            }
          }
        }
        if (migratedFromLegacy && draftApplied) {
          try {
            localStorage.setItem(draftKey, raw)
            localStorage.removeItem(legacyDraftKey)
          } catch {
            /* si falla la migración, el borrador legacy sigue disponible la próxima vez */
          }
        }
      } catch {
        /* ignore corrupt draft */
      }
      // Sin borrador local (nunca hubo, o ya se borró al Terminar/Descartar):
      // buscar en BD si esta ciudad+fecha ya tiene datos guardados de una
      // sesión anterior y traerlos solo, para que reabrir normal (sin pasar
      // por "Historial de sesiones" → Abrir) nunca muestre una grilla vacía
      // cuando en realidad ya hay datos guardados — confundía al hub, que
      // creía que se habían perdido (incidente 2026-07-22, Arequipa Aeropuerto).
      if (!draftApplied) {
        setPendingLoad({ dbCity, zone, date, auto: true })
      } else {
        // Se restauró un borrador, así que NO se va a llamar a
        // loadObservationsIntoForm — y esa es la única función que lee la
        // marca de agua del servidor. Sin esto, la marca queda vacía y el
        // primer guardado da un CONFLICTO FALSO (durabilidad R3).
        //
        // A quién castigaba: al hub que MÁS guarda. Después de un apagón o
        // de cerrar el navegador, el sessionStorage se pierde (ahí vive la
        // marca) pero el borrador sobrevive en localStorage. Al volver, ese
        // hub veía "otra pantalla guardó esto" sin que existiera ninguna
        // otra pantalla.
        //
        // La regla es conservadora a propósito: se adopta la marca del
        // servidor SOLO si su última escritura es MÁS VIEJA que el borrador
        // local. Si es más nueva, alguien escribió de verdad después y el
        // conflicto es legítimo — se deja que aparezca.
        sincronizarMarcaDesdeBorrador(dbCity, zone, date, borradorSavedAt)
      }
    }
    // Marcar hidratado en el siguiente tick para evitar que el effect de save
    // dispare con el estado vacío inicial antes de que cargue el draft.
    const id = setTimeout(() => {
      draftHydratedRef.current = true
    }, 0)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey])
}
