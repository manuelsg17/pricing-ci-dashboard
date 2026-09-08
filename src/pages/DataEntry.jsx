import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  deleteActiveSession,
  fetchPresence as fetchPresenceRpc,
  fetchSavedObservations,
  countSavedObservations,
  fetchBucketWriteMark,
  fetchSessionHistory,
  fetchTukTukZones,
  fetchMyUnfinishedSessions,
} from '../hooks/useDataEntryPersistence'
import {
  countFilledEntries,
  hasMeaningfulIndriveExtra,
  countAllFilled,
  earliestTurnoStart,
  countFilledByTimeslot,
} from '../lib/dataEntry/draftCounts'
import {
  priceKey,
  indKey,
  bucketKeyFor,
  viewIdFor,
  draftKeyFor,
  legacyDraftKeyFor,
  draftKeyPrefixFor,
  bucketFinishedLsKeyFor,
  syncSeqKeyFor as syncSeqKey,
  SPECIAL_CATEGORY_ZONES,
} from '../lib/dataEntry/keys'
import {
  buildRowsForSlot,
  buildInsertPayload as buildInsertPayloadRow,
} from '../lib/dataEntry/rows'
import { buildCityClusters, computeRevisionInfo } from '../lib/dataEntry/derived'
import { useLeaseState, useCiTabLeaseEffects } from '../hooks/useCiTabLease'
import { useCiHeartbeat } from '../hooks/useCiHeartbeat'
import { useCiDraftAutosave } from '../hooks/useCiDraftAutosave'
import { useCiDraftHydration } from '../hooks/useCiDraftHydration'
import { useCiSessionActions } from '../hooks/useCiSessionActions'
import { useCiSessionHistory } from '../hooks/useCiSessionHistory'
import { useCiDraftManagement } from '../hooks/useCiDraftManagement'
import { useCiSaveAllQueue } from '../hooks/useCiSaveAllQueue'
import { registrarActividad } from '../lib/idleDetection'
import { distanceRefsQueryKey, fetchDistanceRefs } from '../hooks/useDistanceRefs'
import { useAuth } from '../lib/auth'
import {
  getCiCompetitors,
  resolveDbParams,
  timeslotLabel,
  isInDriveVariant,
  BRACKET_COLORS,
  BRACKET_SHORT,
  BRACKET_LABELS,
} from '../lib/constants'
import { buildFronts, frontLabel, parseBucketKey } from '../lib/sessionFronts'
import { formatCityZoneLabel } from '../lib/monitoring'
import FrentesSinGuardar from '../components/dataentry/FrentesSinGuardar'
import { getSourceCategory } from '../lib/distanceRefsReplication'
import { buildRefsByBracket } from '../lib/bracketGrouping'
import { getISOYearWeek, toISODate } from '../lib/dateUtils'
import { turnoBreakdownLabel } from '../lib/timing'
import { useRushHourConfig } from '../hooks/useRushHourConfig'
import { useCITimeslots } from '../hooks/useCITimeslots'
import { isTukTukDistrictEnabled, firstEnabledTukTukDistrict } from '../lib/tuktukDistricts'
// Sale de la lib de Proyectos porque ahí nació, pero no tiene nada de
// Proyectos: recorta un email antes del arroba. Reusarlo evita la cuarta copia
// de la misma línea en este repo.
import { nombreCorto } from '../lib/projectTasks'
import { EMPTY_PRESENCE, mismaPresencia, presenciaEnBucket } from '../lib/presencia'
import { useI18n } from '../context/LanguageContext'
import { Button } from '../components/ui/shadcn/button'
import { Lock, CheckCircle2, AlertTriangle } from 'lucide-react'
import BracketRouteGroup from '../components/dataentry/BracketRouteGroup'
import TurnoSection from '../components/dataentry/TurnoSection'
import InstructionsBanner from '../components/dataentry/InstructionsBanner'
import { SessionTimer, SaveStatusIndicators } from '../components/dataentry/SessionLiveStatus'
import '../styles/data-entry.css'

// (city/category/competitor constants are derived dynamically from COUNTRY_CONFIG via props)

// Colores de sección por categoría
const CAT_COLORS = {
  'Economy/Comfort': { bg: '#eff6ff', border: '#93c5fd', text: '#1d4ed8', accent: '#3b82f6' },
  'Comfort+': { bg: '#f0fdf4', border: '#86efac', text: '#15803d', accent: '#22c55e' },
  Premier: { bg: '#fffbeb', border: '#fcd34d', text: '#b45309', accent: '#f59e0b' },
  TukTuk: { bg: '#fdf4ff', border: '#e879f9', text: '#86198f', accent: '#d946ef' },
  XL: { bg: '#fff7ed', border: '#fdba74', text: '#c2410c', accent: '#f97316' },
  Corp: { bg: '#f8fafc', border: '#cbd5e1', text: '#334155', accent: '#64748b' },
  // Legacy (por si queda data vieja en el form)
  Economy: { bg: '#eff6ff', border: '#93c5fd', text: '#1d4ed8', accent: '#3b82f6' },
  Comfort: { bg: '#f0fdf4', border: '#86efac', text: '#15803d', accent: '#22c55e' },
}

// ── Helpers ────────────────────────────────────────────────────────────────
function todayStr() {
  return toISODate(new Date())
}

// countFilledEntries / hasMeaningfulIndriveExtra / countAllFilled /
// earliestTurnoStart viven en src/lib/dataEntry/draftCounts.js (puras, con
// tests en scripts/test-data-entry-counts.mjs). Siguen siendo la fuente ÚNICA
// de verdad para el pill de progreso, el borrador restaurado y el escaneo de
// borradores; el porqué de cada una está documentado allá.

// Rebanadas vacías compartidas (identidad estable) para el estado por-ciudad:
// evitan crear un objeto nuevo por render cuando la ciudad activa no tiene datos
// (si no, las deps de los effects "cambiarían" en cada render).
const EMPTY_OBJ = {}
const EMPTY_SET = new Set()

// Ventana durante la cual un auto-load silencioso NO puede reactivar un
// bucket que este hub acaba de Terminar a propósito. Ver `markBucketJustFinished`.
const BUCKET_JUST_FINISHED_MS = 5 * 60_000

import { useCountry } from '../context/CountryContext'

