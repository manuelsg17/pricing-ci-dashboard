import { useEffect } from 'react'
import { toISODate } from '../lib/dateUtils'
import { normalizeCompetitorName } from '../lib/normalize'
import { debeReanudarTramo } from '../lib/sessionPersistence'
import { earliestTurnoStart } from '../lib/dataEntry/draftCounts'
import { priceKey, indKey, bucketKeyFor, SPECIAL_CATEGORY_ZONES } from '../lib/dataEntry/keys'
import { getCiCompetitors, timeslotLabel, isInDriveVariant } from '../lib/constants'
import {
  fetchBucketWriteMark,
  fetchManualObservations,
  fetchTurnoTimings,
} from './useDataEntryPersistence'

function todayStr() {
  return toISODate(new Date())
}

// Extraído de DataEntry.jsx (revisión 2026-09, sexto corte del refactor —
// ver useCiTabLease.js, useCiHeartbeat.js, useCiDraftAutosave.js,
// useCiDraftHydration.js y useCiSessionActions.js para los cinco
// anteriores). Reabrir una sesión del historial (`openHistorySession`) y el
// auto-load/volcado de observaciones del servidor
// (`loadObservationsIntoForm`, disparado silenciosamente por el efecto de
// `pendingLoad` o explícitamente desde el historial). Sin cambios de
// comportamiento.
//
// @param {object} p
// @param {string} p.dbCity
// @param {string} p.date
// @param {string|null} p.zone
// @param {string} p.uiCity
// @param {string} p.country
// @param {string} p.userEmail
// @param {string} p.bucketKey
// @param {boolean} p.sessionActive
// @param {boolean} p.refsLoading
// @param {string|null} p.refsDbCity
// @param {unknown[]} p.refs
// @param {object} p.dbConfigs
// @param {string[]} p.categories
// @param {unknown[]} p.timeslots
// @param {object} p.dbCityToUiCity
// @param {object} p.dbCatToUICat
// @param {unknown} p.tukTukInfo
// @param {unknown} p.pendingLoad
// @param {(v: object|null) => void} p.setPendingLoad
// @param {(t: string, params?: object) => string} p.t
// @param {(type: string, key: string, params?: object, opts?: object) => void} p.notify
// @param {Function} p.setMsg
// @param {(city: string, date: string, zone: string|null, d: number) => void} p.writeSyncSeqFor
// @param {(bucket: string, date: string) => boolean} p.isBucketJustFinished
// @param {import('react').RefObject<number|null>} p.sessionStartRef
// @param {Function} p.setShowHistory
// @param {Function} p.setSessionActive
// @param {Function} p.setPendingScopeMembers
// @param {Function} p.setUiCity
// @param {Function} p.setActiveTukTuk
// @param {Function} p.setActiveSpecialCat
// @param {Function} p.setDate
// @param {Function} p.setTurnoTimingsByCity
// @param {Function} p.setEntriesByCity
// @param {Function} p.setEtaByCity
// @param {Function} p.setDiscByCity
// @param {Function} p.setIndriveByCity
// @param {Function} p.setNaByCity
// @param {Function} p.setSurgeByCity
// @param {Function} p.setLoadedCombosByCity
// @param {Function} p.setErrorKeysByCity
// @returns {{ openHistorySession: (s: object) => void, loadObservationsIntoForm: Function }}
export function useCiSessionHistory({
  dbCity,
  date,
  zone,
  uiCity,
  country,
  userEmail,
  bucketKey,
  sessionActive,
  refsLoading,
  refsDbCity,
  refs,
  dbConfigs,
  categories,
  timeslots,
  dbCityToUiCity,
  dbCatToUICat,
  tukTukInfo,
  pendingLoad,
  setPendingLoad,
  t,
  notify,
  setMsg,
  writeSyncSeqFor,
  isBucketJustFinished,
  sessionStartRef,
  setShowHistory,
  setSessionActive,
  setPendingScopeMembers,
  setUiCity,
  setActiveTukTuk,
  setActiveSpecialCat,
  setDate,
  setTurnoTimingsByCity,
  setEntriesByCity,
  setEtaByCity,
  setDiscByCity,
  setIndriveByCity,
  setNaByCity,
  setSurgeByCity,
  setLoadedCombosByCity,
  setErrorKeysByCity,
}) {
  // ── Abrir una sesión pasada para editar/agregar ───────
  function openHistorySession(s) {
    // Reabrir la MISMA sesión que ya está en pantalla (misma ciudad/fecha/
    // zona) es un no-op peligroso: como dbCity/date/zone no cambian, el
    // effect de pendingLoad se dispara YA (nada que esperar) y
    // loadObservationsIntoForm SOBREESCRIBE entriesByCity con lo último
    // guardado en servidor — sin fusionar. Cualquier cambio tipeado después
    // del último "Guardar progreso" (aunque ya viva en el borrador local)
    // se perdía en silencio, y el próximo autosave lo confirmaba borrado.
    // Detectado en revisión adversarial 2026-07-23. Si es la misma sesión,
    // no hay nada que recargar: lo que se ve en pantalla YA es lo más
    // reciente.
    if (s.city === dbCity && s.observed_date === date && (s.zone ?? null) === (zone ?? null)) {
      setShowHistory(false)
      notify('ok', 'dataentry.already_viewing_session')
      return
    }
    const targetUi = dbCityToUiCity[s.city] || s.city
    // Sin guard, mismo motivo que en resumeDraft: el bloqueo tapaba que esta
    // función PISARA el alcance; ahora fusiona, así que abrir una sesión
    // pasada para corregirla nunca puede abandonar un frente declarado.
    // Arrancar una sesión para que aparezcan Guardar/Terminar y el HP pueda
    // editar y re-guardar (el guardado es idempotente: DELETE+INSERT por
    // categoría/franja, así que re-guardar la misma fecha la actualiza).
    // El cronómetro SIEMPRE se reinicia acá, sin condicionarlo a
    // `sessionActive` — reabrir una sesión ya finalizada para corregirla es su
    // propio tramo de tiempo, nunca debe heredar minutos de otra cosa en la
    // que el hub ya estuviera trabajando (bug real: antes, si `sessionActive`
    // ya era true por otro motivo, el cronómetro de esta corrección arrancaba
    // contaminado con tiempo ajeno).
    sessionStartRef.current = Date.now()
    setSessionActive(true)
    // s.zone puede ser un distrito de TukTuk O una categoría propia
    // (Delivery/Cargo, ver SPECIAL_CATEGORY_ZONES) — ci_sessions no guarda
    // cuál de los dos es, así que se distingue por el nombre reservado.
    const zoneIsSpecialCat = s.zone != null && SPECIAL_CATEGORY_ZONES.has(s.zone)
    const targetBucketKey = bucketKeyFor(
      s.city,
      s.zone ?? null,
      Boolean(s.zone) && !zoneIsSpecialCat
    )
    // Fusionar, nunca pisar: reemplazar el alcance borraba los frentes que
    // seguían a medias (ej. Punto A+B declarados) sin dejar rastro, y la
    // sesión después cerraba como final abandonándolos en silencio.
    setPendingScopeMembers((prev) =>
      prev.includes(targetBucketKey) ? prev : [...prev, targetBucketKey]
    )
    setShowHistory(false)
    if (zoneIsSpecialCat) {
      // Sesión de Delivery/Cargo: sin distrito, la ciudad base ya es la
      // correcta (nunca cambia de uiCity).
      setUiCity(targetUi)
      setActiveTukTuk(null)
      setActiveSpecialCat(s.zone)
    } else if (s.zone) {
      // Sesión de TukTuk por distrito: volver a la ciudad base con TukTuk + el
      // distrito guardado en la sesión.
      setUiCity(tukTukInfo?.baseUiCity || targetUi)
      setActiveTukTuk(s.zone)
      setActiveSpecialCat(null)
    } else {
      setUiCity(targetUi)
      setActiveTukTuk(null)
      setActiveSpecialCat(null)
    }
    setDate(s.observed_date)
    // Seedear turnoTimings desde la sesión histórica ANTES de que el efecto
    // de estampado corra sobre la grilla recién cargada — si no, reabrir una
    // sesión con turnos ya completos estamparía un startedAt/endedAt falso de
    // "ahora mismo" (0 min) en vez de conservar el tiempo real original.
    setTurnoTimingsByCity((prev) => ({
      ...prev,
      [targetBucketKey]:
        s.turno_timings && typeof s.turno_timings === 'object' ? s.turno_timings : {},
    }))
    setPendingLoad({ dbCity: s.city, zone: s.zone ?? null, date: s.observed_date })
    notify('ok', 'dataentry.loading_session')
  }

  // Trae las observaciones manuales de (ciudad, fecha) y las vuelca al form,
  // mapeando cada fila de BD de vuelta a (uiCat, refId, franja, competidor).
  // Las filas que no se puedan mapear (ruta borrada, franja fuera del set,
  // etc.) se saltan en silencio — nunca rompen la carga del resto.
  async function loadObservationsIntoForm(
    loadDbCity,
    loadDate,
    loadZone = null,
    targetBucket = null,
    { silent = false } = {}
  ) {
    const bucket = targetBucket ?? loadDbCity
    // Un auto-load SILENCIOSO nunca debe resucitar un bucket que este hub
    // acaba de Terminar a propósito (ver `markBucketJustFinished` — causa
    // raíz real del bug "2 borradores reaparecidos" de Raisa, 2026-07-24).
    // Una apertura EXPLÍCITA (Historial → Abrir, openHistorySession) nunca
    // pasa `silent`, así que sigue funcionando sin cambios.
    if (silent && isBucketJustFinished(bucket, loadDate)) {
      // Pero SÍ se explica por qué la grilla está vacía (P2-15). El guard
      // funciona como se diseñó; el problema era que salía en silencio: el
      // hub volvía 2 minutos después de Terminar, veía 0/162 y el botón
      // "Iniciar Sesión", y eso es indistinguible de "perdí todo mi trabajo".
      // Sus datos están guardados y a un clic en "Ver lo guardado".
      notify('ok', 'dataentry.just_finished_note')
      return
    }
    // Marca de agua PRIMERO, filas después (mig 191). El orden importa: si el
    // otro escritor entra entre las dos lecturas, quedo con una marca vieja →
    // el próximo guardado conflictúa, que es la dirección SEGURA. Al revés
    // estaría avalando datos que no llegué a ver.
    //
    // Si la lectura falla NO se inventa una marca: sin marca el guard avisa
    // en vez de dejar pasar. Un error de red nunca debe traducirse en
    // "seguí, todo bien".
    if (userEmail) {
      const { data: wm, error: wmErr } = await fetchBucketWriteMark({
        userEmail,
        country,
        city: loadDbCity,
        zone: loadZone,
        date: loadDate,
      })
      writeSyncSeqFor(
        country,
        loadDbCity,
        loadZone,
        loadDate,
        !wmErr && wm ? Number(wm.write_seq) : null
      )
    }

    // TukTuk: acotar al distrito (zone). Vistas normales: sin filtro de zona (y
    // el guard de categorías de abajo descarta cualquier fila de TukTuk).
    // Cargar solo las filas propias (+ legacy sin dueño) para editar. Si se
    // cargaran también las de otro hub, al re-guardar se insertarían como
    // propias (el DELETE no borra las del otro dueño) → duplicados (mig 139).
    // Mismo criterio simétrico que el DELETE del guardado (siempre por dueño).
    const obsQuery = fetchManualObservations({
      country,
      city: loadDbCity,
      date: loadDate,
      zone: loadZone,
      userEmail,
    })
    const [{ data, error }, { data: historicTimings }] = await Promise.all([
      obsQuery,
      // Relevo entre hubs (pedido user 2026-07-24, punto 3) + caso general de
      // "sin draft local pero con data ya guardada" (cambio de dispositivo):
      // trae el turno_timings más reciente para este contexto SIN IMPORTAR
      // quién lo generó (RPC de solo lectura, mig 160 — RLS de ci_sessions
      // normalmente no dejaría ver la fila de otro hub). Se usa como semilla
      // más abajo SOLO si este bucket todavía no tiene timings propios (ver
      // guard `prev[bucket]`) — así nunca pisa lo que openHistorySession ya
      // seedeó con más precisión (la fila exacta que el hub clickeó "Abrir").
      fetchTurnoTimings({ country, city: loadDbCity, zone: loadZone, date: loadDate }),
    ])
    if (error) {
      setMsg({ type: 'err', text: `${t('dataentry.err_load_session')} ${error.message}` })
      return
    }
    if (historicTimings && typeof historicTimings === 'object') {
      setTurnoTimingsByCity((prev) => {
        if (prev[bucket] && Object.keys(prev[bucket]).length > 0) return prev
        return { ...prev, [bucket]: historicTimings }
      })
    }

    // (categoría|bracket|A|B) → ref; fallback a (categoría|bracket) solo si es
    // único (si hay 2+ rutas por bracket, ej. TukTuk por distrito, no hay forma
    // confiable de adivinar cuál, así que no se usa el fallback).
    const refByFull = {}
    const refByCatBracket = {}
    for (const r of refs) {
      refByFull[`${r.category}|${r.bracket}|${r.point_a ?? ''}|${r.point_b ?? ''}`] = r
      const cb = `${r.category}|${r.bracket}`
      refByCatBracket[cb] = cb in refByCatBracket ? null : r
    }
    // dbTimeslot ('Morning'/'Midday'/'Evening', mig 148) → ts.label ('Mañana'/
    // 'Tarde'/'Noche'). Filas viejas sin `timeslot` poblado (excepción rara —
    // el backfill de la mig ya cubrió el histórico) caen al fallback: derivar
    // el mismo dbTimeslot desde su observed_time canónico con la misma
    // función que usa buildInsertPayload.
    const tsByDbTimeslot = {}
    for (const ts of timeslots) {
      tsByDbTimeslot[timeslotLabel(ts.start_time?.slice(0, 5))] = ts.label
    }
    const compMapByCat = {} // uiCat → { nombreNormalizado: nombreCatálogo }

    const newEntries = {}
    const newEta = {}
    const newDisc = {}
    const newIndrive = {}
    const newNa = new Set()
    // Descriptores de RUTA de lo que se cargó → para acotar el DELETE al
    // re-guardar/terminar a la ruta exacta (incluidos point_a/point_b). Keyed por
    // (cat, franja, bracket, A, B) para deduplicar; el valor lleva los campos
    // crudos de la BD (así el DELETE matchea exactamente lo que está guardado).
    const combos = new Map()
    let mapped = 0

    for (const row of data || []) {
      const uiCat = dbCatToUICat[row.category]
      if (!uiCat) continue
      // Solo categorías de la vista activa: en la Lima normal esto descarta las
      // filas de TukTuk (ahora viven en su pestaña por distrito); en TukTuk solo
      // entra 'TukTuk'. Y en TukTuk, además, solo el distrito cargado.
      if (!categories.includes(uiCat)) continue
      if (loadZone != null && (row.zone ?? null) !== loadZone) continue
      const ref =
        refByFull[
          `${row.category}|${row.distance_bracket}|${row.point_a ?? ''}|${row.point_b ?? ''}`
        ] || refByCatBracket[`${row.category}|${row.distance_bracket}`]
      if (!ref) continue
      // dbTimeslot: preferir la columna `timeslot` guardada (mig 148); si es
      // NULL (fila legacy de antes de la migración), derivarlo de la hora
      // canónica que esa fila SIEMPRE tuvo hasta ahora en observed_time.
      const dbTimeslot = row.timeslot || timeslotLabel((row.observed_time || '').slice(0, 5))
      const tsLabel = tsByDbTimeslot[dbTimeslot]
      if (!tsLabel) continue

      if (!compMapByCat[uiCat]) {
        const map = {}
        for (const c of getCiCompetitors(uiCity, uiCat, null, country, dbConfigs)) {
          map[normalizeCompetitorName(c, { city: loadDbCity })] = c
        }
        compMapByCat[uiCat] = map
      }
      // Solo cargar competidores VISIBLES en CI. Una fila de un competidor
      // marcado "no ofrece" (ciHidden) — o removido de la config — no se vuelca
      // al formulario (no se muestra, no cuenta, no entra a loadedCombos); su
      // fila histórica queda intacta en BD (el DELETE al re-guardar está acotado
      // a los competidores visibles). Antes se cargaba como celda fantasma
      // invisible que inflaba el contador de progreso.
      const comp = compMapByCat[uiCat][row.competition_name]
      if (!comp) continue

      const comboKey = `${row.category}${dbTimeslot}${row.distance_bracket}${row.point_a ?? ''}${row.point_b ?? ''}`
      if (!combos.has(comboKey))
        combos.set(comboKey, {
          uiCat,
          dbCat: row.category,
          timeslot: dbTimeslot,
          bracket: row.distance_bracket,
          pa: row.point_a ?? null,
          pb: row.point_b ?? null,
          zone: row.zone ?? null,
        })
      const k = priceKey(uiCat, ref.id, tsLabel, comp)
      // Fila "sin data" (S/D): restaurar la marca, sin volcar precio/eta/desc.
      if (row.no_data) {
        newNa.add(k)
        mapped++
        continue
      }
      if (row.price_without_discount != null) newEntries[k] = String(row.price_without_discount)
      if (row.price_with_discount != null) newDisc[k] = String(row.price_with_discount)
      if (row.eta_min != null) newEta[k] = String(row.eta_min)
      if (isInDriveVariant(comp)) {
        const bids = [row.bid_1, row.bid_2, row.bid_3, row.bid_4, row.bid_5]
          .filter((b) => b != null)
          .map((b) => String(b))
        newIndrive[indKey(uiCat, ref.id, tsLabel, comp)] = {
          bids: bids.length ? bids : [''],
          minBid: row.minimal_bid != null ? String(row.minimal_bid) : '',
          rec: row.recommended_price != null ? String(row.recommended_price) : '',
        }
      }
      mapped++
    }

    // Surge: es un flag de la sesión estampado en cada fila. Restaurarlo del
    // valor guardado — si no, reabrir una sesión con surge y re-guardar volvía a
    // estampar surge=false en TODAS las filas (incluidos turnos que el hub no
    // tocó), corrompiendo en silencio el filtro SURGE del dashboard.
    const newSurge = (data || []).some((r) => r.surge === true)

    // Vuelca lo cargado en la rebanada de la ciudad objetivo (loadDbCity).
    //
    // En el auto-load SILENCIOSO lo tecleado por el hub SIEMPRE gana
    // (SESIONES_HALLAZGOS.md P2-12). Antes esto era un reemplazo total: si el
    // hub entraba a una ciudad ya guardada y empezaba a tipear de inmediato,
    // la carga en curso resolvía unos segundos después y le borraba de la
    // pantalla todo lo que había escrito. Es visible, y se lee como "se me
    // borró todo".
    //
    // Es la regla de CLAUDE.md §2: un refresco en segundo plano nunca pisa
    // una acción explícita y reciente del usuario. Un "Abrir" del historial
    // (silent=false) SÍ reemplaza, porque ahí el hub lo pidió.
    const conservarTecleado = (nuevos) => (prev) => {
      const actual = prev[bucket]
      if (!silent || !actual) return { ...prev, [bucket]: nuevos }
      const fusion = { ...nuevos }
      for (const [k, v] of Object.entries(actual)) {
        if (v !== '' && v != null) fusion[k] = v
      }
      return { ...prev, [bucket]: fusion }
    }

    setEntriesByCity(conservarTecleado(newEntries))
    setEtaByCity(conservarTecleado(newEta))
    setDiscByCity(conservarTecleado(newDisc))
    setIndriveByCity(conservarTecleado(newIndrive))
    // Las marcas "sin data" se UNEN: son decisiones explícitas del hub
    // ("revisé y no había oferta"), así que una carga de fondo no puede
    // borrarlas.
    setNaByCity((prev) => {
      const actual = prev[bucket]
      if (!silent || !actual || actual.size === 0) return { ...prev, [bucket]: newNa }
      return { ...prev, [bucket]: new Set([...newNa, ...actual]) }
    })
    // Mismo criterio que `conservarTecleado` y que la unión de `naKeys`: un
    // auto-load silencioso NO puede pisar una acción explícita y reciente del
    // hub (CLAUDE.md §2). Esta línea se había quedado afuera del fix de P2-12.
    //
    // Importa más de lo que parece: el hub entra a una ciudad+fecha sin
    // borrador, prende el switch de SURGE y empieza a teclear; la query resuelve
    // 1-2 s después, las celdas se conservan pero `surge` vuelve al valor del
    // servidor. Al guardar, TODAS las filas se estampan con surge=false, y el
    // propio código documenta que corromper ese campo rompe en silencio el
    // filtro SURGE del dashboard.
    //
    // Solo protege el `true`: si el hub lo prendió, gana él. Un "Abrir" del
    // historial (silent=false) sigue mandando.
    setSurgeByCity((prev) =>
      silent && prev[bucket] === true ? prev : { ...prev, [bucket]: newSurge }
    )
    setLoadedCombosByCity((prev) => ({ ...prev, [bucket]: combos.size ? combos : null }))
    setErrorKeysByCity((prev) => ({ ...prev, [bucket]: new Set() }))
    // En el auto-cargado silencioso (ver hidratación arriba) no hay nada que
    // avisar si esta ciudad+fecha está genuinamente vacía — solo mostrar el
    // mensaje si de verdad se trajo algo, o si fue un "Abrir" explícito.
    if (!silent || mapped > 0) {
      setMsg({ type: 'ok', text: t('dataentry.session_loaded', { n: mapped }) })
    }
    // Si se cargó data real, la sesión pasa a activa — si no, el hub ve su
    // grilla llena (celdas con precios, contador de progreso > 0) pero solo
    // el botón "Iniciar Sesión" en vez de Guardar/Terminar, como si nunca
    // hubiera arrancado nada (pasa siempre que recarga la página con datos
    // ya guardados: sessionActive es estado de React, no sobrevive un
    // refresh). "Abrir" desde Historial ya lo activa explícito antes de
    // llegar acá; esto cubre el auto-load silencioso al reabrir.
    if (mapped > 0 && !sessionActive) {
      // El cronómetro reanuda el tramo histórico SOLO si esto es de verdad
      // una continuación (misma fecha y jornada sin cerrar). Si no, arranca
      // en cero: mirar un día pasado o volver a una ciudad ya terminada es un
      // tramo NUEVO. Ver debeReanudarTramo() y su test — esta rama sembraba
      // el reloj con el inicio de otro día y mostraba 30:00:00.
      sessionStartRef.current = debeReanudarTramo({
        loadDate,
        today: todayStr(),
        timings: historicTimings,
      })
        ? earliestTurnoStart(historicTimings) || Date.now()
        : Date.now()
      setSessionActive(true)
      setPendingScopeMembers((prev) => (prev.length ? prev : [bucket]))
    }
  }

  // ── "Abrir" sesión del historial → cargar observaciones guardadas ──────
  // Espera a que las rutas de la ciudad objetivo estén cargadas (refsLoading
  // false) y a que ciudad+fecha actuales coincidan con lo pedido. Los effects
  // de reset de arriba ya limpiaron el form; acá solo se vuelca lo de BD.
  useEffect(() => {
    if (!pendingLoad) return
    if (refsLoading) return
    // Las refs en estado tienen que ser YA las de la ciudad objetivo (no las
    // de la ciudad anterior en el commit del click). Esto evita mapear la data
    // contra rutas equivocadas y limpiar pendingLoad antes de tiempo.
    if (refsDbCity !== pendingLoad.dbCity) return
    if (pendingLoad.dbCity !== dbCity || pendingLoad.date !== date) return
    // TukTuk: además la vista tiene que estar en el distrito correcto (mismo
    // dbCity 'Lima' para todos, pero distinto zone/bucket).
    if ((pendingLoad.zone ?? null) !== (zone ?? null)) return
    loadObservationsIntoForm(
      pendingLoad.dbCity,
      pendingLoad.date,
      pendingLoad.zone ?? null,
      bucketKey,
      { silent: !!pendingLoad.auto }
    )
    setPendingLoad(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingLoad, refsLoading, refsDbCity, dbCity, date, refs, zone, bucketKey])

  return { openHistorySession, loadObservationsIntoForm }
}
