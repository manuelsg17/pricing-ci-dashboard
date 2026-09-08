import { SESSION_ID } from '../lib/supabase'
import {
  deleteActiveSession,
  deleteActiveSessionScoped,
  saveCiBatch,
  closeCiSession,
} from './useDataEntryPersistence'
import { collectRouteDeletes, buildRoutesPayload } from '../lib/dataEntry/rows'
import { getCiCompetitors } from '../lib/constants'
import { duracionDeSesion } from '../lib/sessionDuration'
import { duracionActiva } from '../lib/idleDetection'
import { tokenDeCierre, confirmarCierre } from '../lib/sessionCloseToken'
import { isTukTukDistrictEnabled } from '../lib/tuktukDistricts'

// Extraído de DataEntry.jsx (revisión 2026-09, quinto corte del refactor —
// ver useCiTabLease.js, useCiHeartbeat.js, useCiDraftAutosave.js y
// useCiDraftHydration.js para los cuatro anteriores). El núcleo del ciclo de
// vida de sesión: arrancar, guardar progreso y terminar — DELETE+INSERT
// transaccional, el guard de concurrencia (mig 191), el cierre idempotente
// (mig 197) y la limpieza de la ciudad recién terminada. Sin cambios de
// comportamiento.
//
// `buildRows`, `buildInsertPayload`, `validateAndCollectErrors`, `rowState`
// y `resolveDbCategory` se QUEDAN en DataEntry.jsx (se les pasa por
// parámetro, no se mueven): son closures que dependen de la grilla entera
// (categories, refsByUICat, entries, indriveExtra, priceKey,
// effectiveCellValue…) y `rowState` en particular se usa también para
// renderizar — moverlos acá hubiera significado arrastrar la mitad del
// estado de la grilla a este archivo sin necesidad.
//
// `openHistorySession` y `loadObservationsIntoForm` (abrir una sesión del
// historial, auto-load del servidor) se quedan en DataEntry.jsx: son un
// subsistema propio (reabrir/recargar) que todavía no se extrajo — ver el
// plan del refactor.
//
// @param {object} p
// @param {boolean} p.isTukTuk
// @param {string|null} p.zone
// @param {string} p.dbCity
// @param {string} p.uiCity
// @param {object} p.dbConfigs
// @param {string} p.country
// @param {string} p.date
// @param {string} p.userEmail
// @param {string} p.bucketKey
// @param {string} p.draftKey
// @param {number} p.totalExpected
// @param {unknown} p.turnoTimings
// @param {unknown} p.loadedCombos
// @param {string[]} p.pendingScopeMembers
// @param {string[]} p.pendingExtraFronts
// @param {string[]} p.categories
// @param {object} p.refsByUICat
// @param {unknown[]} p.timeslots
// @param {(t: string, params?: object) => string} p.t
// @param {import('react').RefObject<boolean>} p.leaseOwnerRef
// @param {import('react').RefObject<object>} p.editSeqRef
// @param {import('react').RefObject<object>} p.savedSeqRef
// @param {import('react').RefObject<number|null>} p.sessionStartRef
// @param {import('react').RefObject<object>} p.actividadRef
// @param {import('react').RefObject<Set<string>>} p.hydratedCitiesRef
// @param {(type: string, key: string, params?: object, opts?: object) => void} p.notify
// @param {() => number|null} p.readSyncSeq
// @param {(n: number) => void} p.writeSyncSeq
// @param {(uiCat: string) => string} p.resolveDbCategory
// @param {(r: object, capturedTime: string) => object} p.buildInsertPayload
// @param {(uiCat: string, ref: object, ts: object) => object[]} p.buildRows
// @param {(requireAllFull?: boolean) => {hasPartial: boolean, hasEmpty: boolean, errorCount: number}} p.validateAndCollectErrors
// @param {(uiCat: string, ref: object, ts: object) => string} p.rowState
// @param {() => void} p.clearDraft
// @param {(key: string) => void} p.markJustFinished
// @param {(bucketKey: string, date: string) => void} p.markBucketJustFinished
// @param {(bucketKey: string) => boolean} p.irAFrente
// @param {Function} p.setSaving
// @param {Function} p.setMsg
// @param {Function} p.setSaveConflict
// @param {Function} p.setEarlyConflictHint
// @param {Function} p.setLastSaveOkAt
// @param {Function} p.setSessionActive
// @param {Function} p.setLegendCollapseSignal
// @param {Function} p.setLastDraftSavedAt
// @param {Function} p.setEntriesByCity
// @param {Function} p.setIndriveByCity
// @param {Function} p.setEtaByCity
// @param {Function} p.setDiscByCity
// @param {Function} p.setNaByCity
// @param {Function} p.setSurgeByCity
// @param {Function} p.setErrorKeysByCity
// @param {Function} p.setLoadedCombosByCity
// @param {Function} p.setTurnoTimingsByCity
// @param {Function} p.setDraftScanTick
// @param {Function} p.setPendingScopeMembers
// @param {Function} p.setPendingExtraFronts
// @param {Function} p.setTouchedFronts
// @returns {{ handleStartSession: (members: string[]) => void, handleSaveProgress: (forceOverwrite?: boolean) => Promise<boolean>, handleFinishSession: (forceOverwrite?: boolean) => Promise<void> }}
export function useCiSessionActions({
  isTukTuk,
  zone,
  dbCity,
  uiCity,
  dbConfigs,
  country,
  date,
  userEmail,
  bucketKey,
  draftKey,
  totalExpected,
  turnoTimings,
  loadedCombos,
  pendingScopeMembers,
  pendingExtraFronts,
  categories,
  refsByUICat,
  timeslots,
  t,
  leaseOwnerRef,
  editSeqRef,
  savedSeqRef,
  sessionStartRef,
  actividadRef,
  hydratedCitiesRef,
  notify,
  readSyncSeq,
  writeSyncSeq,
  resolveDbCategory,
  buildInsertPayload,
  buildRows,
  validateAndCollectErrors,
  rowState,
  clearDraft,
  markJustFinished,
  markBucketJustFinished,
  irAFrente,
  setSaving,
  setMsg,
  setSaveConflict,
  setEarlyConflictHint,
  setLastSaveOkAt,
  setSessionActive,
  setLegendCollapseSignal,
  setLastDraftSavedAt,
  setEntriesByCity,
  setIndriveByCity,
  setEtaByCity,
  setDiscByCity,
  setNaByCity,
  setSurgeByCity,
  setErrorKeysByCity,
  setLoadedCombosByCity,
  setTurnoTimingsByCity,
  setDraftScanTick,
  setPendingScopeMembers,
  setPendingExtraFronts,
  setTouchedFronts,
}) {
  // ── Start session ──────────────────────────────────────
  // `members` = alcance declarado (array de uiCity). En Aeropuerto puede ser
  // 1 o 2 elementos (Punto A / Punto B / ambos); en el resto de las vistas
  // siempre es un solo elemento (la vista actual) — comportamiento idéntico
  // al de antes de este cambio.
  function handleStartSession(members) {
    sessionStartRef.current = Date.now()

    // Borrar el latido viejo ANTES de arrancar (SESIONES_HALLAZGOS.md P1-5).
    //
    // `ci_active_sessions` tiene PK `user_email` a secas, y su
    // `ON CONFLICT DO UPDATE` deja `started_at` intacto a propósito (mig 161)
    // para que los latidos no lo pisen. La consecuencia no buscada: una
    // sesión que quedó abierta ayer le regala su `started_at` a la de hoy —
    // el hub arranca a las 09:00 y Monitoreo muestra ~24h, y si un admin la
    // cierra, `admin_close_ci_session` escribe esa duración en ci_sessions.
    //
    // Un "Iniciar Sesión" explícito es la señal inequívoca de que empieza un
    // tramo nuevo: se borra la fila para que el primer latido la re-cree con
    // `started_at = now()`. Es el único punto del cliente donde borrar sin
    // acotar es CORRECTO — justamente se quiere descartar cualquier resto,
    // sea del bucket que sea.
    if (userEmail) {
      deleteActiveSession(userEmail).then(
        () => {},
        () => {}
      )
    }

    setSessionActive(true)
    setPendingScopeMembers(members && members.length ? members : [bucketKey])
    // Lo que el hub haya tipeado ANTES de arrancar (grilla editable sin
    // sesión) no debe contarse como frente extra de ESTA sesión.
    setTouchedFronts([])
    setPendingExtraFronts([])
    setMsg(null)
  }

  // ── Save shared logic ──────────────────────────────────
  // `isFinalInScope` (default true): en un "Terminar Sesión" de Aeropuerto con
  // alcance "Ambos", el PRIMER punto se guarda con isFinish=true pero
  // isFinalInScope=false — cierra ESE punto (fila en ci_sessions, borrador
  // limpio) sin apagar la sesión/cronómetro todavía, porque queda el otro
  // punto pendiente. Para todo lo demás (Guardar Progreso, o un Terminar de
  // alcance único — el 99% de los casos) el valor por defecto reproduce el
  // comportamiento de siempre.
  async function performSave(
    rowsToInsert,
    isFinish = false,
    isFinalInScope = true,
    forceOverwrite = false
  ) {
    // Distrito de TukTuk bloqueado (ver pill en el render, de-airport-subtab--
    // locked): ese guard solo cubre el click para ENTRAR al distrito — resumir
    // un borrador local o reabrir una sesión del historial navega directo a
    // `activeTukTuk` sin pasar por ahí, así que hace falta el mismo chequeo acá,
    // en el único punto por el que pasa TODO guardado, para bloquear de verdad
    // escribir data NUEVA en un distrito bloqueado sin importar cómo se llegó.
    if (isTukTuk && zone && !isTukTukDistrictEnabled(zone)) {
      notify('err', 'dataentry.err_tuktuk_district_locked')
      return false
    }
    setSaving(true)
    setMsg(null)

    // Hora REAL de captura (mig 148): una sola marca por click de Guardar
    // Progreso/Terminar, aplicada a TODAS las filas de este guardado — no
    // por celda individual (el hub puede tipear varios minutos antes de
    // guardar; trackear por celda sería mucho más invasivo para un
    // beneficio marginal). `timeslot` (buildInsertPayload) es quien sigue
    // identificando a qué turno pertenece cada fila.
    const capturedTime = new Date().toTimeString().slice(0, 5)

    // Descriptores de RUTA EXACTA a limpiar (dbCat, franja, bracket, point_a,
    // point_b, zone) — nunca por categoría/franja completa: varias rutas
    // comparten categoría+bracket y difieren solo en los puntos (TukTuk por
    // distrito), y un borrado más amplio se llevaba puesta una ruta hermana a
    // medias (CLAUDE.md §2). `timeslot` es la ETIQUETA estable del turno (mig
    // 148), no la hora real de captura. Solo al TERMINAR se suman las rutas
    // cargadas del historial (loadedCombos) para borrar las que el hub vació
    // tras reabrir; "Guardar progreso" nunca borra lo que no re-guarda.
    // Implementación en src/lib/dataEntry/rows.js.
    const routeDels = collectRouteDeletes(rowsToInsert, {
      isFinish,
      loadedCombos,
      resolveDbCategory,
    })

    // DELETE + INSERT en UNA transacción del servidor (migs 182/186).
    //
    // Antes esto eran N DELETEs en paralelo y después INSERTs en lotes de 200.
    // Los dos pasos chequeaban su error, pero NO eran atómicos: si fallaba el
    // lote 2 de 3, las filas ya estaban borradas y solo se había reinsertado
    // una parte — la ruta quedaba a medias en la BD. Estaba mitigado (el
    // borrador local sobrevive y reintentar arregla), pero si el hub cerraba la
    // laptop en vez de reintentar, esos datos se perdían y nadie se enteraba.
    //
    // El cuerpo de una función plpgsql corre en una sola transacción: si el
    // INSERT falla, el DELETE se revierte solo. Verificado en local — ver el
    // bloque de pruebas de la mig 186.
    //
    // La función es SECURITY INVOKER, así que las políticas RLS de
    // pricing_observations siguen aplicando igual que con el acceso directo.
    //
    // Los competidores VISIBLES se siguen calculando ACÁ, no en SQL: dependen
    // de la config del cliente (getCiCompetitors/ciHidden), y duplicar esa
    // lógica en la base sería exactamente el tipo de divergencia que ya causó
    // problemas con la normalización (CLAUDE.md §4). Un competidor marcado
    // "no ofrece" conserva su histórico: si no está visible, no entra en el
    // acote y por lo tanto no se borra.
    const routesPayload = buildRoutesPayload(routeDels, {
      competitorsFor: (uiCat) => getCiCompetitors(uiCity, uiCat, null, country, dbConfigs),
      dbCity,
    })

    const payloads = rowsToInsert.map((r) => buildInsertPayload(r, capturedTime))
    // Se captura el contador de ediciones ACÁ, junto con el payload — no
    // después del await. Un guardado de 324 celdas tarda segundos, y todo lo
    // que el hub teclee mientras viaja NO está en este payload: sellarlo al
    // volver lo marcaría como guardado siendo mentira.
    const seqEnviado = editSeqRef.current[bucketKey] ?? 0

    const { data: saveRes, error: saveErr } = await saveCiBatch({
      country,
      dbCity,
      date,
      // La zona CONSTANTE de la vista (el distrito activo en TukTuk, null en el
      // resto) — NUNCA la de la fila individual. Hay ~76k filas manuales con
      // zona no-null fuera de TukTuk (Aeropuerto por Excel) que un borrado sin
      // este acote se llevaba puestas en silencio.
      zone: zone ?? null,
      // Sin email se cae a solo-las-sin-dueño, nunca a un borrado sin predicado
      // de dueño (mig 139).
      userEmail,
      routes: routesPayload,
      rows: payloads,
      // Guard de concurrencia (mig 191): identidad de ESTA pestaña + la marca
      // de agua con la que se sincronizó. Si otra pestaña —u otro
      // dispositivo con la misma cuenta— escribió este bucket después, el
      // servidor aborta el guardado ENTERO en vez de borrar sus filas.
      sessionId: SESSION_ID,
      expectedSeq: readSyncSeq(),
      force: forceOverwrite === true,
    })
    if (saveErr) {
      // 55006 = otra pestaña/dispositivo escribió este bucket. El servidor NO
      // borró ni insertó nada: la data de la otra sigue intacta.
      if (saveErr.code === '55006') {
        setSaveConflict({ at: saveErr.details || null, isFinish })
        notify('err', 'dataentry.err_save_conflict', null, { emphasize: true })
        setSaving(false)
        // NO se marca guardado, NO se limpia el borrador, NO se inserta en
        // ci_sessions y NO se borra el latido: el hub no perdió nada.
        return false
      }
      // Mensaje ACCIONABLE para el hub (no el .message crudo de Postgres —
      // jerga técnica tipo "duplicate key value violates..." no le dice qué
      // hacer). El detalle técnico va a consola para diagnóstico nuestro.
      console.error('[performSave] save_ci_batch error:', saveErr)
      notify('err', 'dataentry.err_save_failed')
      setSaving(false)
      return false
    }
    if (saveRes && Number.isFinite(Number(saveRes.seq))) writeSyncSeq(Number(saveRes.seq))
    setSaveConflict(null)
    setEarlyConflictHint(null)
    // Guardado confirmado en servidor de verdad (no solo local) — ver
    // indicador en el header.
    setLastSaveOkAt(Date.now())
    // Sella SOLO lo que viajó en este payload, y solo para este bucket.
    savedSeqRef.current[bucketKey] = seqEnviado

    if (isFinish) {
      const now = new Date()
      // La duración YA NO sale del cronómetro de reloj de pared.
      //
      // `sessionStartRef` se pisa con `Date.now()` en cinco lugares (cerrar
      // el Punto A de "Ambos", abrir una sesión del historial, cambiar de
      // fecha, y las dos siembras que caen al fallback), y cada uno producía
      // una duración falsa. El caso que reportó el user: el hub llena
      // Aeropuerto A y B en la misma sentada y cierra los dos seguidos —
      // entre un Terminar y el otro pasan SEGUNDOS, así que B (una hora de
      // trabajo) se guardaba como 0.1 min.
      //
      // Ahora se deriva de `turnoTimings`, que mide el trabajo real por turno
      // y sobrevive al F5. Ver src/lib/sessionDuration.js para el porqué
      // completo y scripts/test-session-duration.mjs para las simulaciones.
      // `sessionStartRef` queda solo como último recurso (sesión sin una sola
      // celda llena), y en ese caso la duración se marca no confiable.
      const medicion = duracionDeSesion({
        turnoTimings,
        inicioReloj: sessionStartRef.current,
        fin: now,
      })
      // `minutos: null` = no se pudo saber. Se persiste null a propósito en
      // vez de un 0: un 0 entra en cualquier promedio y hace creer que el
      // corte fue instantáneo — es exactamente el dato que rompía la métrica.
      const dur = medicion.minutos
      // El inicio guardado es el del PRIMER trabajo real, no el del reloj:
      // así `started_at`/`ended_at` describen la ventana de trabajo del
      // bucket que cierra, no la de la pestaña.
      const start = medicion.inicio ?? sessionStartRef.current ?? now.getTime()

      // Cuánto de esa ventana fue TRABAJO (P1-6). NO reemplaza a `medicion`:
      // el techo de 4h sigue mandando en `duration_minutes` para no cambiarle
      // el significado a una columna que ya tiene histórico y dashboards
      // encima (CLAUDE.md §4). Los minutos activos van en columnas propias.
      const actividad = duracionActiva({
        turnoTimings,
        actividad: actividadRef.current[bucketKey] || [],
        fin: now,
      })

      // Clave de idempotencia del cierre (P2-11, mig 197). Se genera UNA vez
      // por intento y se reusa en cada reintento — incluso después de un F5,
      // porque vive en localStorage. Así, un INSERT que el servidor ya
      // ejecutó y cuya respuesta se perdió NO se duplica. Un cierre nuevo
      // (reabrir para corregir) trae token nuevo y sí inserta: ese rastro de
      // revisiones es deliberado.
      const cierre = tokenDeCierre({ userEmail, bucketKey, fecha: date })

      const { error: sessErr } = await closeCiSession(cierre.token, {
        country,
        city: dbCity,
        // Distrito TukTuk (null en el resto) → el historial distingue "Lima
        // TukTuk · Comas" de "Lima TukTuk · SJM" aunque ambas guarden city='Lima'.
        zone,
        observed_date: date,
        user_email: userEmail,
        started_at: new Date(start).toISOString(),
        ended_at: now.toISOString(),
        duration_minutes: dur,
        // La marca de confianza (mig 195). `duracionDeSesion` YA la calculaba
        // y se tiraba a la basura al escribir la fila: un número capado por el
        // techo de 4h entraba a la base indistinguible de uno exacto, y
        // cualquier promedio los mezclaba. Con esto, el dashboard puede
        // promediar SOLO lo confiable y el resto queda auditable en vez de
        // silenciosamente mal.
        duration_confiable: medicion.confiable,
        duration_motivo: medicion.motivo,
        rows_saved: payloads.length,
        // Mismo valor que ya manda el heartbeat en vivo (mig 146) — persistido
        // para que Monitoreo pueda mostrar "filas guardadas / disponibles"
        // (mig 155) sin tener que recalcularlo del lado del servidor.
        total_expected: totalExpected,
        // Timestamps de inicio/fin por turno (pedido user 2026-07-24) — mismo
        // criterio: persistido acá para que sobreviva al DELETE del latido de
        // ci_active_sessions al cerrar. Solo se guardan los turnos con AMBOS
        // timestamps del turno actual (isFinalInScope puede cerrar solo un
        // punto de "Ambos"; los turnos de otro miembro del alcance viven en
        // SU PROPIO bucketKey/sesión, no se mezclan acá).
        turno_timings: turnoTimings,
        // NULL explícito cuando no hubo traza utilizable: "no lo pude
        // medir" y "no trabajó" no son lo mismo, y un 0 se promedia.
        active_minutes: actividad.actividadMedida ? actividad.minutos : null,
        idle_minutes: actividad.actividadMedida ? actividad.descontados : null,
        // La traza cruda se guarda para poder RECALIBRAR el umbral de 5 min
        // contra datos reales dentro de unas semanas, sin haber perdido el
        // detalle. Hoy es una hipótesis fundada, no una medición.
        activity_trace: actividad.actividadMedida ? actividadRef.current[bucketKey] || [] : null,
      })
      // supabase-js NO lanza excepción cuando un insert falla: devuelve
      // { error }. Sin este chequeo, un fallo (RLS, red, timeout) seguía de
      // largo y el hub veía "Sesión terminada" con el borrador ya limpiado,
      // mientras la sesión NUNCA aparecía en Monitoreo ni en el Historial.
      // Fallo silencioso en el flujo más crítico del proyecto — justo la
      // clase de bug que documenta CLAUDE.md §2.
      //
      // Importante para el mensaje: los PRECIOS ya están guardados a esta
      // altura (el insert a pricing_observations de arriba sí chequea error y
      // aborta). Lo que falló es el REGISTRO de la sesión. Por eso no se
      // avisa "no se guardó nada" —sería falso y haría que el hub recargue
      // todo al pedo— sino que no se pudo cerrar, y se lo deja reintentar:
      // NO se limpia el borrador, NO se marca la sesión como cerrada y NO se
      // borra el latido. Reintentar Terminar es seguro porque el re-guardado
      // es idempotente (DELETE+INSERT por ruta exacta).
      if (sessErr) {
        console.error('[performSave] ci_sessions insert error:', sessErr)
        notify('err', 'dataentry.err_session_not_closed', null, { emphasize: true })
        setSaving(false)
        return false
      }

      // Cierre CONFIRMADO por el servidor: se retira el token para que el
      // próximo "Terminar" de este bucket sea un cierre nuevo y no un
      // reintento.
      //
      // Va acá y NO en el camino de error, a propósito: retirarlo tras un
      // fallo haría que el reintento mandara un token DISTINTO y duplicara
      // justamente la fila que el servidor quizá ya escribió — que es el bug
      // que esto viene a cerrar.
      confirmarCierre({ userEmail, bucketKey, fecha: date })
      actividadRef.current[bucketKey] = []

      // Limpiar el latido de sesión-activa (mig 146) SOLO si esto cierra la
      // sesión de VERDAD (isFinalInScope) — en Aeropuerto "Ambos", terminar el
      // primer punto no debe hacer desaparecer al hub de "en vivo" en
      // Monitoreo: sigue trabajando, le queda el otro punto declarado.
      // Best-effort + una re-limpieza tardía (mismo criterio que
      // justFinishedRef/markJustFinished de arriba): un latido en vuelo
      // podría escribir después de este DELETE, así que se repite a los ~10s
      // por si acaso.
      if (isFinalInScope && userEmail) {
        try {
          await deleteActiveSession(userEmail)
        } catch {
          /* best-effort */
        }
        // Re-limpieza tardía acotada a ESTA sesión exacta (country/city/zone/
        // fecha) — si el hub ya arrancó una sesión NUEVA dentro de esos 10s
        // (ej. otro distrito TukTuk), este delete tardío no debe borrarle el
        // latido recién creado (mismo bug que se corrigió del lado servidor
        // en admin_close_ci_session, mig 156, ahora también acá).
        const closedCountry = country
        const closedCity = dbCity
        const closedZone = zone
        const closedDate = date
        setTimeout(() => {
          deleteActiveSessionScoped({
            userEmail,
            country: closedCountry,
            city: closedCity,
            zone: closedZone,
            date: closedDate,
          }).then(
            () => {},
            () => {}
          )
        }, 10_000)
      }
      if (isFinalInScope) {
        setSessionActive(false)
        setLegendCollapseSignal((n) => n + 1)
        // `emphasize` (pedido user 2026-07-24, incidente real de Raisa): la
        // grilla se vacía a propósito apenas termina la sesión (ver
        // dropCity más abajo) para que el autosave no la "resucite" — pero
        // sin una confirmación bien visible, ese vaciado se siente como
        // pérdida de datos aunque el guardado en servidor ya esté
        // confirmado. Mensaje grande y persistente en vez del pill chico.
        setMsg({
          type: 'ok',
          text: t('dataentry.session_finished', { min: dur, n: payloads.length }),
          emphasize: true,
        })
      } else {
        // Alcance "Ambos" de Aeropuerto: este punto quedó cerrado, pero la
        // sesión/cronómetro sigue viva para el punto que falta — el hub NO
        // debe volver a ver "Iniciar Sesión" a mitad de camino.
        setMsg({
          type: 'ok',
          text: t('dataentry.scope_point_done', { n: payloads.length }),
          emphasize: true,
        })
      }
    } else {
      setMsg({
        type: 'ok',
        text: t('dataentry.progress_saved', { n: payloads.length }),
      })
    }

    // SOLO "Terminar Sesión" limpia el borrador local. "Guardar progreso" NO
    // lo borra: es un checkpoint intermedio y el hub sigue trabajando. Si lo
    // limpiáramos acá, un refresh después de "Guardar progreso" dejaría la
    // grilla vacía (el form no recarga lo ya guardado en la BD) y el hub
    // creería que perdió todo. El re-guardado es idempotente (DELETE+INSERT
    // por categoría/franja), así que conservar el borrador es seguro.
    if (isFinish) {
      clearDraft()
      markJustFinished(draftKey)
      markBucketJustFinished(bucketKey, date)
      setLastDraftSavedAt(null)
      // Limpiar la rebanada EN MEMORIA de la ciudad recién terminada. Sin esto,
      // el flush/autosave/beforeunload vuelven a escribir el borrador que
      // clearDraft() acaba de borrar (la grilla seguía en memoria) → una sesión
      // terminada reaparecía como "borrador activo". Al vaciar la ciudad, el
      // autosave la ve vacía y no reescribe nada. Los datos ya están en la BD
      // (y en "sesiones pasadas"): reabrir desde el historial los recarga.
      const finishedCity = bucketKey
      const dropCity = (setter) =>
        setter((prev) => {
          if (!(finishedCity in prev)) return prev
          const n = { ...prev }
          delete n[finishedCity]
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

      // Los tiempos de turno y la marca de hidratación TAMBIÉN se limpian
      // (SESIONES_HALLAZGOS.md P1-8). `discardDraft` ya hacía las dos cosas;
      // acá faltaban, y juntas formaban un circuito silencioso:
      //
      //   1. El hub termina Lima 11:00 (turno Mañana con startedAt=09:00).
      //   2. Vuelve 15:00 a esa misma pestaña a corregir una celda.
      //   3. El bucket seguía marcado como "ya hidratado", así que no se
      //      re-lee nada; y los turnoTimings viejos seguían vivos en memoria,
      //      así que el autosave los vuelve a persistir en el borrador.
      //   4. Un F5 siembra sessionStartRef desde esas 09:00.
      //   → 5 minutos de corrección quedan registrados como 360.
      dropCity(setTurnoTimingsByCity)
      hydratedCitiesRef.current.delete(finishedCity)

      // Re-escanear la lista de borradores (el terminado ya no está).
      setDraftScanTick((tk) => tk + 1)
    }
    setSaving(false)
    return true
  }

  // ── Guardar progreso ───────────────────────────────────
  // Checkpoint: se puede guardar EN CUALQUIER MOMENTO. Guarda todas las filas
  // completas que haya (categoría×ruta×franja con todos sus competidores
  // resueltos) sin bloquear por filas a medias — esas quedan en el borrador
  // para terminarlas después. El re-guardado es idempotente (DELETE+INSERT por
  // categoría/franja), así que guardar seguido es seguro. Solo "Terminar
  // Sesión" exige la grilla completa/S-D.
  /**
   * Guarda el frente donde el hub está parado AHORA. Devuelve true solo si el
   * servidor confirmó — "Guardar todo" recorre una cola de frentes y tiene que
   * frenar en el primero que falle, no seguir de largo dejando atrás un frente
   * sin guardar con un cartel de éxito al final.
   *
   * `forceOverwrite` llega como evento de React cuando el botón pasa esta
   * función directo a onClick; `performSave` lo compara con `=== true`, así que
   * un SyntheticEvent NO fuerza nada.
   */
  async function handleSaveProgress(forceOverwrite = false) {
    // La mig 191 ya protegería la BD, pero rebotaría como conflicto y le
    // ofrecería al hub el botón de forzar — o sea, un botón para pisarle el
    // trabajo a la otra pestaña. Mejor cortar antes, con un motivo claro.
    if (!leaseOwnerRef.current) {
      notify('err', 'dataentry.lease_readonly_body', null, { emphasize: true })
      return false
    }
    // Collect all full rows
    const rowsToInsert = []
    for (const uiCat of categories) {
      for (const ref of refsByUICat[uiCat] || []) {
        for (const ts of timeslots) {
          if (rowState(uiCat, ref, ts) === 'full') {
            rowsToInsert.push(...buildRows(uiCat, ref, ts))
          }
        }
      }
    }
    if (!rowsToInsert.length) {
      notify('err', 'dataentry.err_no_full')
      return false
    }
    return await performSave(rowsToInsert, false, true, forceOverwrite)
  }

  // ── Terminar sesión ────────────────────────────────────
  // "Terminar Sesión" exige TODA la grilla llena (los 3 turnos) de la vista
  // actual — sin esto no debía existir un modo permisivo a medio-camino: un
  // distrito de TukTuk, o un Punto de Aeropuerto, se dan por completos o no
  // se dan. En Aeropuerto con alcance "Ambos" (`pendingScopeMembers` con 2
  // elementos), este botón cierra el PUNTO ACTUAL uno a la vez: la sesión
  // sigue activa y el hub pasa automáticamente al punto que falta, y recién
  // al terminar el ÚLTIMO se cierra la sesión de verdad (ver
  // `isFinalInScope` en `performSave`).
  async function handleFinishSession(forceOverwrite = false) {
    // Peor que Guardar: cierra el turno, sella la duración y borra el latido
    // con lo que tiene ESTA pestaña. Un alcance decidido por la pestaña
    // equivocada cierra la jornada con menos puntos de los que el hub midió.
    if (!leaseOwnerRef.current) {
      notify('err', 'dataentry.lease_readonly_body', null, { emphasize: true })
      return
    }
    const { hasPartial, hasEmpty } = validateAndCollectErrors(true)
    if (hasPartial || hasEmpty) {
      notify('err', 'dataentry.err_finish')
      return
    }
    const rowsToInsert = []
    for (const uiCat of categories) {
      for (const ref of refsByUICat[uiCat] || []) {
        for (const ts of timeslots) {
          rowsToInsert.push(...buildRows(uiCat, ref, ts))
        }
      }
    }
    if (!rowsToInsert.length) {
      notify('err', 'dataentry.err_no_full')
      return
    }
    const remainingAfterThis = pendingScopeMembers.filter((m) => m !== bucketKey)
    // Frentes extra (pedido user 2026-07-24, puntos 2/2b): cualquier bucket
    // que el hub haya tocado sin declararlo de antemano — Corp, Normal,
    // TukTuk u otra ciudad. Mismo criterio que `remainingAfterThis`: la
    // sesión solo cierra de verdad si TAMBIÉN queda vacío.
    const remainingExtraAfterThis = pendingExtraFronts.filter((bk) => bk !== bucketKey)
    const isFinalInScope = remainingAfterThis.length === 0 && remainingExtraAfterThis.length === 0
    const ok = await performSave(rowsToInsert, true, isFinalInScope, forceOverwrite)
    if (!ok) return
    // Updaters funcionales: `remaining*AfterThis` son snapshots de ANTES del
    // await de performSave (que puede tardar segundos). Aplicarlos como array
    // plano pisaba cualquier frente que el hub hubiera empezado mientras
    // giraba el guardado.
    setPendingScopeMembers((prev) => prev.filter((m) => m !== bucketKey))
    setPendingExtraFronts((prev) => prev.filter((bk) => bk !== bucketKey))
    // Reiniciar el cronómetro para el frente SIGUIENTE (bug real de datos,
    // revisión adversarial 2026-07-24): `sessionStartRef` se seteaba una sola
    // vez al Iniciar Sesión, así que cada frente cerrado escribía en
    // ci_sessions `started_at` = arranque global. Un hub que cerraba 3 frentes
    // a las 10:00/11:00/12:00 habiendo arrancado a las 09:00 generaba
    // duraciones de 60+120+180 = 360 min para 180 min reales, y en Monitoreo
    // cada ciudad figuraba empezando a las 09:00.
    if (!isFinalInScope) sessionStartRef.current = Date.now()
    // Sin esto el efecto de registro vuelve a agregar el bucket recién
    // cerrado a `pendingExtraFronts` (sigue "tocado") y la sesión no cierra
    // nunca — el frente reaparecería como pendiente para siempre.
    setTouchedFronts((prev) => prev.filter((bk) => bk !== bucketKey))
    // El salto automático es SOLO para el par Punto A↔B declarado (están
    // acoplados por ventana horaria: conviene medirlos seguidos). Cerrar un
    // frente extra no debe teletransportar al hub a ningún lado — el aviso
    // de arriba de la grilla le dice qué le falta y él elige a dónde ir.
    if (
      !isFinalInScope &&
      remainingAfterThis.length > 0 &&
      pendingScopeMembers.includes(bucketKey)
    ) {
      // Prioriza volver al Punto de Aeropuerto que falta (comportamiento de
      // siempre). Si solo queda un frente extra (TukTuk) pendiente, no hay
      // "siguiente" obvio (no es A→B) — se deja que el hub elija a qué
      // distrito ir; el aviso de abajo (`pendingExtraFronts.length > 0`)
      // se lo recuerda.
      // `remainingAfterThis` sale de `pendingScopeMembers`, que está en espacio
      // bucketKey; `setUiCity` espera un uiCity. Pasarle el bucketKey directo
      // dejaba la app en una "ciudad" que no existe en el catálogo: grilla
      // vacía, y el latido reportando a Monitoreo una ciudad inventada.
      //
      // La primera versión de este fix hacía `dbCityToUiCity[nextBucket] ?? nextBucket`
      // y tapaba SOLO el caso aeropuerto: para TukTuk la clave es 'TT~Lima~Comas',
      // que no está en ese mapa, así que el `??` devolvía el bucketKey crudo y el
      // bug quedaba igual — justo por el camino más fácil de alcanzar (el botón
      // "Ir ahí" de un borrador de otro distrito mete un segundo bucketKey en el
      // alcance). Hay que DESARMAR la clave, que es lo que ya hace
      // `openHistorySession` 45 líneas más abajo.
      irAFrente(remainingAfterThis[0])
      // Si no está en el catálogo no se salta a ningún lado (`irAFrente`
      // devuelve false): el aviso de frentes pendientes ya le dice al hub qué
      // le falta, y mandarlo a una pestaña inexistente es peor que dejarlo
      // donde está.
    }
  }

  return { handleStartSession, handleSaveProgress, handleFinishSession }
}