// ── Componente principal ───────────────────────────────────────────────────
export default function DataEntry() {
  const { session } = useAuth()
  const userEmail = session?.user?.email || ''
  const { t, locale } = useI18n()
  const { country, countryConfig, dbConfigs } = useCountry()

  const uiCities = countryConfig.cities

  const [uiCity, setUiCity] = useState(uiCities[0] || 'Lima')
  // TukTuk se carga POR DISTRITO: cuando esto tiene un distrito (zone), la vista
  // activa es "Lima TukTuk · <distrito>" (uiCity queda en la ciudad base que
  // tiene la categoría TukTuk, p.ej. 'Lima'). null = vista normal (ciudad /
  // aeropuerto / corp). Cada distrito es su propia rebanada de estado, borrador y
  // sesión — igual que Punto A/B del aeropuerto son ciudades independientes.
  const [activeTukTuk, setActiveTukTuk] = useState(null)
  const [tukTukDistricts, setTukTukDistricts] = useState([])
  // Delivery/Cargo (2026-09): igual criterio que activeTukTuk pero sin
  // distrito — null = vista normal; 'Delivery' | 'Cargo' = esa pestaña activa.
  // Mutuamente excluyente con activeTukTuk (nunca los dos a la vez; cada click
  // de pestaña limpia el otro, ver el bloque de tabs más abajo).
  const [activeSpecialCat, setActiveSpecialCat] = useState(null)
  const [date, setDate] = useState(todayStr())
  // surge también es POR-CIUDAD: es un flag de la sesión (ciudad+fecha) que se
  // estampa en pricing_observations.surge. Si fuera global, intercalar A↔B con
  // distinto surge guardaría el flag equivocado (lo cazó la revisión).
  const [surgeByCity, setSurgeByCity] = useState({})

  // Estado del formulario POR CIUDAD (dbCity). Intercalar entre ciudades (ej.
  // Aeropuerto Punto A ↔ Punto B) mantiene AMBAS en memoria: cambiar de ciudad
  // no resetea ni recarga — la ciudad activa es solo una "rebanada" de estos
  // mapas (ver `entries`/`indriveExtra`/... derivados abajo, tras `dbCity`). Las
  // claves priceKey/indKey ya son únicas por ciudad (refId = PK global), así que
  // no colisionan entre ciudades; el borrador de localStorage sigue siendo el
  // respaldo cross-refresh, uno por (país, ciudad, fecha).
  //   entriesByCity[dbCity][priceKey]  → precio SIN descuento (string)
  //   indriveByCity[dbCity][indKey]    → { bids, minBid, rec }
  //   etaByCity[dbCity][priceKey]      → ETA en minutos (opcional → eta_min)
  //   discByCity[dbCity][priceKey]     → precio CON descuento (opcional)
  //   errorKeysByCity[dbCity]          → Set de priceKey con error
  //   naByCity[dbCity]                 → Set de priceKey marcados "sin data" (S/D)
  const [entriesByCity, setEntriesByCity] = useState({})
  const [indriveByCity, setIndriveByCity] = useState({})
  const [etaByCity, setEtaByCity] = useState({})
  const [discByCity, setDiscByCity] = useState({})
  const [errorKeysByCity, setErrorKeysByCity] = useState({})
  const [naByCity, setNaByCity] = useState({})
  // turnoTimingsByCity[bucketKey][tsLabel] = { startedAt, endedAt } (ISO) —
  // pedido del user (2026-07-24): medir cuánto tarda cada hub por turno, no
  // solo la sesión completa. Se estampa UNA sola vez por turno (primer fill →
  // startedAt, 100% relleno → endedAt) y nunca se sobreescribe después, para
  // que reabrir una sesión ya terminada a corregir un dato no falsifique el
  // tiempo original con un timestamp de "ahora". Ver efecto de estampado más
  // abajo y el seed desde ci_sessions.turno_timings en openHistorySession.
  const [turnoTimingsByCity, setTurnoTimingsByCity] = useState({})

  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState(null)
  // Un solo punto para los avisos traducidos: `notify(type, key, params, opts)`.
  // Evita 30 objetos armados a mano y que se cuele un texto sin t().
  const notify = useCallback(
    (type, key, params, opts) => setMsg({ type, text: t(key, params), ...(opts || {}) }),
    [t]
  )

  // Session management
  const sessionStartRef = useRef(null)
  const [sessionActive, setSessionActive] = useState(false)
  // Alcance de sesión declarado (mig 151, solo relevante en clusters de
  // Aeropuerto): qué uiCity(s) el hub eligió completar en esta sentada antes
  // de "Iniciar Sesión" — Punto A, Punto B, o ambos. Para TukTuk/Normal/Corp
  // siempre tiene un único elemento (uiCity actual), igual que antes de este
  // cambio. Se va achicando a medida que cada miembro se Termina (ver
  // handleFinishSession) — mientras tenga 2+ elementos, "Terminar Sesión"
  // cierra solo ESE miembro y deja la sesión/cronómetro activos para el
  // resto; al llegar al último, cierra la sesión de verdad.
  const [pendingScopeMembers, setPendingScopeMembers] = useState([])
  // Elección del selector de alcance ANTES de arrancar (mientras !sessionActive
  // en un cluster de Aeropuerto): uiCity de un punto puntual, o 'both'.
  const [scopeChoice, setScopeChoice] = useState(null)
  // Frentes EXTRA (pedido user 2026-07-24, puntos 2 y 2b): a diferencia de
  // pendingScopeMembers (declarado de antemano, solo Aeropuerto), esto son
  // buckets (bucketKey) que el hub tocó DURANTE una sesión activa sin
  // haberlos declarado — Corp, Normal, TukTuk, u otra ciudad entera. Desde
  // el pedido del 2026-07-24 (2b) el guard de navegación NO bloquea ningún
  // salto mientras haya sesión activa: lo que cierra el bug original (una
  // sesión que nunca podía terminar porque quedaba un frente abandonado sin
  // registrar) es JUSTAMENTE este registro, no el bloqueo.
  // "Terminar Sesión" exige que esto quede vacío.
  const [pendingExtraFronts, setPendingExtraFronts] = useState([])
  // Buckets donde el hub efectivamente ESCRIBIÓ algo en esta sesión (no solo
  // "los vio"). Es el discriminador correcto para registrar un frente extra:
  // el auto-load de datos ya guardados escribe en entriesByCity DIRECTAMENTE
  // (no pasa por setEntry/toggleNa), así que navegar a un frente ya completo
  // de una sesión anterior nunca lo marca como tocado — mientras que corregir
  // una sola celda de ese frente sí lo marca, y entonces el hub debe cerrarlo
  // para que su corrección se guarde. Reemplaza a la heurística previa
  // (0 < filled < total), que daba falsos positivos con data auto-cargada y
  // falsos negativos con un frente que el hub llenaba al 100% y abandonaba.
  // Se limpia al Iniciar Sesión (queda acotado a la sesión en curso) y al
  // terminar/descartar cada frente.
  // Último total conocido por bucket. El cliente solo calcula `totalExpected`
  // de la vista ACTUAL (depende de las rutas/categorías de esa ciudad), así
  // que sin memoria Monitoreo no podría mostrar "12/162" de un frente que el
  // hub no está mirando ahora. Se llena a medida que visita cada frente; los
  // que nunca visitó viajan con total=null (desconocido, distinto de 0).
  const [totalByBucket, setTotalByBucket] = useState({})
  const [touchedFronts, setTouchedFronts] = useState([])

  // Contador monótono de ediciones vs. el valor que tenía en el último
  // guardado OK. Es lo que permite decirle al hub la verdad sobre si su
  // trabajo está en el servidor (SESIONES_HALLAZGOS.md P2-14).
  //
  // Va en REFS y no en estado a propósito: `markTouched` corre en CADA
  // tecleo, y meter un setState acá re-renderizaría DataEntry en cada
  // pulsación — justo el costo que los fixes P0/P1 de la grilla evitaron
  // (CLAUDE.md §5). El indicador ya tiene su propio tick de 1s, así que leer
  // el ref con hasta un segundo de atraso no cambia nada para el usuario.
  // POR BUCKET, no globales. Con un contador único, guardar Lima y después
  // teclear en Arequipa hacía que Lima —completamente guardada— mostrara
  // "cambios sin guardar"; y al revés, entrar a un bucket con borrador local
  // nunca enviado mostraba "✓ Guardado en el servidor". Sería el mismo pecado
  // que P2-14 con otro disfraz.
  const editSeqRef = useRef({})
  const savedSeqRef = useRef({})

  // Traza de actividad por bucket (P1-6). Va en REF por el MISMO motivo que
  // editSeqRef: esto corre en CADA tecleo, y un setState acá re-renderizaría
  // la grilla entera (CLAUDE.md §5). `registrarActividad` solo mira el último
  // tramo y devuelve la misma referencia si el evento no aporta nada, así que
  // el costo por tecla es constante y no crece con la jornada.
  const actividadRef = useRef({})

  const markTouched = useCallback((bucket) => {
    if (!bucket) return
    editSeqRef.current[bucket] = (editSeqRef.current[bucket] ?? 0) + 1
    // markTouched es el embudo ÚNICO de setEntry/setEta/setDisc/setIndrive y
    // del marcado "sin data": cubre todo lo que el hub HACE, que es
    // exactamente lo que cuenta como actividad.
    actividadRef.current[bucket] = registrarActividad(
      actividadRef.current[bucket] || [],
      Date.now()
    )
    setTouchedFronts((prev) => (prev.includes(bucket) ? prev : [...prev, bucket]))
  }, [])

  // "Abrir" una sesión pasada del historial: al hacer click seteamos ciudad+
  // fecha y dejamos acá {dbCity, date} pendiente; cuando las rutas de esa
  // ciudad terminan de cargar, un effect trae las observaciones guardadas de
  // esa fecha y las vuelca al formulario para editar/agregar.
  const [pendingLoad, setPendingLoad] = useState(null)
  // Combos (dbCategory|HH:MM) que se cargaron al "Abrir" una sesión pasada.
  // Al re-guardar, el DELETE tiene que cubrir también estos combos aunque el
  // HP los haya vaciado — si no, borrar una franja entera dejaría filas
  // huérfanas en BD (el DELETE base solo cubre lo que se re-inserta). Null en
  // el flujo normal (carga desde cero). Por-ciudad como el resto del estado.
  const [loadedCombosByCity, setLoadedCombosByCity] = useState({})

  // "Ver lo guardado" (pedido 8, versión acotada): que el hub compare lo que
  // ve en pantalla contra lo que quedó de verdad persistido en
  // pricing_observations para SU propia vista/fecha — no un explorador de
  // data cruda, solo su propio progreso ya guardado.
  const [showSavedData, setShowSavedData] = useState(false)
  const [savedRows, setSavedRows] = useState([])
  const [savedLoading, setSavedLoading] = useState(false)
  // Contador visible en el botón SIN expandir el panel (pedido real de un hub,
  // 2026-07-25: "que salga la cantidad de registros arriba" para poder
  // contrastarlo de un vistazo contra "Guardar progreso (N)"). Query liviana
  // (count-only, sin traer filas) — independiente de `savedRows`/`showSavedData`.
  const [savedCount, setSavedCount] = useState(null)

  // Session history
  const [showHistory, setShowHistory] = useState(false)
  const [sessionHistory, setSessionHistory] = useState([])
  const [histLoading, setHistLoading] = useState(false)
  const [histFrom, setHistFrom] = useState(() => {
    const d = new Date()
    d.setDate(d.getDate() - 30)
    return toISODate(d)
  })
  const [histTo, setHistTo] = useState(() => toISODate(new Date()))
  const [histCity, setHistCity] = useState('')
  const [histEmail, setHistEmail] = useState('')

  const { isRushHour } = useRushHourConfig(country)
  const { timeslots } = useCITimeslots()

  // dbTimeslot ('Morning'/'Midday'/'Evening', mig 148) → ts.label localizado
  // ('Mañana'/'Tarde'/'Noche' en es). Usado por "Ver lo guardado" para no
  // mostrar la etiqueta cruda en inglés sin importar el locale activo.
  const dbTimeslotToLabel = useMemo(() => {
    const m = {}
    for (const ts of timeslots) {
      m[timeslotLabel(ts.start_time?.slice(0, 5))] = ts.label
    }
    return m
  }, [timeslots])

  // Categorías de la vista activa. En TukTuk-por-distrito la única categoría es
  // 'TukTuk'. En la vista NORMAL de una ciudad que además tiene TukTuk (Lima), se
  // saca 'TukTuk' de la grilla — ahora vive en su propia pestaña, no mezclado con
  // las categorías de auto.
  const categories = useMemo(() => {
    if (activeTukTuk != null) return ['TukTuk']
    if (activeSpecialCat) return [activeSpecialCat]
    return (countryConfig.categoriesByCity[uiCity] || []).filter(
      (c) => c !== 'TukTuk' && c !== 'Delivery' && c !== 'Cargo'
    )
  }, [countryConfig, uiCity, activeTukTuk, activeSpecialCat])

  // dbCity: the DB city for the current UI city (use first non-special category)
  const { dbCity } = useMemo(
    () => resolveDbParams(uiCity, categories[0] || '', null, country, dbConfigs),
    [uiCity, categories, country, dbConfigs]
  )

  // ── Rutas de referencia (React Query, Fase 2 2026-07-26) ───────────────
  // Antes: cache manual por-ciudad en un useRef (refsCacheRef) + useEffect.
  // Ahora: misma queryKey/queryFn que useDistanceRefs.js (la pantalla admin
  // de Distancias de Referencia) — cambiar de ciudad sigue sin volver a
  // pegarle a la BD (cache de React Query, sin parpadeo al intercalar A/B),
  // y de paso comparte el cache con la pantalla admin si el hub la visitó
  // en esta sesión. Sin `keepPreviousData`: al cambiar de queryKey (ciudad
  // o país) los datos de la ciudad ANTERIOR no deben verse ni un instante
  // — mismo comportamiento que el `setRefs([])` inmediato de antes.
  const refsQuery = useQuery({
    queryKey: distanceRefsQueryKey(country, dbCity),
    enabled: Boolean(dbCity),
    queryFn: () => fetchDistanceRefs(country, dbCity),
  })
  // useMemo: identidad estable (ver CLAUDE.md — sin esto, `data || []` crea
  // un array nuevo en cada render e invalida en cascada los useMemo que
  // dependen de `refs` aunque los datos no hayan cambiado).
  const refs = useMemo(() => refsQuery.data || [], [refsQuery.data])
  const refsLoading = Boolean(dbCity) && refsQuery.isLoading
  // Ciudad a la que pertenecen las `refs` actuales — null mientras la ciudad
  // objetivo todavía no resolvió (misma señal que antes usaba `pendingLoad`
  // para esperar a que las refs de la ciudad correcta hayan llegado).
  const refsDbCity = dbCity && refsQuery.data !== undefined ? dbCity : null

  // Vista TukTuk-por-distrito. `dbCity` sigue siendo la ciudad REAL de BD
  // ('Lima') — TukTuk no es una ciudad aparte en BD, se distingue por `zone`.
  // `bucketKey` = clave de la rebanada de estado en memoria: para vistas normales
  // es la ciudad de BD (idéntico a antes); para un distrito de TukTuk es una
  // clave sintética única por distrito, para que su borrador/progreso/sesión no
  // se mezclen con la Lima normal ni entre distritos. `viewId` = la parte
  // "ciudad" de la clave del borrador (localStorage): para vistas normales sigue
  // siendo `uiCity` (sin cambios); para TukTuk lleva el distrito. El separador
  // '~' no aparece en ninguna ciudad ni distrito.
  // activeTukTuk: null = vista normal; '' = pestaña TukTuk recién elegida pero
  // el distrito todavía no se resolvió (mientras carga la lista de distritos, o
  // si la ciudad no tiene ninguno cargado en Distancias de Referencia);
  // "<distrito>" = distrito activo. isTukTuk cubre '' Y el distrito real — así
  // la pestaña TukTuk se resalta y el aviso de "sin distritos" puede mostrarse
  // apenas se hace click, sin esperar a la carga async.
  const isTukTuk = activeTukTuk != null
  // Delivery/Cargo (2026-09): sin distrito, zone = el nombre de la categoría
  // — le da a este frente su propia marca de agua de guardado (bucketKeyFor)
  // sin pisar la de "Lima Normal", que comparte la misma dbCity.
  const isSpecialCat = activeSpecialCat != null
  const zone = isTukTuk ? activeTukTuk || null : isSpecialCat ? activeSpecialCat : null
  const bucketKey = bucketKeyFor(dbCity, zone, isTukTuk)
  const viewId = viewIdFor(uiCity, dbCity, zone, isTukTuk)

  // Rebanadas de la ciudad activa — todo el resto del componente sigue leyendo
  // `entries`/`indriveExtra`/`etaEntries`/`discEntries`/`errorKeys`/`loadedCombos`
  // como antes; solo cambian su fuente (mapa por-ciudad) y los setters.
  const entries = entriesByCity[bucketKey] || EMPTY_OBJ
  const indriveExtra = indriveByCity[bucketKey] || EMPTY_OBJ
  const etaEntries = etaByCity[bucketKey] || EMPTY_OBJ
  const discEntries = discByCity[bucketKey] || EMPTY_OBJ
  const errorKeys = errorKeysByCity[bucketKey] || EMPTY_SET
  const turnoTimings = turnoTimingsByCity[bucketKey] || EMPTY_OBJ
  const naKeys = naByCity[bucketKey] || EMPTY_SET
  const loadedCombos = loadedCombosByCity[bucketKey] || null
  const surge = surgeByCity[bucketKey] ?? false

  // dbCity actual accesible desde setters memoizados sin recrearlos; snapshot de
  // los mapas por-ciudad para el flush del borrador (lee la rebanada correcta
  // aunque ya se haya cambiado de ciudad).
  // Clave de la rebanada activa accesible desde los setters memoizados sin
  // recrearlos. Es `bucketKey` (por-distrito en TukTuk, ciudad de BD en el resto)
  // — antes era `dbCity`; para vistas normales es exactamente lo mismo.
  const bucketRef = useRef(bucketKey)
  bucketRef.current = bucketKey
  const perCityRef = useRef(null)
  perCityRef.current = {
    entriesByCity,
    indriveByCity,
    etaByCity,
    discByCity,
    surgeByCity,
    naByCity,
  }
  // "Contexto" del formulario = país + fecha. Al cambiar, TODAS las ciudades
  // quedan obsoletas (eran de la fecha vieja) → se limpian y se re-permite
  // hidratar cada ciudad una vez. `hydratedCitiesRef` recuerda qué ciudades ya
  // se hidrataron en el contexto actual, para no re-hidratar al intercalar A↔B
  // (la memoria manda) — se rastrea por ref, no por el estado en memoria, para
  // no depender del timing de los setState de limpieza.
  const loadedContextRef = useRef(null)
  const hydratedCitiesRef = useRef(new Set())

  // ── Guardia anti-resurrección de borrador (Terminar / Descartar) ──────
  // Un hub reportó en producción (2026-07-22): terminó una sesión de Corp
  // (confirmado en BD: 60 filas guardadas correctamente), pero minutos
  // después el borrador de esa MISMA ciudad/fecha reapareció como "borrador
  // sin terminar" — pese a que clearDraft()+dropCity ya limpian la clave y la
  // rebanada en memoria en el mismo tick. No se pudo reproducir el mecanismo
  // exacto (una escritura tardía de algún efecto de autosave/flush), así que
  // en vez de perseguir la carrera exacta, se blinda el SÍNTOMA: por unos
  // segundos después de Terminar/Descartar, NINGÚN efecto puede volver a
  // escribir esa clave, Y el escáner de "borradores sin terminar" la ignora
  // aunque algo se le escape. Al cierre de la ventana se re-borra una vez
  // más por las dudas (limpia cualquier escritura tardía que haya igual
  // logrado colarse) y se levanta la guardia.
  const RESURRECTION_GUARD_MS = 10_000
  const justFinishedRef = useRef(new Map()) // draftKey → timestamp de "no reescribir"

  const markJustFinished = useCallback((key) => {
    justFinishedRef.current.set(key, Date.now())
    setTimeout(() => {
      try {
        localStorage.removeItem(key)
      } catch {
        /* ignore */
      }
      justFinishedRef.current.delete(key)
    }, RESURRECTION_GUARD_MS)
  }, [])

  const isJustFinished = useCallback((key) => {
    const t = justFinishedRef.current.get(key)
    if (t == null) return false
    if (Date.now() - t > RESURRECTION_GUARD_MS) {
      justFinishedRef.current.delete(key)
      return false
    }
    return true
  }, [])

  // Causa raíz encontrada (2026-07-24 noche, incidente real de Raisa: "2
  // borradores sin terminar" reaparecidos + fila DUPLICADA en ci_sessions
  // para el mismo Punto de Aeropuerto): el auto-load SILENCIOSO
  // (`loadObservationsIntoForm(..., {silent:true})`, ver el efecto de
  // hidratación) no distinguía "esta ciudad+fecha nunca se tocó" de "ESTE
  // hub acaba de Terminar Sesión acá hace instantes" — en ambos casos
  // `entriesByCity[bucket]` está vacío (recién vaciado por `dropCity` al
  // Terminar) y el auto-load busca en el servidor si hay algo guardado. Como
  // las filas SÍ siguen legítimamente en `pricing_observations` (Terminar
  // Sesión las INSERTA, no las borra), el auto-load las traía de vuelta,
  // repoblaba la grilla a 324/324 Y reactivaba la sesión (`setSessionActive
  // (true)`, ver `mapped > 0 && !sessionActive` más abajo) — el hub veía
  // "Terminar Sesión" disponible otra vez segundos/minutos después de
  // haber terminado, exactamente como si nunca hubiera cerrado, y si
  // volvía a tocarlo (razonablemente, para "confirmar" que quedó guardado)
  // se creaba una SEGUNDA fila real en `ci_sessions` para el mismo punto.
  // Confirmado con datos de producción: 2 filas para
  // `Arequipa_Airport_A`/`raisalopez` a 47s de distancia, ambas con 324/324.
  // Guard separado del de arriba (clave por bucket+fecha, no por draftKey de
  // localStorage, y con ventana mucho más larga): un auto-load silencioso
  // nunca debe resucitar algo que ESTE hub acaba de cerrar a propósito —
  // solo una apertura EXPLÍCITA (Historial → Abrir, o "Reanudar" un
  // borrador legítimo) puede volver a activarlo.
  const justFinishedBucketRef = useRef(new Map()) // "bucket::fecha" → timestamp
  // Espejo en localStorage (revisión adversarial 2026-07-24): un `useRef`
  // vive SOLO en memoria del tab — no sobrevive un F5 real, que es
  // justamente uno de los caminos más probables por los que el auto-load
  // silencioso puede haber resucitado el bucket de Raisa (un refresh
  // desmonta y remonta todo, vaciando el Map). El localStorage sí
  // sobrevive, así que es la fuente de verdad; el Map en memoria es solo
  // una lectura rápida para el caso común (sin F5 de por medio).
  const bucketFinishedLsKey = (bk, d) => bucketFinishedLsKeyFor(userEmail, bk, d)

  const markBucketJustFinished = useCallback(
    (bk, d) => {
      const key = `${bk}::${d}`
      const now = Date.now()
      justFinishedBucketRef.current.set(key, now)
      setTimeout(() => {
        justFinishedBucketRef.current.delete(key)
      }, BUCKET_JUST_FINISHED_MS)
      try {
        localStorage.setItem(bucketFinishedLsKey(bk, d), String(now))
      } catch {
        /* quota / disabled — el guard en memoria sigue protegiendo el tab actual */
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [userEmail]
  )

  const isBucketJustFinished = useCallback(
    (bk, d) => {
      const key = `${bk}::${d}`
      let t = justFinishedBucketRef.current.get(key)
      if (t == null) {
        try {
          const raw = localStorage.getItem(bucketFinishedLsKey(bk, d))
          if (raw) t = parseInt(raw, 10)
        } catch {
          /* ignore */
        }
      }
      if (t == null || !Number.isFinite(t)) return false
      if (Date.now() - t > BUCKET_JUST_FINISHED_MS) {
        justFinishedBucketRef.current.delete(key)
        try {
          localStorage.removeItem(bucketFinishedLsKey(bk, d))
        } catch {
          /* ignore */
        }
        return false
      }
      return true
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [userEmail]
  )

  // Agrupar las pestañas de ciudad: los aeropuertos `{Base}_Airport_{A|B}` se
  // juntan bajo un tab "{Base} Aeropuerto" con sub-pestañas Punto A | Punto B.
  // El resto de las ciudades quedan como pestañas normales. Con el estado
  // por-ciudad, saltar entre A y B es instantáneo y no pierde progreso.
  // Pestañas agrupadas POR CIUDAD. Cada "cluster" es una ciudad base (Lima,
  // Trujillo, Arequipa) con sus variantes como pestañas: Normal, Corp,
  // ✈ Aeropuerto (Punto A/B) y TukTuk (por distrito). Los aeropuertos
  // `{Base}_Airport_{A|B}` caen bajo su base; Corp (ciudad propia en BD) se
  // muestra bajo Lima porque es el corporativo de Lima; una ciudad con la
  // categoría 'TukTuk' gana una pestaña TukTuk. Países simples (una sola ciudad)
  // quedan como una pestaña suelta con el nombre de la ciudad.
  const cityClusters = useMemo(
    () => buildCityClusters(uiCities, countryConfig.categoriesByCity),
    [uiCities, countryConfig]
  )

  // uiCity → bucketKey. Para toda vista que no sea TukTuk, `bucketKey` es el
  // dbCity (ver su definición arriba), y el dbCity NO siempre es igual al uiCity:
  // 'Bogotá' ↔ 'Bogota', y un aeropuerto nuevo con acento tendría el mismo
  // desfasaje.
  //
  // POR QUÉ EXISTE: el alcance de la sesión (`pendingScopeMembers`) se PRODUCÍA
  // en espacio uiCity y se CONSUMÍA en espacio bucketKey. Hoy no se nota porque
  // en el catálogo actual los aeropuertos tienen uiCity === dbCity
  // ('Lima_Airport_A'), pero el día que se onboardee un aeropuerto cuyo nombre
  // visible no coincida con el de BD, "Ambos" declararía dos frentes que
  // `handleFinishSession` no va a reconocer al cerrarlos: la sesión no cerraría
  // nunca y el hub quedaría con un pendiente fantasma.
  const uiCityToBucketKey = useMemo(() => {
    const m = {}
    for (const c of uiCities) {
      const cats = countryConfig.categoriesByCity[c] || []
      const { dbCity: dc } = resolveDbParams(c, cats[0] || '', null, country, dbConfigs)
      m[c] = dc || c
    }
    return m
  }, [uiCities, countryConfig, country, dbConfigs])

  // Traduce en los dos sentidos sin romperse si el mapa todavía no cargó.
  const bucketKeyOf = useCallback((ui) => uiCityToBucketKey[ui] ?? ui, [uiCityToBucketKey])

  const activeAirportMembers = useMemo(() => {
    if (isTukTuk) return null
    for (const cl of cityClusters)
      for (const tb of cl.tabs)
        if (tb.type === 'airport' && tb.members.some((m) => m.uiCity === uiCity)) return tb.members
    return null
  }, [cityClusters, uiCity, isTukTuk])

  // Alcance a declarar si se toca "Iniciar Sesión" AHORA MISMO: en un cluster
  // de Aeropuerto, depende de `scopeChoice` (null = todavía no eligió, bloquea
  // el botón); fuera de Aeropuerto (Normal/Corp/TukTuk) siempre es solo la
  // vista actual, igual que antes de este cambio.
  const resolvedStartMembers = activeAirportMembers
    ? scopeChoice === 'both'
      ? // `bucketKeyOf`, no `m.uiCity` a secas: TODO el alcance vive en espacio
        // bucketKey, que es contra lo que compara `handleFinishSession`
        // (`pendingScopeMembers.filter((m) => m !== bucketKey)`) y también
        // `isDeclaredMember` y los efectos de registro de frentes. Con el
        // catálogo de hoy es la identidad; el día que deje de serlo, esta línea
        // es la diferencia entre una sesión que cierra y una que no.
        activeAirportMembers.map((m) => bucketKeyOf(m.uiCity))
      : scopeChoice
        ? [bucketKeyOf(scopeChoice)]
        : null
    : // Espacio bucketKey, NO uiCity (bug real hallado en revisión adversarial
      // 2026-07-24): en TukTuk el uiCity es la ciudad BASE ('Lima'), la misma
      // que usa la pestaña Normal y que TODOS los distritos. Declarando por
      // uiCity, una sesión de TukTuk Comas decía "mi alcance es Lima", así que
      // Lima Normal y SJL contaban como "ya declarados" → nunca se registraban
      // como frente extra y la sesión cerraba dándolos por hechos, con el
      // trabajo del hub abandonado en silencio. En Aeropuerto uiCity===bucketKey
      // ('Lima_Airport_A'), así que esa rama queda idéntica.
      [bucketKey]

  // El selector de alcance es por-cluster: al entrar/salir de Aeropuerto o
  // cambiar de cluster hay que volver a elegir. Cambiar de Punto A a Punto B
  // dentro del MISMO cluster no dispara esto (activeAirportMembers devuelve la
  // misma referencia `tb.members`), así que no pierde la elección ya hecha.
  useEffect(() => {
    setScopeChoice(null)
  }, [activeAirportMembers])

  // Mapa inverso dbCity → uiCity, para "Abrir" una sesión del historial (que
  // guarda la ciudad en formato BD) y saber a qué pestaña de ciudad saltar.
  const dbCityToUiCity = useMemo(() => {
    const m = {}
    for (const c of uiCities) {
      const cats = countryConfig.categoriesByCity[c] || []
      const { dbCity: dc } = resolveDbParams(c, cats[0] || '', null, country, dbConfigs)
      if (dc) m[dc] = c
    }
    return m
  }, [uiCities, countryConfig, country, dbConfigs])

  // Reverse lookup: dbCategory → uiCategory for the current city
  // Built from countryConfig.categoryDbMap entries matching uiCity
  const dbCatToUICat = useMemo(() => {
    const map = {}
    for (const [key, val] of Object.entries(countryConfig.categoryDbMap)) {
      const parts = key.split('|||')
      if (parts[0] === uiCity && parts.length === 2) {
        // key: "Lima|||Economy" → val: { dbCity, dbCategory }
        // uiCat = parts[1], dbCategory = val.dbCategory
        map[val.dbCategory] = parts[1]
      }
    }
    return map
  }, [countryConfig, uiCity])

  // Cascada: reseteo cuando cambia el país DE VERDAD.
  //
  // `countryConfig` NO sirve como señal de "cambió el país" (bug real
  // 2026-08-01, causa del reporte "a los hubs se les reinicia el contador"):
  // es un useMemo sobre `dbConfigs`, y CountryContext.fetchAllConfigs() setea
  // un objeto NUEVO cada vez, con el mismo contenido. Eso pasa al arrancar la
  // app (siembra desde el cache de localStorage y después refetchea) y CADA
  // VEZ que cualquier usuario edita country_config / bot_rules /
  // catalog_extras — el evento realtime `config:changed` dispara otro
  // fetchAllConfigs en TODAS las sesiones abiertas.
  //
  // Con la identidad como disparador, estos dos efectos corrían sin que nadie
  // cambiara de país: tiraban al hub a la primera ciudad (perdiendo la
  // pestaña donde estaba trabajando) y el de más abajo además le mataba la
  // sesión y le borraba el latido. Es exactamente el patrón que advierte
  // CLAUDE.md §2 sobre efectos que dependen de objetos recreados en cada
  // render, aplicado al efecto más destructivo del componente.
  //
  // Se comparan VALORES (el país), no identidades. `uiCity` ya nace con
  // `uiCities[0]` en su useState, así que saltear el montaje no deja nada sin
  // inicializar.
  const prevCountryCascadeRef = useRef(country)
  useEffect(() => {
    if (prevCountryCascadeRef.current === country) return
    prevCountryCascadeRef.current = country
    const firstCity = countryConfig.cities[0]
    setUiCity(firstCity)
    setActiveTukTuk(null)
    setActiveSpecialCat(null)
    // dbCity es reactivo a uiCity y categories, así no hay problema
  }, [country, countryConfig])

  // El cronómetro (⏱) vive en <SessionTimer> con su propio interval, para que
  // su tick por segundo no re-renderice toda la grilla. Ver SessionLiveStatus.

  // ── "Ver lo guardado" — lo que YA quedó persistido para la vista/fecha
  // actual, filtrado a lo que cargó ESTE hub (uploaded_by). Consulta directa
  // (RLS ya permite SELECT sin restricción de ciudad, no hace falta RPC) —
  // así el hub puede comparar contra lo que ve en pantalla y avisar si algo
  // no cuadra, sin exponer el trabajo de otros hubs.
  async function loadSavedData(isCancelled) {
    if (!userEmail || !dbCity) return
    setSavedLoading(true)
    const { data } = await fetchSavedObservations({ country, dbCity, date, userEmail, zone })
    // Guard: si el hub cambió de ciudad/zona/fecha (o cerró el panel) mientras
    // la consulta viajaba, una respuesta tardía no debe pisar lo que ya se ve
    // — sin esto, cambiar rápido de distrito TukTuk con el panel abierto
    // podía mostrar "lo guardado" de un distrito ajeno.
    if (isCancelled && isCancelled()) return
    setSavedRows(data || [])
    setSavedCount(data ? data.length : 0)
    setSavedLoading(false)
  }

  useEffect(() => {
    if (!showSavedData) return
    let cancelled = false
    loadSavedData(() => cancelled)
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSavedData, bucketKey, date])

  // Contador liviano (count-only, sin traer filas) para que "Ver lo guardado
  // (N)" muestre el número SIN necesidad de expandir el panel primero. Si el
  // panel ya está abierto, `loadSavedData` de arriba mantiene `savedCount`
  // sincronizado con más detalle (no hace falta duplicar el pedido acá).
  useEffect(() => {
    if (!userEmail || !dbCity || showSavedData) return
    let cancelled = false
    ;(async () => {
      const { count } = await countSavedObservations({ country, dbCity, date, userEmail, zone })
      if (cancelled) return
      setSavedCount(count ?? 0)
    })()
    return () => {
      cancelled = true
    }
    // userEmail explícito en las deps (no solo bucketKey/date/showSavedData):
    // en el primer mount, `userEmail` puede llegar vacío mientras la sesión
    // de auth todavía está resolviendo — sin esto, el efecto bailaba una vez
    // y nunca reintentaba, dejando el contador en null hasta que el hub
    // cambiara de ciudad/fecha a mano. Mismo patrón de bug que ya está
    // documentado en CLAUDE.md (efecto con una dependencia real no declarada).
  }, [bucketKey, date, showSavedData, userEmail, country, zone, dbCity])

  // ── Load session history ───────────────────────────────
  async function loadSessionHistory() {
    setHistLoading(true)
    const { data } = await fetchSessionHistory({ country, histFrom, histTo, histCity, histEmail })
    setSessionHistory(data || [])
    setHistLoading(false)
  }

  // Rastro de ediciones (pedido 7): `ci_sessions` inserta una fila NUEVA en
  // cada Finalizar — nunca sobrescribe — así que reabrir y re-finalizar YA
  // deja rastro crudo (2+ filas para la misma ciudad/zona/fecha). Acá solo
  // se agrega el resumen "editado N veces, último por X" sobre la fila más
  // reciente de cada grupo — sin columnas nuevas, puro cálculo en memoria.
  const revisionInfoByHistoryId = useMemo(
    () => computeRevisionInfo(sessionHistory),
    [sessionHistory]
  )

  useEffect(() => {
    if (showHistory) loadSessionHistory()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHistory])

  // ── Reset city when country changes ───────────────────
  // El cambio de país resetea la ciudad y el cache de rutas; los datos del
  // formulario los limpia el effect de restauración al detectar el cambio de
  // contexto (país cambió → nueva draftKey → limpia todas las ciudades).
  // MISMO guard que la cascada de arriba, y acá es crítico: este efecto MATA la
  // sesión activa y borra el latido. Antes corría con solo cambiar la
  // identidad de `countryConfig`, así que un admin guardando cualquier cambio
  // en /config les cerraba la sesión a TODOS los hubs a la vez, y un simple
  // arranque de la app se la cerraba al hub que estaba trabajando.
  const prevCountrySessionRef = useRef(country)
  useEffect(() => {
    if (prevCountrySessionRef.current === country) return
    prevCountrySessionRef.current = country
    const firstCity = countryConfig.cities[0]
    setUiCity(firstCity)
    setActiveTukTuk(null)
    setActiveSpecialCat(null)
    // El cache de rutas ya no se limpia a mano: `dbCity`/`country` son parte
    // de la queryKey de React Query, así que un país nuevo automáticamente
    // usa otro namespace de cache — no hace falta invalidar el viejo.
    // Bug real (revisión adversarial 2026-07-23): sin esto, cambiar de país
    // con un alcance "Ambos" de Aeropuerto a medias dejaba `pendingScopeMembers`
    // apuntando a un uiCity del país VIEJO — al eventualmente Terminar Sesión
    // en cualquier ciudad del país nuevo, `remainingAfterThis` nunca vaciaba
    // (el uiCity nuevo nunca coincide con el viejo) y la sesión no cerraba
    // nunca de verdad (heartbeat vivo, cronómetro corrompido con tiempo
    // ajeno). Cambiar de país es una señal inequívoca de que se abandona
    // cualquier sesión/alcance en curso — lo ya guardado con "Guardar
    // Progreso" queda intacto en la BD, esto solo limpia el estado en vivo.
    if (sessionActiveRef.current) {
      setSessionActive(false)
      setPendingScopeMembers([])
      // Mismo motivo que pendingScopeMembers (bug real mig 156): un frente
      // extra del país VIEJO nunca coincidiría con un bucket del país nuevo,
      // así que "Terminar Sesión" jamás lograría vaciarlo y la sesión no
      // cerraría nunca.
      setPendingExtraFronts([])
      setTouchedFronts([])
      if (userEmailRef.current) {
        deleteActiveSession(userEmailRef.current).then(
          () => {},
          () => {}
        )
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [country, countryConfig])

  // ── Distritos de TukTuk (para las sub-pestañas) ────────
  // Ciudad base que tiene una categoría 'TukTuk' (Lima en Perú). Los distritos
  // salen de las zonas cargadas en Distancias de Referencia — si agregás un
  // distrito nuevo ahí, aparece solo como sub-pestaña, sin tocar código.
  const tukTukInfo = useMemo(() => {
    for (const c of uiCities) {
      const cats = countryConfig.categoriesByCity[c] || []
      if (cats.includes('TukTuk')) {
        const { dbCity: dc } = resolveDbParams(c, 'TukTuk', null, country, dbConfigs)
        return { baseUiCity: c, dbCity: dc }
      }
    }
    return null
  }, [uiCities, countryConfig, country, dbConfigs])

  // ── Pararse en un frente a partir de su bucketKey ──────────────────────
  // `bucketKey` y `uiCity` NO son el mismo espacio de nombres (CLAUDE.md §1):
  // 'TT~Lima~Comas' y 'Lima_Airport_A' no existen en el catálogo de ciudades,
  // así que pasárselos crudos a `setUiCity` deja la app en una "ciudad"
  // inventada — grilla vacía y el latido reportándole a Monitoreo algo que no
  // existe. Ese bug ya pasó, y la primera versión del fix solo tapó el caso
  // Aeropuerto porque desarmaba el mapa en vez de la clave.
  //
  // Vive acá y no repetido en cada punto de uso justamente por eso: la
  // traducción se hace UNA vez. Devuelve false si el destino no está en el
  // catálogo — quien llama decide qué hacer, pero nadie salta a la nada.
  const irAFrente = useCallback(
    (bucket) => {
      const partes = parseBucketKey(bucket)
      if (!partes) return false
      const target = dbCityToUiCity[partes.city] || partes.city
      if (partes.kind === 'tuktuk') {
        setUiCity(tukTukInfo?.baseUiCity || target)
        setActiveTukTuk(partes.zone)
        setActiveSpecialCat(null)
        return true
      }
      if (partes.kind === 'category') {
        // Delivery/Cargo: sin distrito, la categoría ES la zone. Se valida
        // que siga existiendo en el catálogo (revisión adversarial
        // 2026-09-07): si se borró la categoría después de que quedaron
        // filas guardadas, saltar igual dejaría la grilla vacía en silencio
        // — mejor no saltar y que el llamador decida qué avisar.
        if (!(countryConfig.categoriesByCity[target] || []).includes(partes.zone)) return false
        setUiCity(target)
        setActiveTukTuk(null)
        setActiveSpecialCat(partes.zone)
        return true
      }
      if (uiCities.includes(target)) {
        setUiCity(target)
        setActiveTukTuk(null)
        setActiveSpecialCat(null)
        return true
      }
      return false
    },
    [dbCityToUiCity, tukTukInfo, uiCities, countryConfig]
  )

  // ── Aviso: sesiones PROPIAS de días anteriores que quedaron sin cerrar
  // (mig 243, pedido user 2026-09-07) ────────────────────────────────────
  // Se consulta UNA vez al entrar (no en cada cambio de vista): es un aviso
  // de bienvenida, no algo que deba recalcularse mientras el hub trabaja.
  // Cubre lo que el aviso temprano de conflicto NO cubre: acá no hay dos
  // pantallas escribiendo, hay CERO — el hub nunca volvió a esa ciudad/fecha
  // para terminarla, y puede haber pasado en OTRO dispositivo.
  // Señal para InstructionsBanner: sube cada vez que una sesión termina de
  // verdad (isFinalInScope más abajo), así el instructivo se colapsa solo
  // desde la SEGUNDA sesión en adelante sin que el hub tenga que cerrarlo a
  // mano (pedido user 2026-09-07).
  const [legendCollapseSignal, setLegendCollapseSignal] = useState(0)
  const [myUnfinished, setMyUnfinished] = useState(null)
  const unfinishedCheckedRef = useRef(false)
  useEffect(() => {
    if (!userEmail || unfinishedCheckedRef.current) return
    unfinishedCheckedRef.current = true
    fetchMyUnfinishedSessions().then(({ data, error }) => {
      if (error || !Array.isArray(data) || data.length === 0) return
      setMyUnfinished(data)
    })
  }, [userEmail])

  useEffect(() => {
    if (!tukTukInfo) {
      setTukTukDistricts([])
      return
    }
    let cancelled = false
    fetchTukTukZones(country, tukTukInfo.dbCity).then(({ data }) => {
      if (cancelled) return
      const zones = [...new Set((data || []).map((r) => r.zone).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b)
      )
      setTukTukDistricts(zones)
    })
    return () => {
      cancelled = true
    }
  }, [tukTukInfo, country])

  // Distrito "pendiente de resolver" (activeTukTuk === '', ver comentario en
  // isTukTuk/zone): apenas la lista de distritos esté disponible, entrar
  // automáticamente al primero HABILITADO — mismo criterio que Aeropuerto
  // entra a Punto A, pero sin caer en un distrito bloqueado.
  useEffect(() => {
    if (activeTukTuk === '' && tukTukDistricts.length > 0) {
      setActiveTukTuk(firstEnabledTukTukDistrict(tukTukDistricts))
    }
  }, [activeTukTuk, tukTukDistricts])

  // El reseteo por cambio de fecha (limpiar todas las ciudades) lo maneja el
  // effect de restauración al detectar el cambio de contexto país+fecha — así se
  // limpia e hidrata la fecha nueva en el orden correcto (ver más abajo).

  // ── Autosave a localStorage (draft) ────────────────────
  // Clave por (usuario, country, uiCity, date). Restaura al cambiar a una
  // clave con borrador existente; persiste cada cambio con debounce 2s;
  // limpia tras guardado exitoso a Supabase (ver handleSave /
  // handleSaveProgress). viewId = uiCity en vistas normales (sin cambios) o
  // `TT~<dbCity>~<distrito>` en TukTuk, para que cada distrito tenga su
  // propio borrador.
  // El userEmail en la clave es DELIBERADO (revisión adversarial
  // 2026-07-23): localStorage es por NAVEGADOR, no por cuenta — en una
  // laptop compartida entre varios hub experts, sin esto el borrador de un
  // hub se restauraba solo como si fuera del hub que abrió sesión después,
  // sin aclarar de quién era. Ver migración de borradores viejos (sin
  // email) más abajo, para no perder trabajo en curso al desplegar esto.
  const draftKey = draftKeyFor(userEmail, country, viewId, date)
  const legacyDraftKey = legacyDraftKeyFor(country, viewId, date)
  const draftHydratedRef = useRef(false)
  // Indicador "guardado hace Xs" — se lee en el header (progress pill).
  const [lastDraftSavedAt, setLastDraftSavedAt] = useState(null)
  // Última confirmación REAL de servidor (latido exitoso o guardado
  // exitoso) — a diferencia de lastDraftSavedAt (solo local), esto le dice
  // al hub si su progreso está de verdad llegando al backend. Ver render
  // del indicador más abajo y el motivo en el comentario del latido.
  // DOS estados distintos a propósito (SESIONES_HALLAZGOS.md P2-14). Antes
  // había uno solo, y el LATIDO lo refrescaba: el hub veía "✓ Confirmado en
  // servidor hace 4s" toda la sesión sin haber guardado una sola celda.
  // Conectividad no es durabilidad.
  // ── Marca de agua de sincronización con el servidor (mig 191) ────────
  // Guarda con qué versión del bucket se sincronizó ESTA pestaña. Va en
  // sessionStorage y no en localStorage a propósito: dos pestañas comparten
  // localStorage, así que ahí la marca de una "avalaría" el guardado de la
  // otra — justo el bug que esto viene a cerrar. sessionStorage sobrevive un
  // F5 y muere con la pestaña, que es exactamente la vida útil que queremos.
  //
  // La clave usa la identidad de BD (dbCity/zone), NO viewId: son namespaces
  // distintos y mezclarlos ya causó pérdida de trabajo (CLAUDE.md §1).
  // La clave se arma SIEMPRE con el bucket explícito, nunca con el "actual":
  // loadObservationsIntoForm puede estar cargando un bucket distinto del que
  // se está mirando, y escribir la marca bajo la clave equivocada haría que
  // el guard avale un bucket que nunca se leyó. Es el mismo desfase de
  // namespaces que CLAUDE.md §1 marca como causa de pérdida real de trabajo.
  const syncSeqKeyFor = useCallback((c, city, z, d) => syncSeqKey(c, city, z, d), [])
  const readSyncSeq = useCallback(() => {
    try {
      const v = sessionStorage.getItem(syncSeqKeyFor(country, dbCity, zone, date))
      return v == null ? null : Number(v)
    } catch {
      return null
    }
  }, [syncSeqKeyFor, country, dbCity, zone, date])
  const writeSyncSeqFor = useCallback(
    (c, city, z, d, n) => {
      const k = syncSeqKeyFor(c, city, z, d)
      try {
        if (n == null) sessionStorage.removeItem(k)
        else sessionStorage.setItem(k, String(n))
      } catch {
        /* Safari privado: sin marca, el guard es conservador (avisa) en vez
           de permisivo (pierde datos). */
      }
    },
    [syncSeqKeyFor]
  )
  const writeSyncSeq = useCallback(
    (n) => writeSyncSeqFor(country, dbCity, zone, date, n),
    [writeSyncSeqFor, country, dbCity, zone, date]
  )
  // Re-sincroniza la marca de agua cuando se restauró un borrador y por lo
  // tanto no se va a consultar el servidor (durabilidad R3). Ver el porqué en
  // el punto de llamada.
  const sincronizarMarcaDesdeBorrador = useCallback(
    async (city, z, d, savedAt) => {
      if (!userEmail) return
      const { data, error } = await fetchBucketWriteMark({
        userEmail,
        country,
        city,
        zone: z,
        date: d,
        withTime: true,
      })

      // Sin fila en el servidor no hay con qué conflictuar: nada que hacer.
      if (error || !data) return

      const escrituraServidor = new Date(data.last_write_at).getTime()
      // Solo se adopta si ESTE cliente es estrictamente más nuevo. Si el
      // servidor escribió después de nuestro último borrador, hubo otra
      // pantalla de verdad y el conflicto tiene que aparecer.
      if (savedAt != null && Number.isFinite(escrituraServidor) && escrituraServidor <= savedAt) {
        writeSyncSeqFor(country, city, z, d, Number(data.write_seq))
      } else if (Number.isFinite(escrituraServidor)) {
        // Mismo caso, pero AVISADO YA — antes el hub solo se enteraba al
        // guardar, después de haber tipeado. La marca queda igual de
        // "vieja" a propósito: el conflicto real de verdad sigue apareciendo
        // al guardar (mig 191), esto es solo el heads-up temprano.
        setEarlyConflictHint({ bucketKey: bucketKeyFor(city, z, isTukTuk), at: data.last_write_at })
      }
    },
    [userEmail, country, writeSyncSeqFor, isTukTuk]
  )

  // Aviso TEMPRANO, no bloqueante: se muestra apenas se detecta que el
  // servidor tiene una escritura más nueva que el borrador local restaurado
  // — antes de que el hub invierta tiempo tipeando y recién se entere al
  // guardar (pedido user 2026-09-07, tras el incidente real de conflicto en
  // Corp). `{ bucketKey, at }` para que solo se muestre en la vista a la que
  // corresponde; se limpia al guardar con éxito (mismo momento que
  // saveConflict) o al resolverlo desde acá.
  const [earlyConflictHint, setEarlyConflictHint] = useState(null)
  // Conflicto detectado por el servidor: { at, isFinish } o null.
  const [saveConflict, setSaveConflict] = useState(null)
  // El aviso de conflicto sale junto al botón que el hub apretó (barra
  // inferior), pero las dos salidas viven arriba de la grilla: en Corp son
  // ~1000px de distancia y el hub se queda mirando un error sin acciones
  // (le pasó a un hub el 2026-09-07). El panel se trae a la vista solo.
  const conflictRef = useRef(null)
  const irAlConflicto = useCallback(() => {
    conflictRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [])
  useEffect(() => {
    if (saveConflict) irAlConflicto()
  }, [saveConflict, irAlConflicto])

  // El borrador NO se está pudiendo escribir (durabilidad R5).
  //
  // Los tres `catch` vacíos de este archivo tapaban dos fallos MUDOS y muy
  // caros: localStorage lleno (QuotaExceededError) y localStorage
  // deshabilitado (Safari privado). En los dos casos el hub sigue tecleando
  // creyendo que su borrador se guarda, y la única señal era que el contador
  // "guardado hace Xs" se congelaba — algo que nadie mira.
  //
  // Con esto, el hub se entera y puede hacer lo único que lo salva: tocar
  // Guardar progreso para mandar al SERVIDOR lo que el navegador no puede
  // retener.
  const [storageFailed, setStorageFailed] = useState(false)

  // ── Un solo escritor del borrador por navegador (P1-10) ──────────────
  //
  // Candados de pestaña (borrador + latido) — extraídos a useCiTabLease.
  // El guard de la mig 191 protege la BASE contra dos pestañas del mismo hub;
  // esto protege el BORRADOR en localStorage. NO se fusionan borradores,
  // nunca (CLAUDE.md §2). Estado acá arriba porque los refs se usan en
  // efectos más abajo en este mismo archivo, ANTES de que `filledCount`
  // exista para calcular `leaseEngaged` — ver useCiTabLease.js.
  const {
    leaseOwner,
    setLeaseOwner,
    leaseOwnerRef,
    hbLeaseOwner,
    setHbLeaseOwner,
    hbLeaseOwnerRef,
  } = useLeaseState()

  const [lastSaveOkAt, setLastSaveOkAt] = useState(null) // guardado REAL

  // Hidratación del borrador (leerlo al montar / cambiar de ciudad, fecha o
  // país) — extraída a useCiDraftHydration.js.
  useCiDraftHydration({
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
  })

  // Autosave con debounce+techo, flush síncrono al cambiar de ciudad/fecha o
  // al cerrar la pestaña — extraído a useCiDraftAutosave.js.
  // `persistirBorrador` no se usa fuera del hook (sus dos únicos llamadores
  // -el cleanup del efecto y el pagehide/visibilitychange- viven adentro).
  const { clearDraft } = useCiDraftAutosave({
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
  })

  // ── Aviso del navegador si hay cambios sin guardar ─────
  // Considera TODAS las ciudades en memoria (no solo la activa): con el estado
  // por-ciudad puede haber datos cargados en el Aeropuerto A aunque estés viendo
  // el B.
  useEffect(() => {
    const anyFilled = (byCity) => Object.values(byCity).some((m) => countFilledEntries(m) > 0)
    const hasUnsaved =
      anyFilled(entriesByCity) ||
      anyFilled(etaByCity) ||
      anyFilled(discByCity) ||
      Object.values(indriveByCity).some((m) => hasMeaningfulIndriveExtra(m)) ||
      Object.values(naByCity).some((s) => s && s.size > 0)
    if (!hasUnsaved) return
    const handler = (e) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [entriesByCity, etaByCity, discByCity, indriveByCity, naByCity])

  // Los indicadores "guardado/confirmado hace Xs" (incluido su ticker de 1s y
  // el cálculo de serverConfirmState) viven en <SaveStatusIndicators> con su
  // propio interval, para que el tick por segundo no re-renderice toda la
  // grilla. Ver SessionLiveStatus.

  // ── Borradores sin terminar (todos, por país) ──────────
  // Un "borrador" = una (ciudad, fecha) con datos SIN TERMINAR, guardado solo
  // en este navegador (localStorage, uno por país/ciudad/fecha). Escaneamos
  // TODAS las claves de este país para: (1) listarle al hub sus borradores con
  // Reanudar/Descartar y (2) aplicar el tope de MAX_DRAFTS borradores a la vez.
  // draftScanTick fuerza un re-escaneo tras terminar/descartar una sesión.
  // Tope subido de 2 a 7 (2026-07-22, pedido del user durante el arranque de
  // pruebas): con TukTuk por distrito + varias ciudades en paralelo entre
  // varios hub experts, 2 era demasiado poco margen operativo.
  const MAX_DRAFTS = 7
  const [activeDrafts, setActiveDrafts] = useState([])
  const [draftScanTick, setDraftScanTick] = useState(0)

  useEffect(() => {
    // Acotado por usuario (ver draftKey) — así en una laptop compartida cada
    // hub solo ve sus PROPIOS borradores pendientes, nunca los de otro hub
    // que haya usado la misma compu antes con su propia cuenta.
    if (!userEmail) {
      setActiveDrafts([])
      return
    }
    const prefix = draftKeyPrefixFor(userEmail, country)
    const list = []
    for (let i = 0; i < localStorage.length; i++) {
      // Try/catch POR CLAVE — un borrador corrupto no debe abortar el escaneo
      // entero y esconder los demás borradores válidos.
      try {
        const k = localStorage.key(i)
        if (!k || !k.startsWith(prefix)) continue
        // Recién Terminada/Descartada: ignorarla en la lista aunque algo haya
        // logrado reescribirla (ver guardia anti-resurrección arriba) — nunca
        // debe aparecer como "borrador sin terminar" en esta ventana.
        if (isJustFinished(k)) continue
        const raw = localStorage.getItem(k)
        if (!raw) continue
        const parsed = JSON.parse(raw)
        // Contar TODO lo cargable: precios + InDrive solo-recomendado + celdas
        // "sin data" (naKeys). Un borrador 100% S/D o solo-recomendado igual es
        // un borrador real que el autosave persistió.
        const count =
          countAllFilled(parsed?.entries, parsed?.indriveExtra) +
          (Array.isArray(parsed?.naKeys) ? parsed.naKeys.length : 0)
        if (count === 0) continue
        const rest = k.slice(prefix.length) // "{viewId}:{date}"
        const sep = rest.lastIndexOf(':')
        if (sep === -1) continue
        const viewIdTok = rest.slice(0, sep)
        const dateTok = rest.slice(sep + 1)
        // TukTuk: viewId = `TT~<dbCity>~<distrito>`. El bucket en memoria es el
        // mismo viewId. Para resumir: volver a la ciudad base con TukTuk + el
        // distrito. Vistas normales: viewId = uiCity, bucket = su dbCity.
        // TukTuk y Delivery/Cargo comparten el mismo formato de clave
        // (`TT~`/`CAT~`, ver lib/dataEntry/keys.js) — parseBucketKey ya sabe
        // distinguirlos por `kind`, no hace falta repetir el split acá.
        const parsedTok = parseBucketKey(viewIdTok)
        let cityLabel, bucketKeyD, resume
        if (parsedTok?.kind === 'tuktuk') {
          const dc = parsedTok.city
          const zn = parsedTok.zone
          bucketKeyD = viewIdTok
          cityLabel = `${dc} TukTuk · ${zn}`
          resume = { tukTuk: true, uiCity: tukTukInfo?.baseUiCity || dc, zone: zn }
        } else if (parsedTok?.kind === 'category') {
          const dc = parsedTok.city
          const zn = parsedTok.zone
          bucketKeyD = viewIdTok
          cityLabel = `${dc} · ${zn}`
          resume = { tukTuk: false, specialCat: zn, uiCity: dc }
        } else {
          const cats = countryConfig.categoriesByCity[viewIdTok] || []
          const { dbCity: dc } = resolveDbParams(viewIdTok, cats[0] || '', null, country, dbConfigs)
          bucketKeyD = dc || viewIdTok
          cityLabel = viewIdTok
          resume = { tukTuk: false, uiCity: viewIdTok }
        }
        list.push({
          key: k,
          city: cityLabel,
          date: dateTok,
          count,
          savedAt: parsed.savedAt || 0,
          bucketKey: bucketKeyD,
          resume,
          turnoTimings: parsed.turnoTimings || null,
        })
      } catch {
        /* borrador corrupto en esta clave puntual — seguir con las demás */
      }
    }
    list.sort((a, b) => b.savedAt - a.savedAt)
    setActiveDrafts(list)
    // Re-escanea al cambiar de vista/país o cuando algo cambia el set de
    // borradores (terminar/descartar bumpean draftScanTick).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [country, draftKey, draftScanTick])

  // Reanudar/descartar un borrador del panel "otros borradores" — extraído
  // a useCiDraftManagement.js.
  const { resumeDraft, discardDraft } = useCiDraftManagement({
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
  })

  // Rutas de la vista activa. En TukTuk, solo las de ESE distrito (zone). En el
  // resto, todas las de la ciudad — la Lima normal ya excluye 'TukTuk' de
  // `categories`, así que sus rutas no entran a la grilla de auto.
  const viewRefs = useMemo(() => {
    if (!isTukTuk) return refs
    return refs.filter((r) => r.category === 'TukTuk' && (r.zone ?? null) === zone)
  }, [refs, isTukTuk, zone])

  // ── Group refs by UI category + bracket ───────────────
  const refsByUICat = useMemo(() => {
    const result = {}
    for (const cat of categories) result[cat] = []
    for (const ref of viewRefs) {
      const uiCat = dbCatToUICat[ref.category]
      if (uiCat && result[uiCat]) result[uiCat].push(ref)
    }
    return result
  }, [viewRefs, dbCatToUICat, categories])

  // ── Categoría "ancla" — la primera categoría configurada por ciudad que
  // no esté excluida de la replicación (countryConfig.categoriesByCity);
  // es la fuente de verdad para "qué ruta se muestra" en el flujo por
  // bracket. Reutiliza el mismo criterio que la cascada de Distancias de
  // Referencia para que "categoría fuente" signifique lo mismo en toda la
  // app.
  const sourceCategory = getSourceCategory(categories)

  // ── Agrupar rutas por bracket (flujo "Ingresar CI" por bracket) ───────
  // Cada grupo ancla en UNA ruta de sourceCategory para ese bracket. Una
  // categoría hermana solo se empareja con esa ancla si tiene EXACTAMENTE
  // una ruta en ese bracket (y la ancla también) — si tiene 0, no hay ruta
  // (ver missingCats); si tiene 2+, no hay forma confiable de saber cuál
  // corresponde a cuál posición del ancla (emparejar por índice de array
  // podría mezclar rutas sin ninguna relación real, ej. TukTuk con varias
  // rutas por distrito en el mismo bracket) — esas quedan en `extras`,
  // mostradas cada una con su propia cabecera de ruta en vez de arriesgar
  // un emparejamiento incorrecto y silencioso.
  const refsByBracket = useMemo(
    () => buildRefsByBracket(refsByUICat, categories, sourceCategory),
    [refsByUICat, categories, sourceCategory]
  )

  // Revisión UX 2026-09: si TODAS las rutas de la vista salen del mismo
  // punto A (Delivery/Cargo: 12 rutas desde Vía Principal 129), el origen se
  // muestra UNA vez arriba de la grilla y no en cada tarjeta. null = orígenes
  // distintos, cada tarjeta muestra el suyo como siempre.
  const commonOrigin = useMemo(() => {
    const origins = new Set()
    for (const { groups, extras } of refsByBracket) {
      for (const g of groups) origins.add(g.anchorRef.point_a || '')
      for (const e of extras) origins.add(e.ref.point_a || '')
    }
    if (origins.size !== 1) return null
    const only = [...origins][0]
    return only || null
  }, [refsByBracket])

  // Orden global de rutas (ancla) dentro de un turno, para numerarlas
  // "Ruta 3/12" — el hub sabe dónde está parado sin contar tarjetas.
  const routeOrder = useMemo(
    () => refsByBracket.flatMap(({ groups }) => groups.map((g) => g.anchorRef.id)),
    [refsByBracket]
  )

  // Categorías sin ninguna ruta en toda la ciudad (no solo en un bracket
  // puntual) — se avisa una sola vez arriba de la grilla.
  const categoriesWithNoRoutes = useMemo(
    () => categories.filter((uiCat) => (refsByUICat[uiCat] || []).length === 0),
    [categories, refsByUICat]
  )

  // Enter en cualquier input de la grilla salta al PRÓXIMO precio vacío en
  // orden de lectura (revisión UX 2026-09): con 36 tarjetas, Tab pasa por
  // ETA/descuento/celdas ya llenas y el hub pierde la mitad del tiempo
  // navegando. Solo precios (el campo obligatorio); ETA y descuento son
  // opcionales y se alcanzan con Tab como siempre. Sin estado de React: se
  // resuelve sobre el DOM en el momento del Enter, así no toca el render de
  // la grilla (CLAUDE.md §5).
  function handleGridKeyDown(e) {
    if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return
    const root = e.currentTarget
    const inputs = [...root.querySelectorAll('input.de-price-input')].filter(
      (el) => !el.disabled && el.offsetParent !== null
    )
    const from = inputs.indexOf(e.target)
    const next =
      inputs.slice(from + 1).find((el) => el.value.trim() === '') ||
      inputs.slice(0, Math.max(from, 0)).find((el) => el.value.trim() === '')
    if (!next) return
    e.preventDefault()
    next.focus()
    next.scrollIntoView({ block: 'center' })
  }

  // ── Entry helpers ──────────────────────────────────────
  // priceKey / indKey: src/lib/dataEntry/keys.js (mismo formato de siempre).

  // Valor "efectivo" de una celda para decidir si está llena: el número de
  // `entries` y, para InDrive sin promedio de bids, el precio recomendado (que
  // vive en indriveExtra, no en entries). Fuente ÚNICA para rowState y para el
  // marcado de errores — que diverjan pintaba en rojo una celda ya cargada.
  const effectiveCellValue = (uiCat, refId, tsLabel, comp) => {
    const v = entries[priceKey(uiCat, refId, tsLabel, comp)] ?? ''
    if (isInDriveVariant(comp) && (v === '' || isNaN(parseFloat(v)))) {
      return indriveExtra[indKey(uiCat, refId, tsLabel, comp)]?.rec ?? ''
    }
    return v
  }

  // Los setters escriben en la rebanada de la vista ACTIVA (bucketRef, para no
  // recrear el callback en cada cambio de vista). clearErrorKeyFor limpia el
  // error de esa celda en la vista activa.
  const clearErrorKeyFor = (city, key) =>
    setErrorKeysByCity((prev) => {
      const cur = prev[city]
      if (!cur || !cur.has(key)) return prev
      const n = new Set(cur)
      n.delete(key)
      return { ...prev, [city]: n }
    })

  const setEntry = useCallback((uiCat, refId, tsLabel, comp, val) => {
    const c = bucketRef.current
    const k = priceKey(uiCat, refId, tsLabel, comp)
    markTouched(c)
    setEntriesByCity((prev) => ({ ...prev, [c]: { ...(prev[c] || {}), [k]: val } }))
    clearErrorKeyFor(c, k) // clear error on edit
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const getEntry = (uiCat, refId, tsLabel, comp) =>
    entries[priceKey(uiCat, refId, tsLabel, comp)] ?? ''

  // ETA por competidor (misma clave que el precio, guardado aparte en
  // etaEntries → columna eta_min). Opcional: no cuenta para el "completado".
  const getEta = (uiCat, refId, tsLabel, comp) =>
    etaEntries[priceKey(uiCat, refId, tsLabel, comp)] ?? ''
  const setEta = useCallback((uiCat, refId, tsLabel, comp, val) => {
    const c = bucketRef.current
    const k = priceKey(uiCat, refId, tsLabel, comp)
    markTouched(c)
    setEtaByCity((prev) => ({ ...prev, [c]: { ...(prev[c] || {}), [k]: val } }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Precio CON descuento por competidor (misma clave que el precio principal,
  // guardado aparte en discEntries → columna price_with_discount). Opcional:
  // no cuenta para el "completado" de la fila.
  const getDisc = (uiCat, refId, tsLabel, comp) =>
    discEntries[priceKey(uiCat, refId, tsLabel, comp)] ?? ''
  const setDisc = useCallback((uiCat, refId, tsLabel, comp, val) => {
    const c = bucketRef.current
    const k = priceKey(uiCat, refId, tsLabel, comp)
    markTouched(c)
    setDiscByCity((prev) => ({ ...prev, [c]: { ...(prev[c] || {}), [k]: val } }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const setIndrive = useCallback((uiCat, refId, tsLabel, comp, extra, avg) => {
    const c = bucketRef.current
    const ik = indKey(uiCat, refId, tsLabel, comp)
    const pk = priceKey(uiCat, refId, tsLabel, comp)
    markTouched(c)
    setIndriveByCity((prev) => ({ ...prev, [c]: { ...(prev[c] || {}), [ik]: extra } }))
    setEntriesByCity((prev) => ({ ...prev, [c]: { ...(prev[c] || {}), [pk]: avg } }))
    clearErrorKeyFor(c, pk)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── "Sin data" (S/D) por celda / por fila ──────────────
  // Una celda marcada S/D = el hub revisó y no había oferta. Cuenta como
  // "resuelta" (no bloquea), se guarda como no_data=true SIN precio, y no ensucia
  // promedios. Marcarla limpia cualquier dato previo de esa celda (precio/eta/
  // desc/bids) — una celda "sin data" no lleva números.
  const getNa = (uiCat, refId, tsLabel, comp) => naKeys.has(priceKey(uiCat, refId, tsLabel, comp))

  // Limpia los datos numéricos de un conjunto de claves en la rebanada de la
  // ciudad activa (para cuando una celda pasa a "sin data").
  const clearCellsData = (c, keys, indIks) => {
    const stripStrings = (prev) => {
      const cur = prev[c]
      if (!cur) return prev
      let changed = false
      const m = { ...cur }
      for (const k of keys) if (k in m && m[k] !== '') ((m[k] = ''), (changed = true))
      return changed ? { ...prev, [c]: m } : prev
    }
    setEntriesByCity(stripStrings)
    setEtaByCity(stripStrings)
    setDiscByCity(stripStrings)
    if (indIks && indIks.length) {
      setIndriveByCity((prev) => {
        const cur = prev[c]
        if (!cur) return prev
        let changed = false
        const m = { ...cur }
        for (const ik of indIks) if (ik in m) (delete m[ik], (changed = true))
        return changed ? { ...prev, [c]: m } : prev
      })
    }
    setErrorKeysByCity((prev) => {
      const cur = prev[c]
      if (!cur) return prev
      const n = new Set(cur)
      for (const k of keys) n.delete(k)
      return { ...prev, [c]: n }
    })
  }

  const toggleNa = useCallback((uiCat, refId, tsLabel, comp) => {
    const c = bucketRef.current
    const k = priceKey(uiCat, refId, tsLabel, comp)
    markTouched(c)
    setNaByCity((prev) => {
      const cur = prev[c] || EMPTY_SET
      const n = new Set(cur)
      if (n.has(k)) n.delete(k)
      else n.add(k)
      return { ...prev, [c]: n }
    })
    clearCellsData(c, [k], isInDriveVariant(comp) ? [indKey(uiCat, refId, tsLabel, comp)] : [])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Bloque: marca/desmarca S/D TODA una fila (todos los competidores visibles de
  // una categoría×ruta×franja). Toggle: si todas están S/D → las desmarca.
  const markRowNa = useCallback((uiCat, refId, tsLabel, comps) => {
    const c = bucketRef.current
    const keys = comps.map((comp) => priceKey(uiCat, refId, tsLabel, comp))
    markTouched(c)
    setNaByCity((prev) => {
      const cur = prev[c] || EMPTY_SET
      const allNa = keys.length > 0 && keys.every((k) => cur.has(k))
      const n = new Set(cur)
      for (const k of keys) {
        if (allNa) n.delete(k)
        else n.add(k)
      }
      return { ...prev, [c]: n }
    })
    clearCellsData(
      c,
      keys,
      comps.filter(isInDriveVariant).map((comp) => indKey(uiCat, refId, tsLabel, comp))
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Row validation ─────────────────────────────────────
  // Returns 'empty' | 'full' | 'partial' for a (uiCat, ref, ts) row
  function rowState(uiCat, ref, ts) {
    const comps = getCiCompetitors(uiCity, uiCat, null, country, dbConfigs)
    // Categoría con TODOS los competidores marcados "no ofrece" (comps=[]) →
    // no hay nada que cargar: se considera completa para no bloquear "Terminar
    // sesión" (si no, full nunca igualaría a total y ningún turno cerraría).
    if (comps.length === 0) return 'full'
    // Una celda está "resuelta" si tiene número real O está marcada "sin data"
    // (S/D): en ambos casos el hub ya la atendió, así que no bloquea la fila.
    const resolved = comps.filter((c) => {
      if (naKeys.has(priceKey(uiCat, ref.id, ts.label, c))) return true
      const v = effectiveCellValue(uiCat, ref.id, ts.label, c)
      return v !== '' && !isNaN(parseFloat(v))
    })
    if (resolved.length === 0) return 'empty'
    if (resolved.length === comps.length) return 'full'
    return 'partial'
  }

  // Estado de una RUTA entera (todas sus categorías) en un turno — para el
  // ✓/●/○ de la cabecera de la tarjeta y el minimapa del turno (revisión UX
  // 2026-09). Mismo criterio de "presente" que BracketRouteGroup: una
  // categoría sin ruta en este bracket o sin competidores visibles no cuenta.
  function groupStatus(group, ts) {
    let full = 0
    let any = 0
    let n = 0
    for (const uiCat of categories) {
      const ref = group.byCategory[uiCat]
      if (!ref) continue
      if (getCiCompetitors(uiCity, uiCat, null, country, dbConfigs).length === 0) continue
      n++
      const st = rowState(uiCat, ref, ts)
      if (st === 'full') full++
      if (st !== 'empty') any++
    }
    if (n === 0 || any === 0) return 'empty'
    return full === n ? 'full' : 'partial'
  }

  // ── Count filled ───────────────────────────────────────
  // Celdas con dato + celdas marcadas "sin data" (S/D) — ambas cuentan como
  // atendidas para el contador de progreso.
  const filledCount = useMemo(
    () => countAllFilled(entries, indriveExtra) + naKeys.size,
    [entries, indriveExtra, naKeys]
  )

  // Celdas que "Guardar progreso" va a persistir DE VERDAD — solo las de
  // filas COMPLETAS (mismo criterio que handleSaveProgress).
  //
  // Antes el botón mostraba `filledCount` y el mensaje de éxito decía otro
  // número: "Guardar progreso (108)" → "96 registros guardados". Las 12
  // restantes quedaban solo en localStorage y el hub no tenía forma de
  // saberlo (SESIONES_HALLAZGOS.md P2-13). Si esa laptop se rompía, se
  // perdían.
  const savableCount = useMemo(() => {
    let n = 0
    for (const uiCat of categories) {
      for (const ref of refsByUICat[uiCat] || []) {
        for (const ts of timeslots) {
          if (rowState(uiCat, ref, ts) !== 'full') continue
          // Una fila completa aporta una celda por competidor visible.
          n += (getCiCompetitors(uiCity, uiCat, null, country, dbConfigs) || []).length
        }
      }
    }
    return Math.min(n, filledCount)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    entries,
    indriveExtra,
    naKeys,
    categories,
    refsByUICat,
    timeslots,
    uiCity,
    filledCount,
    country,
    dbConfigs,
  ])

  // Efectos de los dos candados (tick, storage, pagehide) — extraídos a
  // useCiTabLease.js. `claimDraftLease` es "Usar esta pestaña" del aviso de
  // pestaña duplicada.
  const claimDraftLease = useCiTabLeaseEffects({
    draftKey,
    userEmail,
    sessionActive,
    filledCount,
    leaseOwner,
    setLeaseOwner,
    setHbLeaseOwner,
  })

  // Progreso POR TURNO (Mañana/Tarde/Noche) — para el header colapsable de
  // cada TurnoSection. Mismo criterio que filledCount/countAllFilled de
  // arriba, pero separado por el 3er segmento de la key (tsLabel) en vez de
  // sumar las 3 franjas juntas. priceKey/indKey son `uiCat|refId|tsLabel|comp`
  // y `uiCat|refId|tsLabel` respectivamente (ver definición más abajo).
  const filledByTimeslot = useMemo(
    () => countFilledByTimeslot(entries, indriveExtra, naKeys, timeslots),
    [entries, indriveExtra, naKeys, timeslots]
  )

  // Qué turnos tienen celdas marcadas en error (rojo) — para avisar en la
  // cabecera del TurnoSection cuando está COLAPSADO y esas celdas quedan
  // fuera de vista (revisión adversarial 2026-07-23: antes el hub no tenía
  // forma de saber que un turno colapsado tenía filas a medias).
  const errorsByTimeslot = useMemo(() => {
    const m = {}
    for (const k of errorKeys) {
      const tsLabel = k.split('|')[2]
      m[tsLabel] = true
    }
    return m
  }, [errorKeys])

  // Borradores DISTINTOS al de la vista actual (para el banner de la lista,
  // TODOS los tipos) y si llegamos al tope. blockNewSlot: la vista actual está
  // vacía Y ya hay MAX_DRAFTS borradores en OTRAS ciudades/fechas → hay que
  // terminar/descartar uno antes de empezar este (evita acumular borradores a
  // medias). No bloquea si estás editando un borrador existente ni una sesión
  // reabierta del historial (loadedCombos seteado).
  //
  // TukTuk por distrito queda FUERA del tope: es un solo trabajo (Lima TukTuk)
  // repartido a propósito entre varios hub experts en paralelo — 7 distritos,
  // cada uno su propio borrador. Si contaran contra el tope de 2, el 3er
  // distrito quedaría bloqueado apenas dos estuvieran a medias. Tampoco cuentan
  // COMO "otro borrador" hacia el tope de una ciudad normal (mismo criterio que
  // antes: antes de este cambio TukTuk vivía adentro del borrador de Lima, no
  // sumaba aparte).
  const otherDrafts = useMemo(
    () => activeDrafts.filter((d) => d.key !== draftKey),
    [activeDrafts, draftKey]
  )
  const otherDraftsForCap = useMemo(
    () => otherDrafts.filter((d) => !d.resume?.tukTuk),
    [otherDrafts]
  )
  const atDraftCap = !isTukTuk && otherDraftsForCap.length >= MAX_DRAFTS
  const blockNewSlot = atDraftCap && filledCount === 0 && !loadedCombos

  // ── Build rows to insert ───────────────────────────────
  // Lógica de fila en src/lib/dataEntry/rows.js (buildRowsForSlot).
  function buildRows(uiCat, ref, ts) {
    const comps = getCiCompetitors(uiCity, uiCat, null, country, dbConfigs)
    const { year, week } = getISOYearWeek(date)
    const rush = isRushHour(ts.start_time?.slice(0, 5), dbCity) ?? false
    return buildRowsForSlot({
      comps,
      uiCat,
      ref,
      ts,
      rush,
      year,
      week,
      entries,
      indriveExtra,
      etaEntries,
      discEntries,
      naKeys,
    })
  }

  // Categoría de BD de una categoría de UI en la vista actual — la usan el
  // payload de cada fila y el acote del DELETE (misma resolución en ambos).
  const resolveDbCategory = (uiCat) =>
    resolveDbParams(uiCity, uiCat, null, country, dbConfigs).dbCategory

  // Fila de pricing_observations: src/lib/dataEntry/rows.js. El porqué de cada
  // columna (observed_time real vs timeslot estable, zone ''→null, dueño
  // uploaded_by, no_data) está documentado allá; acá solo se pasa el contexto.
  function buildInsertPayload(r, capturedTime) {
    return buildInsertPayloadRow(r, capturedTime, {
      dbCity,
      date,
      surge,
      userEmail,
      country,
      resolveDbCategory,
    })
  }

  // ── Validate rows & collect errors ─────────────────────
  function validateAndCollectErrors(requireAllFull = false) {
    const newErrors = new Set()
    let hasPartial = false
    let hasEmpty = false

    for (const uiCat of categories) {
      const catRefs = refsByUICat[uiCat] || []
      const comps = getCiCompetitors(uiCity, uiCat, null, country, dbConfigs)
      for (const ref of catRefs) {
        for (const ts of timeslots) {
          const state = rowState(uiCat, ref, ts)
          if (state === 'partial') {
            hasPartial = true
            // mark missing cells (mismo criterio de "resuelta" que rowState: una
            // celda con número, InDrive con recomendado, o marcada S/D NO es
            // faltante — si no se pintaba en rojo una celda ya atendida)
            comps.forEach((comp) => {
              const key = priceKey(uiCat, ref.id, ts.label, comp)
              if (naKeys.has(key)) return
              const v = effectiveCellValue(uiCat, ref.id, ts.label, comp)
              if (v === '' || isNaN(parseFloat(v))) {
                newErrors.add(key)
              }
            })
          }
          if (state === 'empty' && requireAllFull) {
            hasEmpty = true
            comps.forEach((comp) => {
              newErrors.add(priceKey(uiCat, ref.id, ts.label, comp))
            })
          }
        }
      }
    }
    setErrorKeysByCity((prev) => ({ ...prev, [bucketKey]: newErrors }))
    return { hasPartial, hasEmpty, errorCount: newErrors.size }
  }

  // Reabrir una sesión del historial + auto-load del servidor — extraído a
  // useCiSessionHistory.js. `loadObservationsIntoForm` no se usa fuera del
  // hook (su único llamador es el efecto de `pendingLoad`, que vive adentro).
  const { openHistorySession } = useCiSessionHistory({
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
  })

  // ── Total expected rows ────────────────────────────────
  const totalExpected = useMemo(() => {
    let n = 0
    for (const uiCat of categories) {
      const catRefs = refsByUICat[uiCat] || []
      const comps = getCiCompetitors(uiCity, uiCat, null, country, dbConfigs)
      n += catRefs.length * timeslots.length * comps.length
    }
    return n
  }, [refsByUICat, categories, timeslots, uiCity, country, dbConfigs])

  // Total esperado de UN SOLO turno (mismo cálculo que totalExpected, sin
  // multiplicar por timeslots.length) — para el contador de TurnoSection.
  const totalExpectedPerTimeslot = useMemo(() => {
    let n = 0
    for (const uiCat of categories) {
      const catRefs = refsByUICat[uiCat] || []
      const comps = getCiCompetitors(uiCity, uiCat, null, country, dbConfigs)
      n += catRefs.length * comps.length
    }
    return n
  }, [refsByUICat, categories, uiCity, country, dbConfigs])

  // Ciclo de vida de sesión (arrancar, guardar progreso, terminar) —
  // extraído a useCiSessionActions.js.
  const { handleStartSession, handleSaveProgress, handleFinishSession } = useCiSessionActions({
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
  })

  // ── Estampado de tiempo por turno (pedido user 2026-07-24) ──────────────
  // Primer fill de un turno (0→1) → startedAt. 100% relleno → endedAt. Nunca
  // se sobreescribe una vez estampado — reabrir una sesión ya terminada para
  // corregir un dato (o resumir un draft que ya traía turnos completos) no
  // debe falsificar el tiempo original con "ahora". `turnoTimings` para este
  // bucket ya viene seedeado (draft local restaurado u openHistorySession)
  // ANTES de que este efecto corra por primera vez sobre datos existentes,
  // así que "ya tiene startedAt/endedAt" cubre tanto lo estampado en vivo acá
  // como lo restaurado.
  useEffect(() => {
    if (!totalExpectedPerTimeslot) return
    setTurnoTimingsByCity((prev) => {
      const cur = prev[bucketKey] || EMPTY_OBJ
      let changed = false
      const next = { ...cur }
      for (const [label, filled] of Object.entries(filledByTimeslot)) {
        const t = next[label]
        let startedAt = t?.startedAt
        let endedAt = t?.endedAt
        let labelChanged = false
        if (filled > 0 && !startedAt) {
          // Un turno que aparece YA COMPLETO sin tener `startedAt` no es
          // trabajo que estemos viendo ocurrir: es una grilla que llegó
          // entera de un saque (auto-load del servidor sin `turno_timings`
          // de dónde sembrar — otra laptop, relevo entre hubs, caché limpia,
          // o una sesión que solo usó "Guardar progreso" y nunca Terminar).
          //
          // Estampar acá ponía `startedAt` Y `endedAt` con el MISMO instante
          // en la misma pasada: un tramo de ancho cero que hacía que
          // `duration_minutes` saliera 0.0 — el síntoma que este trabajo vino
          // a matar, por un camino nuevo. Y era peor que el original, porque
          // el 0 quedaba marcado como medición confiable.
          //
          // Peor todavía: esos timings se propagan al borrador y al latido, y
          // `startedAt` no se sobreescribe NUNCA, así que la corrupción era
          // permanente para ese bucket+fecha y `admin_close_ci_session` leía
          // lo mismo.
          //
          // No estampar nada es la respuesta honesta: de ese turno no sabemos
          // cuándo se trabajó. La duración cae al fallback de reloj, marcado
          // como NO confiable, que es exactamente lo que corresponde.
          if (filled >= totalExpectedPerTimeslot) continue
          startedAt = new Date().toISOString()
          labelChanged = true
        }
        if (filled >= totalExpectedPerTimeslot && startedAt && !endedAt) {
          endedAt = new Date().toISOString()
          labelChanged = true
        }
        if (labelChanged) {
          next[label] = { startedAt, endedAt }
          changed = true
        }
      }
      if (!changed) return prev
      return { ...prev, [bucketKey]: next }
    })
  }, [filledByTimeslot, totalExpectedPerTimeslot, bucketKey])

  // ── Frentes extra (pedido user 2026-07-24, puntos 2 y 2b) ───────────────
  // Si el hub está trabajando (sessionActive) y ESCRIBE en un bucket que NO
  // declaró de antemano (no está en pendingScopeMembers), registrarlo como
  // frente extra — así "Terminar Sesión" no cierra de verdad hasta que ese
  // frente también se cierre. Solo se agrega acá; sacar es responsabilidad
  // de handleFinishSession (al completarlo) o discardDraft (al abandonarlo).
  //
  // El disparador es `touchedFronts` (el hub escribió acá), NO el contador de
  // celdas llenas: la heurística previa (0 < filled < total) fallaba en las
  // dos direcciones — falso positivo al navegar a un frente ya 100% completo
  // de una sesión anterior (auto-cargado, el hub no tocó nada) y falso
  // negativo si el hub llenaba un frente al 100% y lo abandonaba sin cerrarlo.
  //
  // El registro es REVERSIBLE: si el frente vuelve a quedar en 0 celdas, se
  // des-registra. Sin eso (bug real, revisión adversarial 2026-07-24) tocar
  // una celda por error y borrarla dejaba la sesión trabada PARA SIEMPRE: el
  // frente quedaba pendiente, pero "Terminar Sesión" ahí exige la grilla
  // COMPLETA y el borrador vacío ni siquiera aparecía en el panel de
  // borradores para poder descartarlo. La única salida era inventar un día
  // entero de "Sin data" o cambiar de país.
  const isDeclaredMember = pendingScopeMembers.includes(bucketKey)
  useEffect(() => {
    if (!sessionActive || isDeclaredMember) return
    const shouldBePending = touchedFronts.includes(bucketKey) && filledCount > 0
    setPendingExtraFronts((prev) => {
      const isPending = prev.includes(bucketKey)
      if (shouldBePending === isPending) return prev
      return shouldBePending ? [...prev, bucketKey] : prev.filter((bk) => bk !== bucketKey)
    })
  }, [sessionActive, isDeclaredMember, touchedFronts, filledCount, bucketKey])

  // ── Presencia: "quién más está acá ahora" (pedidos 2, 3, 4) ────────────
  // Lectura liviana vía RPC (mig 152, SECURITY DEFINER — el RLS normal de
  // ci_active_sessions solo deja ver la fila propia) para avisar, SIN
  // bloquear nada, si otro hub está trabajando el mismo bucket ahora mismo.
  // La flexibilidad de redistribuirse entre hubs es intencional (pedido 2) —
  // esto es solo visibilidad para coordinarse, nunca un candado.
  //
  // ARRANCÓ acotado a Aeropuerto y TukTuk, que eran los únicos frentes que se
  // repartían entre varias personas. Dejó de serlo: el 2026-08-10 se puso a
  // TRES hubs a medir Corporativo el mismo día a propósito, para triplicar la
  // muestra. Está probado que no se pisan (scripts/simulate-corp-tres-hubs.sql)
  // pero no se veían entre sí, que es justo lo que necesitan para repartirse
  // los turnos y no medir los tres lo mismo a la misma hora.
  const [presence, setPresence] = useState(EMPTY_PRESENCE)
  useEffect(() => {
    if (!country) return
    let cancelled = false
    const fetchPresence = () => {
      fetchPresenceRpc(country).then(({ data, error }) => {
        if (cancelled || error) return
        // Compara por VALOR antes de setear. Sin esto, cada 20 segundos entra
        // un array nuevo aunque no haya cambiado nada y la grilla entera
        // reconcilia al pedo — y en Ingresar CI eso son 108-324 celdas sin
        // React.memo (CLAUDE.md §5). En el caso normal, que es "no cambió
        // nadie", ahora no hay ni un render.
        setPresence((prev) => (mismaPresencia(prev, data) ? prev : data || EMPTY_PRESENCE))
      })
    }
    fetchPresence()
    const id = setInterval(fetchPresence, 20_000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [country])

  // Hubs (≠ yo, ya excluidos por la RPC) activos ahora mismo en esa
  // ciudad/zona EXACTA — misma identidad que usa ci_active_sessions.
  const presenceFor = (city, zone) =>
    presence.filter((p) => p.city === city && (p.zone ?? null) === (zone ?? null))

  // Los otros hubs en el bucket que estoy mirando AHORA. Aeropuerto y TukTuk
  // ya lo resuelven dentro de sus propios selectores (cada fila muestra quién
  // está en ESE punto o distrito), así que ahí este cartel sería el mismo dato
  // dos veces; en el resto de las vistas es el único lugar donde se ve.
  const presenciaAqui = useMemo(
    () =>
      activeAirportMembers || isTukTuk ? EMPTY_PRESENCE : presenciaEnBucket(presence, dbCity, zone),
    [presence, dbCity, zone, activeAirportMembers, isTukTuk]
  )

  // Memoria del total de cada frente visitado (ver `totalByBucket`).
  useEffect(() => {
    if (!totalExpected) return
    setTotalByBucket((prev) =>
      prev[bucketKey] === totalExpected ? prev : { ...prev, [bucketKey]: totalExpected }
    )
  }, [bucketKey, totalExpected])

  // Frentes abiertos (mig 161) — TODOS los que el hub tiene a medias, con
  // `current` marcando dónde está parado ahora. Va en el latido para que
  // Monitoreo y la presencia dejen de ver solo la última pestaña tocada.
  // Celdas atendidas por frente. Se extrajo del memo de `fronts` cuando el
  // aviso de "trabajo sin guardar" pasó a necesitar el MISMO número: dos
  // cuentas distintas de lo mismo terminan divergiendo, y acá una diría "162
  // sin guardar" mientras la otra le reporta otra cosa a Monitoreo.
  const llenoPorFrente = useMemo(() => {
    const all = [...pendingScopeMembers, ...pendingExtraFronts, bucketKey]
    const filledByBucket = {}
    for (const bk of all) {
      if (bk === bucketKey) {
        filledByBucket[bk] = filledCount
        continue
      }
      // La grilla se hidrata por bucket VISITADO (ver hydratedCitiesRef): un
      // frente que el hub no volvió a abrir en esta carga de página no tiene
      // rebanada en memoria. Reportar 0 ahí sería afirmar "no arrancó" sobre
      // un frente que puede tener medio día de trabajo guardado — `null` dice
      // "no sé", que es lo honesto y lo que Monitoreo sabe mostrar.
      if (!hydratedCitiesRef.current.has(bk)) {
        filledByBucket[bk] = null
        continue
      }
      // Mismo cálculo que `filledCount` de la vista actual: las celdas
      // marcadas "Sin data" CUENTAN como resueltas (si no, un frente cerrado a
      // fuerza de S/D aparecía a medias y nunca llegaba a completo).
      filledByBucket[bk] =
        countAllFilled(entriesByCity[bk], indriveByCity[bk]) + (naByCity[bk]?.size || 0)
    }
    return filledByBucket
  }, [
    pendingScopeMembers,
    pendingExtraFronts,
    bucketKey,
    filledCount,
    entriesByCity,
    indriveByCity,
    naByCity,
  ])

  const fronts = useMemo(() => {
    return buildFronts({
      scopeMembers: pendingScopeMembers,
      extraFronts: pendingExtraFronts,
      currentBucket: bucketKey,
      filledByBucket: llenoPorFrente,
      totalByBucket: { ...totalByBucket, [bucketKey]: totalExpected },
    })
  }, [
    pendingScopeMembers,
    pendingExtraFronts,
    bucketKey,
    llenoPorFrente,
    totalExpected,
    totalByBucket,
  ])

  // ══ "Guardar todo" — guardar TODOS los frentes, sin importar la pestaña ══
  //
  // POR QUÉ EXISTE (incidente del 2026-08-11)
  // "Guardar progreso" guarda solo el frente donde estás parado, y eso nunca
  // se dijo en pantalla. Dos hubs midieron Corporativo, apretaron Guardar
  // estando en la pestaña de TukTuk, y se fueron convencidas de haber
  // guardado Corp. El guardado hizo exactamente lo que decía; el problema era
  // que no decía qué.
  //
  // CÓMO FUNCIONA, Y POR QUÉ ASÍ
  // Recorre los frentes de a uno: se PARA en cada uno y usa el mismo
  // `handleSaveProgress` de siempre. La alternativa —armar las filas de un
  // frente sin pararse en él— obligaba a parametrizar `buildRows`/`performSave`,
  // que es el camino por el que pasa TODO guardado de la app y el que
  // concentra los bugs más caros del proyecto (borrados de más, data de otro
  // hub). Esto no toca ni una línea de ese camino: solo lo llama varias veces.
  //
  // El precio es que hay que esperar a que cada frente esté realmente listo
  // (rutas cargadas + borrador hidratado) antes de guardarlo. Guardar antes de
  // tiempo vería la grilla vacía y reportaría "no hay filas completas" sobre
  // un frente lleno.
  // Con un solo frente abierto, "Guardar todo" y "Guardar progreso" harían
  // exactamente lo mismo. Dos botones para una acción no aclaran nada: dan a
  // entender que uno guarda algo que el otro no.
  // Identidad estable (CLAUDE.md §5): este array baja como prop y se usa como
  // dependencia; recrearlo en cada render dispararía trabajo de más.
  const frentesAbiertos = useMemo(
    () => [...new Set([...pendingScopeMembers, ...pendingExtraFronts, bucketKey])],
    [pendingScopeMembers, pendingExtraFronts, bucketKey]
  )
  const hayOtrosFrentes = frentesAbiertos.length > 1
  // Cola de "Guardar todo" — extraída a useCiSaveAllQueue.js.
  const { guardandoTodo, handleGuardarTodo } = useCiSaveAllQueue({
    bucketKey,
    saving,
    refsLoading,
    refsDbCity,
    dbCity,
    savableCount,
    irAFrente,
    handleSaveProgress,
    frentesAbiertos,
    llenoPorFrente,
    editSeqRef,
    savedSeqRef,
    hydratedCitiesRef,
    setMsg,
    t,
    notify,
  })

  // Latido de sesión activa (Monitoreo) — extraído a useCiHeartbeat.js.
  const { lastHeartbeatOkAt } = useCiHeartbeat({
    sessionActive,
    userEmail,
    leaseOwnerRef,
    hbLeaseOwnerRef,
    country,
    dbCity,
    zone,
    date,
    filledCount,
    totalExpected,
    fronts,
    totalExpectedPerTimeslot,
    filledByTimeslot,
    turnoTimings,
    activeAirportMembers,
    pendingScopeMembers,
    bucketKeyOf,
    bucketKey,
  })

  // Limpieza al desmontar/navegar fuera de la página (best-effort — un
  // refresh duro no garantiza que esto corra, igual que el flush del
  // borrador; por eso Monitoreo trata un latido viejo como "no vivo" por
  // antigüedad en vez de depender de este cleanup).
  const sessionActiveRef = useRef(sessionActive)
  sessionActiveRef.current = sessionActive
  const userEmailRef = useRef(userEmail)
  userEmailRef.current = userEmail
  // NO se borra el latido al desmontar (SESIONES_HALLAZGOS.md P1-4).
  //
  // Antes se hacía `.delete().eq('user_email', ...)`, y este cleanup corre en
  // CUALQUIER desmontaje: alcanzaba con que el hub tocara "Monitoreo" en el
  // menú y volviera para que desapareciera de "en vivo" y se perdiera el
  // único registro server-side de cuándo empezó (el siguiente latido
  // re-INSERTA con started_at = now()).
  //
  // El primer intento de arreglo fue ACOTAR el borrado por
  // (país, ciudad, zona, fecha). No servía: `ci_active_sessions` tiene PK
  // `user_email` a secas, así que hay UNA sola fila por hub y el predicado
  // acotado matcheaba siempre la misma — un no-op. Y encima abría un caso
  // nuevo: si el hub cambiaba de ciudad y navegaba afuera antes de que el
  // latido con debounce de 1,5s actualizara la fila, el DELETE no matcheaba
  // nada y quedaba una sesión fantasma marcada como viva.
  //
  // La solución correcta es no borrar acá y dejar que la fila caduque por
  // ANTIGÜEDAD, que es como Monitoreo ya decide qué está vivo
  // (LIVE_STALE_MS = 3 min, mig 146). El costo es que una salida real deja la
  // fila visible hasta 3 minutos; el beneficio es que una navegación interna
  // deja de destruir el estado de sesión. Terminar y cambiar de país sí
  // siguen borrándola explícitamente, que es cuando corresponde.

  // Base del cronómetro visible (⏱ del header).
  //
  // Se prefiere el inicio real del primer turno tocado antes que
  // `sessionStartRef`, para que el reloj de pantalla y el `started_at` que se
  // persiste no se contradigan. El caso concreto: al cerrar el Punto A de
  // Aeropuerto "Ambos", `sessionStartRef` se reinicia a `Date.now()`, así que
  // el Punto B —lleno hace una hora— mostraba 00:00:06.
  //
  // El guard de fecha NO es opcional: mirar una fecha PASADA seedea
  // `turnoTimings` con los timestamps de aquel día (ver `historicTimings` en
  // loadObservationsIntoForm), y sin este chequeo el cronómetro volvería a
  // mostrar 30:00:00 — exactamente el bug que `debeReanudarTramo()` ya
  // documenta y evita para la siembra. Corregir un día pasado es un tramo
  // nuevo, y su reloj arranca en cero.
  //
  // Ojo: esto sigue siendo reloj de pared (incluye el almuerzo entre el corte
  // de la mañana y el de la tarde); `duration_minutes` no. Son dos preguntas
  // distintas —"desde cuándo estás en esto" vs "cuánto trabajo hubo"— y la
  // segunda es la que se guarda y la que el user quiere poder promediar.
  const timerStart =
    date === todayStr()
      ? (earliestTurnoStart(turnoTimings) ?? sessionStartRef.current)
      : sessionStartRef.current

  // ── Render ─────────────────────────────────────────────
  return (
    <div className="de-page">
      {/* ── Header ── */}
      <div className="de-header">
        <div className="de-header__left">
          <h1>{t('dataentry.title')}</h1>
          {sessionActive && (
            <SessionTimer sessionStart={timerStart} title={t('dataentry.timer_title')} />
          )}
        </div>
        <div className="de-header__actions">
          {!sessionActive ? (
            <>
              {activeAirportMembers && (
                <div className="de-scope-picker">
                  <span className="de-scope-picker-label">{t('dataentry.scope_picker_label')}</span>
                  {activeAirportMembers.map((m) => (
                    <button
                      key={m.uiCity}
                      type="button"
                      className={`de-scope-option${scopeChoice === m.uiCity ? ' active' : ''}`}
                      onClick={() => setScopeChoice(m.uiCity)}
                    >
                      {t('dataentry.scope_point', { side: m.side })}
                    </button>
                  ))}
                  <button
                    type="button"
                    className={`de-scope-option${scopeChoice === 'both' ? ' active' : ''}`}
                    onClick={() => setScopeChoice('both')}
                  >
                    {t('dataentry.scope_both')}
                  </button>
                </div>
              )}
              <Button
                className="bg-green-600 shadow-[0_2px_6px_rgba(22,163,74,0.3)] hover:bg-green-700"
                onClick={() => resolvedStartMembers && handleStartSession(resolvedStartMembers)}
                disabled={saving || !resolvedStartMembers}
                title={!resolvedStartMembers ? t('dataentry.scope_pick_first') : undefined}
              >
                {t('dataentry.start_session')}
              </Button>
            </>
          ) : (
            <>
              <Button
                onClick={handleSaveProgress}
                disabled={saving || guardandoTodo}
                title={t('dataentry.save_progress_hint', { front: frontLabel(bucketKey) })}
              >
                {saving
                  ? t('dataentry.saving')
                  : `${t('dataentry.save_progress_front', {
                      front: frontLabel(bucketKey),
                    })}${savableCount > 0 ? ` (${savableCount})` : ''}`}
              </Button>
              {hayOtrosFrentes && (
                <Button
                  className="bg-slate-700 hover:bg-slate-800"
                  onClick={handleGuardarTodo}
                  disabled={saving || guardandoTodo}
                  title={t('dataentry.save_all_hint')}
                >
                  {guardandoTodo ? t('dataentry.save_all_running') : t('dataentry.save_all')}
                </Button>
              )}
              <Button
                className="bg-green-800 hover:bg-green-900"
                onClick={handleFinishSession}
                disabled={saving || guardandoTodo}
              >
                {pendingScopeMembers.length > 1 || pendingExtraFronts.length > 0
                  ? t('dataentry.end_session_point')
                  : t('dataentry.end_session')}
              </Button>
            </>
          )}
        </div>
      </div>

      <InstructionsBanner t={t} collapseSignal={legendCollapseSignal} />

      {/* Sesiones propias de días anteriores sin cerrar (mig 243). Solo
          informativo: ir ahí sigue requiriendo que el hub complete y termine
          a mano — esto no cierra nada solo. Se puede descartar por completo
          o fila por fila (una vez atendida, no debe seguir apareciendo). */}
      {Array.isArray(myUnfinished) && myUnfinished.length > 0 && (
        <div className="de-unfinished-alert">
          <p className="de-unfinished-alert__title">
            {t('dataentry.unfinished_alert_title', { n: myUnfinished.length })}
          </p>
          <ul className="de-unfinished-alert__list">
            {myUnfinished.map((u) => {
              const isSpecial = SPECIAL_CATEGORY_ZONES.has(u.zone)
              const bk = bucketKeyFor(u.city, u.zone ?? null, Boolean(u.zone) && !isSpecial)
              return (
                <li key={`${u.city}|${u.zone || ''}|${u.observed_date}`}>
                  <span>
                    {formatCityZoneLabel(u.city, u.zone)} · {u.observed_date} · {u.n_rows}{' '}
                    {t('dataentry.unfinished_alert_rows')}
                  </span>
                  <button
                    type="button"
                    className="de-footer-goto"
                    onClick={() => {
                      if (irAFrente(bk)) setDate(u.observed_date)
                      setMyUnfinished((prev) => (prev || []).filter((x) => x !== u))
                    }}
                  >
                    {t('dataentry.unfinished_alert_goto')}
                  </button>
                </li>
              )
            })}
          </ul>
          <button type="button" className="de-footer-goto" onClick={() => setMyUnfinished(null)}>
            {t('dataentry.unfinished_alert_dismiss_all')}
          </button>
        </div>
      )}

      {pendingExtraFronts.length > 0 && (
        <div className="de-locked-district-banner">
          {t('dataentry.extra_fronts_pending', {
            list: pendingExtraFronts.map(frontLabel).join(', '),
          })}
        </div>
      )}

      {/* Trabajo sin guardar en frentes que NO son el que estás mirando.
          "Guardar progreso" nunca los tocó y nunca lo dijo — ver
          frentesPendientes.js para el incidente que lo motivó. */}
      {sessionActive && (
        <FrentesSinGuardar
          fronts={frentesAbiertos}
          llenoPorFrente={llenoPorFrente}
          editSeqRef={editSeqRef}
          savedSeqRef={savedSeqRef}
          bucketKey={bucketKey}
          onIrAFrente={irAFrente}
          t={t}
        />
      )}

      {/* ── Quién más está en ESTE bucket ahora mismo ──────────────────────
          Aeropuerto y TukTuk ya lo mostraban dentro de su propio selector;
          las demás vistas no tenían dónde. Con tres hubs midiendo Corp a la
          vez, no verse es el problema: los tres pueden terminar midiendo el
          mismo turno a la misma hora en vez de repartírselos.

          Dice quién y cuánto lleva, y NADA más. No bloquea, no avisa de
          conflicto y no sugiere que haya algo mal: los tres midiendo lo mismo
          es exactamente lo que se busca — más muestras de la misma ruta. */}
      {presenciaAqui.length > 0 && (
        <div className="de-presence-banner">
          👥{' '}
          {/* Solo el nombre. `get_active_sessions_presence` (mig 152) devuelve
              user_email, city, zone, scope_label y last_seen_at — el progreso
              NO está entre sus columnas, así que mostrar "40/162" acá exigiría
              tocar la RPC. Se deja para cuando haga falta de verdad: para
              repartirse los turnos alcanza con saber quién está. */}
          {t('dataentry.presence_here', {
            who: presenciaAqui.map((p) => nombreCorto(p.user_email)).join(' · '),
          })}
        </div>
      )}

      {/* ── Session bar ── */}
      <div className="de-session-bar">
        {/* Pestañas agrupadas por ciudad (Lima: Normal · Corp · ✈ · TukTuk) */}
        <div className="de-city-tabs">
          {cityClusters.map((cluster) => {
            const soloNormal = cluster.tabs.length === 1 && cluster.tabs[0].type === 'normal'
            const tabButtons = cluster.tabs.map((tb) => {
              const label =
                tb.type === 'normal'
                  ? soloNormal
                    ? cluster.base
                    : t('dataentry.tab_normal')
                  : tb.type === 'corp'
                    ? 'Corp'
                    : tb.type === 'airport'
                      ? `✈ ${t('dataentry.tab_airport')}`
                      : tb.type === 'delivery'
                        ? t('dataentry.tab_delivery')
                        : tb.type === 'cargo'
                          ? t('dataentry.tab_cargo')
                          : 'TukTuk'
              const active =
                tb.type === 'tuktuk'
                  ? isTukTuk && uiCity === tb.baseUiCity
                  : tb.type === 'airport'
                    ? !isTukTuk && tb.members.some((m) => m.uiCity === uiCity)
                    : tb.type === 'corp'
                      ? !isTukTuk && uiCity === 'Corp'
                      : tb.type === 'delivery'
                        ? !isTukTuk && activeSpecialCat === 'Delivery' && uiCity === tb.baseUiCity
                        : tb.type === 'cargo'
                          ? !isTukTuk && activeSpecialCat === 'Cargo' && uiCity === tb.baseUiCity
                          : !isTukTuk && !isSpecialCat && uiCity === tb.uiCity
              // Historia: hasta 2026-07-24 acá había un candado
              // (`scopeLockedElsewhere`) que, con un alcance "Ambos" a medias,
              // bloqueaba navegar a CUALQUIER otra pestaña. Existía porque
              // navegar afuera dejaba `pendingScopeMembers` apuntando a un
              // frente ajeno a la vista y la sesión no cerraba nunca.
              //
              // El candado se levantó por completo (pedido 2b): el hub salta a
              // donde necesite con la sesión abierta. Lo que cierra ese bug
              // ahora es el REGISTRO, no el bloqueo — todo frente donde el hub
              // escriba queda en `pendingExtraFronts` y "Terminar Sesión" no
              // cierra hasta que todos (declarados + extra) estén cerrados,
              // así que ninguno puede quedar abandonado en silencio.
              return (
                <button
                  key={`${cluster.base}-${tb.type}`}
                  className={`de-city-tab${tb.type === 'airport' ? ' de-city-tab--airport' : ''}${active ? ' active' : ''}`}
                  onClick={() => {
                    setMsg(null)
                    if (tb.type === 'tuktuk') {
                      // Re-click estando ya en TukTuk (en cualquier distrito, o
                      // en el estado "sin resolver") no debe resetear el
                      // distrito activo — mismo criterio que Aeropuerto.
                      if (!active) {
                        setUiCity(tb.baseUiCity)
                        setActiveTukTuk(firstEnabledTukTukDistrict(tukTukDistricts) ?? '')
                        setActiveSpecialCat(null)
                      }
                    } else if (tb.type === 'airport') {
                      if (!active) {
                        // Aterrizar en un punto DECLARADO si lo hay: volver
                        // al Aeropuerto desde otro frente caía siempre en
                        // members[0], que si el hub había declarado solo el
                        // Punto B estaba bloqueado por su propio candado.
                        setUiCity(
                          (
                            tb.members.find((m) =>
                              pendingScopeMembers.includes(bucketKeyOf(m.uiCity))
                            ) || tb.members[0]
                          ).uiCity
                        )
                        setActiveTukTuk(null)
                        setActiveSpecialCat(null)
                      }
                    } else if (tb.type === 'delivery' || tb.type === 'cargo') {
                      // Sin distrito que preservar (a diferencia de TukTuk): el
                      // click siempre fija la categoría, incluso re-clickeando.
                      setUiCity(tb.baseUiCity)
                      setActiveTukTuk(null)
                      setActiveSpecialCat(tb.type === 'delivery' ? 'Delivery' : 'Cargo')
                    } else {
                      setUiCity(tb.uiCity)
                      setActiveTukTuk(null)
                      setActiveSpecialCat(null)
                    }
                  }}
                >
                  {label}
                </button>
              )
            })
            // Ciudad simple sin ninguna variante (Corp/Aeropuerto/TukTuk) — ej.
            // países de una sola ciudad (Nepal, Bolivia) o cada ciudad de
            // Colombia: se muestra como una pestaña suelta, SIN el pill de
            // cluster alrededor, para no envolver un botón único en un
            // contenedor doble (antes de agrupar por ciudad no existía ese
            // envoltorio extra en estos casos).
            if (soloNormal) return tabButtons[0]
            return (
              <div key={cluster.base} className="de-city-cluster">
                <span className="de-cluster-name">{cluster.base}</span>
                {tabButtons}
              </div>
            )
          })}
        </div>

        {/* Sub-pestañas Punto A | Punto B cuando hay un aeropuerto activo. Con
            sesión activa y alcance declarado de un solo punto (`pendingScopeMembers`),
            el punto NO declarado queda bloqueado — mismo look que el candado
            de distrito de TukTuk — para que el hub se centre en lo que eligió
            (pedido: "el hub debe decidir y centrarse en eso"). Ampliable sin
            perder el cronómetro con "+ agregar" abajo. */}
        {activeAirportMembers && (
          <div className="de-airport-subtabs">
            {/* El candado de "punto no declarado" SOLO aplica dentro del
                cluster de Aeropuerto al que pertenece el alcance declarado.
                Bug real (hallado en browser-test 2026-07-24 al liberar la
                navegación): parado en el Aeropuerto de OTRA ciudad, ningún
                punto de ahí está en `pendingScopeMembers` (que tiene los de
                la ciudad declarada), así que se bloqueaban LOS DOS y el hub
                quedaba sin poder trabajar ninguno — con Punto A además
                mostrando candado pero funcionando, lo más confuso posible.
                Fuera del cluster declarado los puntos van libres: tocarlos
                los registra como frente extra, igual que Corp o Normal. */}
            {activeAirportMembers.map((m) => {
              const n = countAllFilled(entriesByCity[m.uiCity], indriveByCity[m.uiCity])
              const scopeOwnsThisCluster = activeAirportMembers.some((mm) =>
                pendingScopeMembers.includes(bucketKeyOf(mm.uiCity))
              )
              const locked =
                sessionActive &&
                scopeOwnsThisCluster &&
                !pendingScopeMembers.includes(bucketKeyOf(m.uiCity))
              const here = presenceFor(m.uiCity, null)
              return (
                <button
                  key={m.uiCity}
                  className={`de-airport-subtab${uiCity === m.uiCity ? ' active' : ''}${locked ? ' de-airport-subtab--locked' : ''}`}
                  aria-disabled={locked}
                  title={
                    locked
                      ? t('dataentry.scope_point_locked')
                      : here.length
                        ? t('dataentry.presence_here', {
                            who: here.map((p) => p.user_email).join(', '),
                          })
                        : undefined
                  }
                  onClick={() => {
                    if (locked) return
                    setUiCity(m.uiCity)
                    setActiveTukTuk(null)
                    setActiveSpecialCat(null)
                    setMsg(null)
                  }}
                >
                  {locked && (
                    <Lock size={11} className="de-airport-subtab-lock" aria-hidden="true" />
                  )}
                  Punto {m.side}
                  {n > 0 && <span className="de-airport-subtab-badge">{n}</span>}
                  {here.length > 0 && <span className="de-presence-dot" aria-hidden="true" />}
                </button>
              )
            })}
            {/* "+ agregar el otro punto" amplía el alcance DECLARADO, así que
                solo tiene sentido en el cluster dueño de ese alcance. Sin el
                `.some(...)` de pertenencia, parado en el Aeropuerto de otra
                ciudad este botón inyectaba los puntos de ESA ciudad dentro
                del alcance declarado de la ciudad original — mezclando dos
                clusters en `pendingScopeMembers` (bug hermano del candado de
                arriba, mismo browser-test). */}
            {sessionActive &&
              pendingScopeMembers.length === 1 &&
              activeAirportMembers.some((m) =>
                pendingScopeMembers.includes(bucketKeyOf(m.uiCity))
              ) &&
              activeAirportMembers.some(
                (m) => !pendingScopeMembers.includes(bucketKeyOf(m.uiCity))
              ) && (
                <button
                  type="button"
                  className="de-scope-expand"
                  onClick={() =>
                    setPendingScopeMembers((prev) => {
                      const missing = activeAirportMembers
                        .map((m) => m.uiCity)
                        .filter((c) => !prev.includes(c))
                      return missing.length ? [...prev, ...missing] : prev
                    })
                  }
                >
                  {t('dataentry.scope_expand')}
                </button>
              )}
          </div>
        )}

        {/* Sub-pestañas por distrito cuando TukTuk está activo */}
        {isTukTuk && (
          <div className="de-airport-subtabs de-tuktuk-subtabs">
            {tukTukDistricts.length === 0 ? (
              <span className="de-tuktuk-empty">{t('dataentry.tuktuk_no_districts')}</span>
            ) : (
              tukTukDistricts.map((d) => {
                const bk = `TT~${dbCity}~${d}`
                const n = countAllFilled(entriesByCity[bk], indriveByCity[bk])
                const enabled = isTukTukDistrictEnabled(d)
                const here = presenceFor(dbCity, d)
                return (
                  <button
                    key={d}
                    className={`de-airport-subtab${activeTukTuk === d ? ' active' : ''}${enabled ? '' : ' de-airport-subtab--locked'}`}
                    aria-disabled={!enabled}
                    title={
                      !enabled
                        ? t('dataentry.tuktuk_district_locked')
                        : here.length
                          ? t('dataentry.presence_here', {
                              who: here.map((p) => p.user_email).join(', '),
                            })
                          : undefined
                    }
                    onClick={() => {
                      if (!enabled) return
                      setActiveTukTuk(d)
                      setMsg(null)
                    }}
                  >
                    {!enabled && (
                      <Lock size={11} className="de-airport-subtab-lock" aria-hidden="true" />
                    )}
                    {d}
                    {n > 0 && <span className="de-airport-subtab-badge">{n}</span>}
                    {here.length > 0 && <span className="de-presence-dot" aria-hidden="true" />}
                  </button>
                )
              })
            )}
          </div>
        )}

        {/* Aviso proactivo si la vista activa es un distrito TukTuk
            bloqueado (llegado por Reanudar/Abrir Historial, que no pasan
            por el candado de la pill) — antes el hub solo se enteraba al
            tocar Guardar/Terminar, después de llenar toda la grilla. */}
        {isTukTuk && zone && !isTukTukDistrictEnabled(zone) && (
          <div className="de-locked-district-banner">
            {t('dataentry.tuktuk_district_locked_banner', { zone })}
          </div>
        )}

        <div className="de-session-controls">
          <label className="de-ctrl">
            <span>{t('dataentry.date')}</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>

          <div className="de-session-info">
            {/* Atajos: parecían botones y no hacían nada (feedback user
                2026-09-07). Ahora saltan a la cabecera de ese turno. */}
            {timeslots.map((ts) => (
              <button
                key={ts.label}
                type="button"
                className="de-ts-badge"
                title={t('dataentry.ts_jump_title', { ts: ts.label })}
                onClick={() => {
                  const el = document.getElementById(`de-turno-${ts.label}`)
                  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
                }}
              >
                {ts.label} ({ts.start_time?.slice(0, 5)}–{ts.end_time?.slice(0, 5)})
              </button>
            ))}
          </div>

          {/* Sin sesión ni trabajo, "0 / 0 campos" no dice nada: mostrar
              qué viene (rutas × turnos) hasta que haya algo que contar. */}
          {!sessionActive && filledCount === 0 ? (
            routeOrder.length > 0 && (
              <div className="de-progress-pill de-progress-pill--idle">
                {t('dataentry.grid_summary', { r: routeOrder.length, n: timeslots.length })}
              </div>
            )
          ) : (
            <div className="de-progress-pill">
              <span className="de-progress-filled">{filledCount}</span>
              <span className="de-progress-sep">/</span>
              <span className="de-progress-total">{totalExpected}</span>
              <span className="de-progress-label">{t('dataentry.fields')}</span>
            </div>
          )}

          {/* Indicadores "guardado/confirmado hace Xs" — su ticker de 1s vive
              adentro, aislado de la grilla. Reusa el mismo umbral de 3 min
              (LIVE_STALE_MS) que Monitoreo del lado del admin. */}
          <SaveStatusIndicators
            sessionActive={sessionActive}
            lastDraftSavedAt={lastDraftSavedAt}
            lastSaveOkAt={lastSaveOkAt}
            lastHeartbeatOkAt={lastHeartbeatOkAt}
            // Otra pestaña del mismo hub tiene el lease del latido: esta nunca
            // va a recibir un `lastHeartbeatOkAt`, y sin avisarlo el cartel
            // diría "sin contacto con el servidor" con la conexión perfecta.
            latidoDelegado={!hbLeaseOwner}
            filledCount={filledCount}
            savableCount={savableCount}
            bucketKey={bucketKey}
            editSeqRef={editSeqRef}
            savedSeqRef={savedSeqRef}
            t={t}
          />
        </div>
      </div>

      {/* ── Status message ── */}
      {msg && (
        <div
          className={`de-msg${msg.type === 'ok' ? ' de-msg--ok' : ' de-msg--err'}${msg.emphasize ? ' de-msg--emphasize' : ''}`}
        >
          {msg.emphasize && <CheckCircle2 className="de-msg__icon" size={20} />}
          {msg.text}
        </div>
      )}

      {/* Pestaña duplicada (P1-10). Banner PERMANENTE y arriba de todo: el
          hub tiene que enterarse ANTES de teclear, no después de perder
          trabajo. La grilla queda visible y editable a propósito (CLAUDE.md
          §5): es una vista legítima, solo que no escribe. */}
      {!leaseOwner && (
        <div className="de-msg de-msg--warn de-msg--emphasize">
          <AlertTriangle className="de-msg__icon" size={20} />
          <span>
            <strong>{t('dataentry.lease_readonly_title')}</strong>{' '}
            {t('dataentry.lease_readonly_body')}
          </span>
          <button
            type="button"
            className="de-msg__action"
            onClick={() => {
              claimDraftLease()
              setMsg(null)
            }}
          >
            {t('dataentry.lease_readonly_take')}
          </button>
        </div>
      )}

      {/* Fallo de almacenamiento del navegador (durabilidad R5). Persistente
          y destacado: es la única situación donde el hub DEBE actuar ya, y
          antes no se enteraba de nada. */}
      {storageFailed && (
        <div className="de-msg de-msg--err de-msg--emphasize">
          <AlertTriangle className="de-msg__icon" size={20} />
          {t('dataentry.storage_failed')}
        </div>
      )}

      {/* Aviso temprano (pedido user 2026-09-07): la MISMA señal que dispara
          el conflicto al guardar (mig 191) ya está disponible al restaurar el
          borrador — mostrarla ACÁ, antes de que el hub tipee, en vez de
          esperar a que el guardado rebote. No bloquea nada: se puede
          descartar, y si el hub guarda igual el conflicto real (si sigue
          vigente) aparece abajo con sus dos salidas. */}
      {earlyConflictHint?.bucketKey === bucketKey && !saveConflict && (
        <div className="de-msg de-msg--err">
          {t('dataentry.early_conflict_hint', {
            when: new Date(earlyConflictHint.at).toLocaleString(),
          })}
          <button
            type="button"
            className="de-footer-goto"
            onClick={() => setEarlyConflictHint(null)}
          >
            {t('dataentry.early_conflict_dismiss')}
          </button>
        </div>
      )}

      {/* Recuperación de conflicto (mig 191). Sin estas dos salidas el hub
          queda trabado: el servidor le frena el guardado y no tiene forma de
          seguir. Las dos son EXPLÍCITAS y dicen qué descartan — ninguna
          resuelve el conflicto en silencio. */}
      {saveConflict && (
        <div className="de-conflict" ref={conflictRef}>
          <p className="de-conflict__body">{t('dataentry.conflict_body')}</p>
          <div className="de-conflict__actions">
            <button
              type="button"
              onClick={() => {
                // ANTES de reemplazar, se respalda el borrador actual
                // (durabilidad R4). Esta rama hace un reemplazo TOTAL —
                // `conservarTecleado` solo aplica al auto-load silencioso —
                // y con él se iban las celdas de filas INCOMPLETAS, que no
                // están en el servidor por definición: eran una pérdida
                // permanente y sin aviso. El respaldo le da al hub una
                // segunda chance si eligió mal.
                try {
                  const actual = localStorage.getItem(draftKey)
                  if (actual) localStorage.setItem(`de:respaldo:${draftKey}`, actual)
                } catch {
                  setStorageFailed(true)
                }
                setSaveConflict(null)
                setPendingLoad({ dbCity, zone, date })
              }}
            >
              {t('dataentry.conflict_reload')}
            </button>
            <button
              type="button"
              className="de-conflict__force"
              onClick={async () => {
                if (!window.confirm(t('dataentry.conflict_force_confirm'))) return
                const wasFinish = saveConflict.isFinish
                setSaveConflict(null)
                // Se rehace la recolección de filas por el mismo camino que el
                // botón original, para no duplicar criterios de qué se manda.
                if (wasFinish) await handleFinishSession(true)
                else await handleSaveProgress(true)
              }}
            >
              {t('dataentry.conflict_force')}
            </button>
          </div>
        </div>
      )}

      {/* ── Borradores sin terminar (otras ciudades/fechas) + tope ── */}
      {otherDrafts.length > 0 && (
        <div className={`de-drafts-bar${atDraftCap ? ' de-drafts-bar--cap' : ''}`}>
          <div className="de-drafts-bar-head">
            {atDraftCap
              ? `⚠ ${t('dataentry.draft_cap_title', { max: MAX_DRAFTS })}`
              : t('dataentry.drafts_pending', { n: otherDrafts.length })}
          </div>
          <div className="de-draft-list">
            {otherDrafts.map((d) => (
              <div key={d.key} className="de-draft-item">
                <span className="de-draft-item-label">
                  📝 {d.city} · {d.date} · {t('dataentry.draft_cells', { n: d.count })}
                </span>
                <span className="de-draft-item-actions">
                  <Button size="sm" onClick={() => resumeDraft(d)}>
                    {t('dataentry.other_draft_jump')}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => discardDraft(d)}>
                    {t('dataentry.other_draft_discard')}
                  </Button>
                </span>
              </div>
            ))}
          </div>
          {atDraftCap && <div className="de-drafts-bar-msg">{t('dataentry.draft_cap_msg')}</div>}
        </div>
      )}

      {/* ── Categorías sin ninguna ruta configurada en esta ciudad ── */}
      {!refsLoading && categoriesWithNoRoutes.length > 0 && (
        <div className="de-cat-empty de-cat-empty--global">
          {t('dataentry.no_routes')}{' '}
          <strong>
            {uiCity} · {categoriesWithNoRoutes.join(', ')}
          </strong>
          . {t('dataentry.go_distances')}
        </div>
      )}

      {/* ── Grilla ── */}
      {blockNewSlot ? (
        <div className="de-draft-cap-block">
          {t('dataentry.draft_cap_block', { max: MAX_DRAFTS })}
        </div>
      ) : refsLoading ? (
        <div className="de-loading">{t('dataentry.loading_routes')}</div>
      ) : refsByBracket.length === 0 ? (
        <div className="de-loading">{t('dataentry.no_routes_at_all')}</div>
      ) : (
        <>
          {commonOrigin && (
            <div className="de-common-origin">
              <span className="de-common-origin__label">{t('dataentry.common_origin')}</span>
              <strong>{commonOrigin}</strong>
              <span className="de-common-origin__hint">{t('dataentry.common_origin_hint')}</span>
            </div>
          )}
          <div className="de-grid" onKeyDown={handleGridKeyDown}>
            {timeslots.map((ts) => {
              // Progreso por bracket dentro de ESTE turno (minimapa + banda).
              const bracketProgress = refsByBracket.map(({ bracket, groups, extras }) => {
                const items = [
                  ...groups.map((g) => groupStatus(g, ts)),
                  ...extras.map((e) => rowState(e.uiCat, e.ref, ts)),
                ]
                return {
                  bracket,
                  id: `de-band-${ts.label}-${bracket}`,
                  label: BRACKET_LABELS[bracket] || bracket,
                  short: BRACKET_SHORT[bracket] || bracket,
                  color: BRACKET_COLORS[bracket],
                  done: items.filter((x) => x === 'full').length,
                  total: items.length,
                }
              })
              return (
                <TurnoSection
                  key={ts.label}
                  id={`de-turno-${ts.label}`}
                  timeslot={ts}
                  filled={filledByTimeslot[ts.label] || 0}
                  total={totalExpectedPerTimeslot}
                  hasErrors={!!errorsByTimeslot[ts.label]}
                  brackets={bracketProgress}
                >
                  {refsByBracket.map(({ bracket, groups, extras }, bi) => {
                    const prog = bracketProgress[bi]
                    const kms = [
                      ...groups.map((g) => g.anchorRef.waze_distance),
                      ...extras.map((e) => e.ref.waze_distance),
                    ].filter((k) => k != null)
                    const kmRange =
                      kms.length === 0
                        ? null
                        : Math.min(...kms) === Math.max(...kms)
                          ? `${Math.min(...kms)} km`
                          : `${Math.min(...kms)}–${Math.max(...kms)} km`
                    return (
                      <div
                        key={bracket}
                        id={prog.id}
                        className={`de-bracket-section${prog.total > 0 && prog.done >= prog.total ? ' de-bracket-section--done' : ''}`}
                        style={{ '--bracket-color': prog.color }}
                      >
                        <div className="de-bracket-band">
                          <span className="de-bracket-band__dot" aria-hidden="true" />
                          <span className="de-bracket-band__label">{prog.label}</span>
                          {kmRange && <span className="de-bracket-band__km">{kmRange}</span>}
                          <span className="de-bracket-band__progress">
                            {prog.done >= prog.total && prog.total > 0 ? '✓ ' : ''}
                            {prog.done}/{prog.total} {t('dataentry.band_routes')}
                          </span>
                        </div>
                        {groups.map((group, gi) => (
                          <BracketRouteGroup
                            key={`${bracket}-${gi}`}
                            bracket={bracket}
                            group={group}
                            status={groupStatus(group, ts)}
                            routeIndex={routeOrder.indexOf(group.anchorRef.id) + 1}
                            routeTotal={routeOrder.length}
                            bracketColor={prog.color}
                            hideOrigin={!!commonOrigin}
                            categories={categories}
                            timeslot={ts}
                            uiCity={uiCity}
                            country={country}
                            dbConfigs={dbConfigs}
                            catColors={CAT_COLORS}
                            getEntry={getEntry}
                            setEntry={setEntry}
                            getEta={getEta}
                            setEta={setEta}
                            getDisc={getDisc}
                            setDisc={setDisc}
                            indriveExtra={indriveExtra}
                            setIndrive={setIndrive}
                            indKey={indKey}
                            priceKey={priceKey}
                            errorKeys={errorKeys}
                            rowState={rowState}
                            getNa={getNa}
                            toggleNa={toggleNa}
                            markRowNa={markRowNa}
                            t={t}
                          />
                        ))}
                        {extras.length > 0 && (
                          <div className="de-bracket-extras">
                            {/* El título "Rutas adicionales" solo tiene sentido cuando hay
                          además rutas principales (groups). Si TODO el bracket son
                          extras (ej. ciudad Corp, o solo-TukTuk), no hay "adicionales"
                          respecto de nada → se omite el título. */}
                            {groups.length > 0 && (
                              <div className="de-bracket-extras-title">
                                {t('dataentry.extra_routes_title')}
                              </div>
                            )}
                            {extras.map(({ uiCat, ref }) => (
                              <BracketRouteGroup
                                key={`${bracket}-extra-${ref.id}`}
                                bracket={bracket}
                                group={{ anchorRef: ref, byCategory: { [uiCat]: ref } }}
                                status={rowState(uiCat, ref, ts)}
                                bracketColor={prog.color}
                                hideOrigin={!!commonOrigin}
                                categories={[uiCat]}
                                timeslot={ts}
                                uiCity={uiCity}
                                country={country}
                                dbConfigs={dbConfigs}
                                catColors={CAT_COLORS}
                                getEntry={getEntry}
                                setEntry={setEntry}
                                getEta={getEta}
                                setEta={setEta}
                                getDisc={getDisc}
                                setDisc={setDisc}
                                indriveExtra={indriveExtra}
                                setIndrive={setIndrive}
                                indKey={indKey}
                                priceKey={priceKey}
                                errorKeys={errorKeys}
                                rowState={rowState}
                                getNa={getNa}
                                toggleNa={toggleNa}
                                markRowNa={markRowNa}
                                t={t}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </TurnoSection>
              )
            })}
          </div>
        </>
      )}
      {/* Footer repeat buttons */}
      {!blockNewSlot && !refsLoading && refs.length > 0 && (
        <div className="de-footer">
          {sessionActive && pendingScopeMembers.length > 1 && (
            <div className="de-footer-hint">{t('dataentry.finish_reminder_ambos')}</div>
          )}
          {sessionActive ? (
            <>
              <Button
                onClick={handleSaveProgress}
                disabled={saving || guardandoTodo}
                title={t('dataentry.save_progress_hint', { front: frontLabel(bucketKey) })}
              >
                {saving
                  ? t('dataentry.saving')
                  : `${t('dataentry.save_progress_front', {
                      front: frontLabel(bucketKey),
                    })}${savableCount > 0 ? ` (${savableCount})` : ''}`}
              </Button>
              {hayOtrosFrentes && (
                <Button
                  className="bg-slate-700 hover:bg-slate-800"
                  onClick={handleGuardarTodo}
                  disabled={saving || guardandoTodo}
                  title={t('dataentry.save_all_hint')}
                >
                  {guardandoTodo ? t('dataentry.save_all_running') : t('dataentry.save_all')}
                </Button>
              )}
              <Button
                className="bg-green-800 hover:bg-green-900"
                onClick={handleFinishSession}
                disabled={saving || guardandoTodo}
              >
                {pendingScopeMembers.length > 1 || pendingExtraFronts.length > 0
                  ? t('dataentry.end_session_point')
                  : t('dataentry.end_session')}
              </Button>
            </>
          ) : (
            <Button
              className="bg-green-600 shadow-[0_2px_6px_rgba(22,163,74,0.3)] hover:bg-green-700"
              onClick={() => resolvedStartMembers && handleStartSession(resolvedStartMembers)}
              disabled={saving || !resolvedStartMembers}
              title={!resolvedStartMembers ? t('dataentry.scope_pick_first') : undefined}
            >
              {t('dataentry.start_session')}
            </Button>
          )}
          {msg && (
            <span className={msg.type === 'ok' ? 'de-footer-ok' : 'de-footer-err'}>
              {msg.text}
              {saveConflict && (
                <button type="button" className="de-footer-goto" onClick={irAlConflicto}>
                  {t('dataentry.conflict_goto')}
                </button>
              )}
            </span>
          )}
        </div>
      )}

      {/* ── Ver lo guardado (pedido 8) ── */}
      <div className="de-session-history">
        <button className="de-history-toggle" onClick={() => setShowSavedData((p) => !p)}>
          {showSavedData ? '▲' : '▼'}{' '}
          {savedCount != null
            ? t('dataentry.view_saved_data_count', { n: savedCount })
            : t('dataentry.view_saved_data')}
        </button>
        {showSavedData && (
          <div className="de-history-body">
            {savedLoading ? (
              <div style={{ fontSize: 12, color: 'var(--color-muted)', padding: '12px 0' }}>
                {t('dataentry.loading_routes')}
              </div>
            ) : savedRows.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--color-muted)', padding: '12px 0' }}>
                {t('dataentry.view_saved_data_empty')}
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="de-history-table">
                  <thead>
                    <tr>
                      <th>{t('dataentry.col_timeslot')}</th>
                      <th>{t('dataentry.col_category')}</th>
                      <th>{t('dataentry.col_competitor')}</th>
                      <th>{t('dataentry.col_price')}</th>
                      <th>{t('dataentry.col_time')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {savedRows.map((r, i) => (
                      <tr key={i}>
                        <td>{dbTimeslotToLabel[r.timeslot] || r.timeslot || '—'}</td>
                        <td>{r.category}</td>
                        <td>{r.competition_name}</td>
                        <td>
                          <strong>
                            {r.price_without_discount != null
                              ? `S/ ${Number(r.price_without_discount).toFixed(2)}`
                              : '—'}
                          </strong>
                          {r.price_with_discount != null && (
                            <span style={{ color: 'var(--color-muted)', fontSize: 11 }}>
                              {' '}
                              (c/desc S/ {Number(r.price_with_discount).toFixed(2)})
                            </span>
                          )}
                        </td>
                        <td>{(r.observed_time || '').slice(0, 5) || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Session History ── */}
      <div className="de-session-history">
        <button className="de-history-toggle" onClick={() => setShowHistory((p) => !p)}>
          {showHistory ? '▲' : '▼'} {t('dataentry.session_history')}
        </button>

        {showHistory && (
          <div className="de-history-body">
            {/* Filters */}
            <div className="de-history-filters">
              <label className="de-ctrl">
                <span>{t('filter.from')}</span>
                <input type="date" value={histFrom} onChange={(e) => setHistFrom(e.target.value)} />
              </label>
              <label className="de-ctrl">
                <span>{t('filter.to')}</span>
                <input type="date" value={histTo} onChange={(e) => setHistTo(e.target.value)} />
              </label>
              <label className="de-ctrl">
                <span>{t('dataentry.col_city')}</span>
                <select value={histCity} onChange={(e) => setHistCity(e.target.value)}>
                  <option value="">{t('dataentry.all_cities')}</option>
                  {countryConfig.dbCities.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
              <label className="de-ctrl">
                <span>{t('dataentry.col_user')}</span>
                <input
                  type="text"
                  placeholder="@email"
                  value={histEmail}
                  onChange={(e) => setHistEmail(e.target.value)}
                  style={{ width: 160 }}
                />
              </label>
              <Button size="sm" onClick={loadSessionHistory} disabled={histLoading}>
                {histLoading ? t('dataentry.searching') : t('dataentry.search')}
              </Button>
            </div>

            {/* Table */}
            {histLoading ? (
              <div className="de-loading" style={{ padding: '12px 0' }}>
                {t('dataentry.loading_history')}
              </div>
            ) : sessionHistory.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--color-muted)', padding: '12px 0' }}>
                {t('dataentry.no_sessions')}
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="de-history-table">
                  <thead>
                    <tr>
                      <th>{t('dataentry.col_date')}</th>
                      <th>{t('dataentry.col_city')}</th>
                      <th>{t('dataentry.col_user')}</th>
                      <th>{t('dataentry.col_start')}</th>
                      <th>{t('dataentry.col_end')}</th>
                      <th>{t('dataentry.col_duration')}</th>
                      <th>{t('dataentry.col_obs')}</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessionHistory.map((s) => {
                      const start = new Date(s.started_at)
                      const end = new Date(s.ended_at)
                      const revision = revisionInfoByHistoryId[s.id]
                      return (
                        <tr key={s.id}>
                          <td>{start.toLocaleDateString(locale)}</td>
                          <td>
                            {s.city}
                            {s.zone ? ` · ${s.zone}` : ''}
                            {revision && (
                              <div className="de-history-note">
                                {t('dataentry.session_revised', {
                                  // revision.count es el TOTAL de filas del grupo (original +
                                  // reaperturas) — la sesión original no es una "edición", así
                                  // que el texto muestra solo las reaperturas posteriores.
                                  n: revision.count - 1,
                                  who: revision.lastEditor || '—',
                                })}
                              </div>
                            )}
                            {s.closed_by && (
                              <div className="de-history-note">
                                {t('dataentry.session_closed_by_admin', { who: s.closed_by })}
                              </div>
                            )}
                          </td>
                          <td style={{ color: 'var(--color-muted)', fontSize: 11 }}>
                            {s.user_email || '—'}
                          </td>
                          <td>
                            {start.toLocaleTimeString(locale, {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </td>
                          <td>
                            {end.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}
                          </td>
                          <td>
                            {/* null = no se pudo medir (ver sessionDuration.js).
                                Se muestra el mismo "—" que ya usan las otras
                                columnas para un dato ausente, nunca un "0 min"
                                que se leería como "tardó nada". */}
                            <strong>
                              {s.duration_minutes == null ? '—' : `${s.duration_minutes} min`}
                            </strong>
                            {s.turno_timings && typeof s.turno_timings === 'object' && (
                              <div className="de-history-note">
                                {turnoBreakdownLabel(s.turno_timings)}
                              </div>
                            )}
                          </td>
                          <td>{s.rows_saved}</td>
                          <td>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => openHistorySession(s)}
                              disabled={saving}
                              title={t('dataentry.open_session_title')}
                            >
                              {t('dataentry.open_session')}
                            </Button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
