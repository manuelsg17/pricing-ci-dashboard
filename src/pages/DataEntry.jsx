import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { sb, SESSION_ID } from '../lib/supabase'
import { debeReanudarTramo } from '../lib/sessionPersistence'
import { duracionDeSesion } from '../lib/sessionDuration'
import { distanceRefsQueryKey, fetchDistanceRefs } from '../hooks/useDistanceRefs'
import { useAuth } from '../lib/auth'
import { getCiCompetitors, resolveDbParams, timeslotLabel } from '../lib/constants'
import { buildFronts, frontLabel } from '../lib/sessionFronts'
import { normalizeCompetitorName } from '../lib/normalize'
import { getSourceCategory } from '../lib/distanceRefsReplication'
import { buildRefsByBracket } from '../lib/bracketGrouping'
import { capIndriveExtraBids } from '../lib/indriveAvg'
import { getISOYearWeek } from '../lib/dateUtils'
import { turnoBreakdownLabel } from '../lib/timing'
import { useRushHourConfig } from '../hooks/useRushHourConfig'
import { useCITimeslots } from '../hooks/useCITimeslots'
import { isTukTukDistrictEnabled, firstEnabledTukTukDistrict } from '../lib/tuktukDistricts'
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
  return new Date().toISOString().slice(0, 10)
}

// Cuenta solo celdas con un valor numérico real — una celda tipeada y
// después borrada de nuevo (queda como '' en `entries`) NO cuenta como
// "dato sin guardar". Usado tanto para el borrador local propio como para
// leer borradores de OTRAS ciudades/fechas en localStorage, así una fila
// "fantasma" (vacía pero con claves) nunca gana contra un borrador real.
function countFilledEntries(entries) {
  return Object.values(entries || {}).filter((v) => v !== '' && !isNaN(parseFloat(v))).length
}

function hasMeaningfulIndriveExtra(indriveExtra) {
  return Object.values(indriveExtra || {}).some(
    (extra) =>
      (extra?.bids || []).some((b) => b !== '') ||
      (extra?.minBid || '') !== '' ||
      (extra?.rec || '') !== ''
  )
}

// Cuenta TODAS las celdas "llenas": las que tienen número en `entries` + las
// celdas InDrive que solo tienen precio recomendado (viven en indriveExtra, no
// en entries, porque sin bids el promedio queda vacío). Fuente ÚNICA de verdad
// para el pill de progreso y para el conteo del borrador restaurado — así no
// vuelven a divergir (la divergencia causó una pérdida silenciosa del
// recomendado al restaurar un borrador rec-only).
function countAllFilled(entries, indriveExtra) {
  let n = countFilledEntries(entries)
  for (const [k, ex] of Object.entries(indriveExtra || {})) {
    const recOk = ex?.rec != null && ex.rec !== '' && !isNaN(parseFloat(ex.rec))
    if (!recOk) continue
    const avg = (entries || {})[`${k}|InDrive`]
    const avgOk = avg != null && avg !== '' && !isNaN(parseFloat(avg))
    if (!avgOk) n++ // recomendado sin promedio de bids → no contado por entries
  }
  return n
}

// Timestamp (epoch ms) del `startedAt` más antiguo entre los turnos ya
// estampados, o null si no hay ninguno. Usado para sembrar el cronómetro de
// SESIÓN (sessionStartRef) al retomar trabajo que ya venía en curso — mismo
// criterio que ya usa `turnoTimings` por turno, para no falsificar el tiempo
// real con un "ahora" cada vez que se recarga la página o se reanuda un
// borrador (bug real 2026-07-24: sesiones de horas quedaban registradas como
// "1 minuto" al reanudar).
function earliestTurnoStart(timings) {
  if (!timings || typeof timings !== 'object') return null
  let min = null
  for (const t of Object.values(timings)) {
    const raw = t?.startedAt
    if (!raw) continue
    const ms = new Date(raw).getTime()
    if (!Number.isFinite(ms)) continue
    if (min === null || ms < min) min = ms
  }
  return min
}

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

  const markTouched = useCallback((bucket) => {
    if (!bucket) return
    editSeqRef.current[bucket] = (editSeqRef.current[bucket] ?? 0) + 1
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
    return d.toISOString().slice(0, 10)
  })
  const [histTo, setHistTo] = useState(() => new Date().toISOString().slice(0, 10))
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
    return (countryConfig.categoriesByCity[uiCity] || []).filter((c) => c !== 'TukTuk')
  }, [countryConfig, uiCity, activeTukTuk])

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
  const zone = isTukTuk ? activeTukTuk || null : null
  const bucketKey = isTukTuk ? `TT~${dbCity}~${zone}` : dbCity
  const viewId = isTukTuk ? `TT~${dbCity}~${zone}` : uiCity

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
  const bucketFinishedLsKey = (bk, d) => `de:finished:${userEmail}:${bk}:${d}`

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
  const cityClusters = useMemo(() => {
    const CORP_UNDER = { Corp: 'Lima' } // Perú: Corp = corporativo de Lima
    const clusters = []
    const byBase = {}
    const ensure = (base) => {
      if (!byBase[base]) {
        byBase[base] = { base, tabs: [] }
        clusters.push(byBase[base])
      }
      return byBase[base]
    }
    for (const c of uiCities) {
      const am = /^(.+)_Airport_([AB])$/.exec(c)
      if (am) {
        const base = am[1]
        const cl = ensure(base)
        let ap = cl.tabs.find((tb) => tb.type === 'airport')
        if (!ap) {
          ap = { type: 'airport', base, members: [] }
          cl.tabs.push(ap)
        }
        ap.members.push({ uiCity: c, side: am[2] })
        continue
      }
      if (c === 'Corp') {
        // Solo redirige bajo la ciudad mapeada si esa ciudad REALMENTE existe
        // en este país — si no (país hipotético con 'Corp' pero sin 'Lima'),
        // Corp queda como su propio cluster en vez de crear un cluster
        // "Lima" fantasma con un único tab Corp adentro.
        const target = CORP_UNDER[c] && uiCities.includes(CORP_UNDER[c]) ? CORP_UNDER[c] : c
        ensure(target).tabs.push({ type: 'corp', uiCity: c })
        continue
      }
      ensure(c).tabs.push({ type: 'normal', uiCity: c })
      if ((countryConfig.categoriesByCity[c] || []).includes('TukTuk')) {
        ensure(c).tabs.push({ type: 'tuktuk', baseUiCity: c })
      }
    }
    for (const cl of clusters)
      for (const tb of cl.tabs)
        if (tb.type === 'airport') tb.members.sort((a, b) => a.side.localeCompare(b.side))
    const order = { normal: 0, corp: 1, airport: 2, tuktuk: 3 }
    for (const cl of clusters) cl.tabs.sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9))
    return clusters
  }, [uiCities, countryConfig])

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
      ? activeAirportMembers.map((m) => m.uiCity)
      : scopeChoice
        ? [scopeChoice]
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
    // dbCity es reactivo a uiCity y categories, así no hay problema
  }, [country, countryConfig])

  // El cronómetro (⏱) vive en <SessionTimer> con su propio interval, para que
  // su tick por segundo no re-renderice toda la grilla. Ver SessionLiveStatus.

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
      sb.from('ci_active_sessions')
        .delete()
        .eq('user_email', userEmail)
        .then(
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

  // ── "Ver lo guardado" — lo que YA quedó persistido para la vista/fecha
  // actual, filtrado a lo que cargó ESTE hub (uploaded_by). Consulta directa
  // (RLS ya permite SELECT sin restricción de ciudad, no hace falta RPC) —
  // así el hub puede comparar contra lo que ve en pantalla y avisar si algo
  // no cuadra, sin exponer el trabajo de otros hubs.
  async function loadSavedData(isCancelled) {
    if (!userEmail || !dbCity) return
    setSavedLoading(true)
    let q = sb
      .from('pricing_observations')
      .select(
        'category, competition_name, price_without_discount, price_with_discount, observed_time, timeslot'
      )
      .eq('country', country)
      .eq('city', dbCity)
      .eq('observed_date', date)
      .eq('uploaded_by', userEmail)
      .eq('data_source', 'manual')
    q = zone != null ? q.eq('zone', zone) : q.is('zone', null)
    const { data } = await q.order('timeslot').order('category').order('competition_name')
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
      let q = sb
        .from('pricing_observations')
        .select('id', { count: 'exact', head: true })
        .eq('country', country)
        .eq('city', dbCity)
        .eq('observed_date', date)
        .eq('uploaded_by', userEmail)
        .eq('data_source', 'manual')
      q = zone != null ? q.eq('zone', zone) : q.is('zone', null)
      const { count } = await q
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
    let q = sb
      .from('ci_sessions')
      .select('*')
      .eq('country', country)
      .order('started_at', { ascending: false })
      .limit(200)
    if (histFrom) q = q.gte('observed_date', histFrom)
    if (histTo) q = q.lte('observed_date', histTo)
    if (histCity) q = q.eq('city', histCity)
    if (histEmail) q = q.ilike('user_email', `%${histEmail}%`)
    const { data } = await q
    setSessionHistory(data || [])
    setHistLoading(false)
  }

  // Rastro de ediciones (pedido 7): `ci_sessions` inserta una fila NUEVA en
  // cada Finalizar — nunca sobrescribe — así que reabrir y re-finalizar YA
  // deja rastro crudo (2+ filas para la misma ciudad/zona/fecha). Acá solo
  // se agrega el resumen "editado N veces, último por X" sobre la fila más
  // reciente de cada grupo — sin columnas nuevas, puro cálculo en memoria.
  const revisionInfoByHistoryId = useMemo(() => {
    const groups = {}
    for (const s of sessionHistory) {
      const key = `${s.city}|${s.zone || ''}|${s.observed_date}`
      ;(groups[key] ||= []).push(s)
    }
    const m = {}
    for (const list of Object.values(groups)) {
      if (list.length < 2) continue
      const latest = [...list].sort((a, b) => new Date(b.started_at) - new Date(a.started_at))[0]
      m[latest.id] = { count: list.length, lastEditor: latest.user_email }
    }
    return m
  }, [sessionHistory])

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
        sb.from('ci_active_sessions')
          .delete()
          .eq('user_email', userEmailRef.current)
          .then(
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

  useEffect(() => {
    if (!tukTukInfo) {
      setTukTukDistricts([])
      return
    }
    let cancelled = false
    sb.from('distance_references')
      .select('zone')
      .eq('country', country)
      .eq('city', tukTukInfo.dbCity)
      .eq('category', 'TukTuk')
      .not('zone', 'is', null)
      .then(({ data }) => {
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
  const draftKey = `de:draft:${userEmail}:${country}:${viewId}:${date}`
  const legacyDraftKey = `de:draft:${country}:${viewId}:${date}`
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
  const syncSeqKeyFor = useCallback((c, city, z, d) => `de:seq:${c}|${city}|${z ?? ''}|${d}`, [])
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
      const { data, error } = await sb
        .from('ci_bucket_writes')
        .select('write_seq, last_write_at')
        .eq('user_email', userEmail)
        .eq('country', country)
        .eq('city', city)
        .eq('zone_key', z ?? '')
        .eq('observed_date', d)
        .maybeSingle()

      // Sin fila en el servidor no hay con qué conflictuar: nada que hacer.
      if (error || !data) return

      const escrituraServidor = new Date(data.last_write_at).getTime()
      // Solo se adopta si ESTE cliente es estrictamente más nuevo. Si el
      // servidor escribió después de nuestro último borrador, hubo otra
      // pantalla de verdad y el conflicto tiene que aparecer.
      if (savedAt != null && Number.isFinite(escrituraServidor) && escrituraServidor <= savedAt) {
        writeSyncSeqFor(country, city, z, d, Number(data.write_seq))
      }
    },
    [userEmail, country, writeSyncSeqFor]
  )

  // Conflicto detectado por el servidor: { at, isFinish } o null.
  const [saveConflict, setSaveConflict] = useState(null)

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

  const [lastSaveOkAt, setLastSaveOkAt] = useState(null) // guardado REAL
  const [lastHeartbeatOkAt, setLastHeartbeatOkAt] = useState(null) // solo conexión

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
          sb.from('ci_active_sessions')
            .delete()
            .eq('user_email', userEmail)
            .then(
              () => {},
              () => {}
            )
        }
      }
    }
    // Hidratar esta ciudad UNA vez por contexto. Al intercalar A↔B, la 2da vez
    // ya está en el set → no se re-hidrata (la memoria, más nueva, manda).
    if (!hydratedCitiesRef.current.has(targetCity)) {
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
              // el efecto de hidratación de arriba.
              pendingScopeMembers,
              // Frentes extra (Aeropuerto↔TukTuk simultáneo, punto 2) —
              // mismo motivo que pendingScopeMembers: sobrevivir un refresh
              // a mitad de trabajo sin perder el aviso de "todavía falta".
              pendingExtraFronts,
              turnoTimings,
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
    }
    window.addEventListener('pagehide', onPageHide)
    // `visibilitychange` cubre el caso de cerrar la tapa de la laptop o pasar
    // la app a segundo plano en un celular, donde `pagehide` puede no llegar.
    const onHidden = () => {
      if (document.visibilityState === 'hidden') onPageHide()
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
    } catch {}
  }, [draftKey])

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
    const prefix = `de:draft:${userEmail}:${country}:`
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
        let cityLabel, bucketKeyD, resume
        if (viewIdTok.startsWith('TT~')) {
          const partsTT = viewIdTok.split('~')
          const dc = partsTT[1] || ''
          const zn = partsTT.slice(2).join('~')
          bucketKeyD = viewIdTok
          cityLabel = `${dc} TukTuk · ${zn}`
          resume = { tukTuk: true, uiCity: tukTukInfo?.baseUiCity || dc, zone: zn }
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
    } else {
      setUiCity(d.resume?.uiCity ?? d.city)
      setActiveTukTuk(null)
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
    const discardedUi = d.resume?.uiCity ?? d.city
    setPendingScopeMembers((prev) =>
      prev.includes(discardedUi) ? prev.filter((m) => m !== discardedUi) : prev
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

  // Categorías sin ninguna ruta en toda la ciudad (no solo en un bracket
  // puntual) — se avisa una sola vez arriba de la grilla.
  const categoriesWithNoRoutes = useMemo(
    () => categories.filter((uiCat) => (refsByUICat[uiCat] || []).length === 0),
    [categories, refsByUICat]
  )

  // ── Entry helpers ──────────────────────────────────────
  const priceKey = (uiCat, refId, tsLabel, comp) => `${uiCat}|${refId}|${tsLabel}|${comp}`
  const indKey = (uiCat, refId, tsLabel) => `${uiCat}|${refId}|${tsLabel}`

  // Valor "efectivo" de una celda para decidir si está llena: el número de
  // `entries` y, para InDrive sin promedio de bids, el precio recomendado (que
  // vive en indriveExtra, no en entries). Fuente ÚNICA para rowState y para el
  // marcado de errores — que diverjan pintaba en rojo una celda ya cargada.
  const effectiveCellValue = (uiCat, refId, tsLabel, comp) => {
    const v = entries[priceKey(uiCat, refId, tsLabel, comp)] ?? ''
    if (comp === 'InDrive' && (v === '' || isNaN(parseFloat(v)))) {
      return indriveExtra[indKey(uiCat, refId, tsLabel)]?.rec ?? ''
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

  const setIndrive = useCallback((uiCat, refId, tsLabel, extra, avg) => {
    const c = bucketRef.current
    const ik = indKey(uiCat, refId, tsLabel)
    const pk = priceKey(uiCat, refId, tsLabel, 'InDrive')
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
    clearCellsData(c, [k], comp === 'InDrive' ? [indKey(uiCat, refId, tsLabel)] : [])
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
    clearCellsData(c, keys, comps.includes('InDrive') ? [indKey(uiCat, refId, tsLabel)] : [])
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

  // Progreso POR TURNO (Mañana/Tarde/Noche) — para el header colapsable de
  // cada TurnoSection. Mismo criterio que filledCount/countAllFilled de
  // arriba, pero separado por el 3er segmento de la key (tsLabel) en vez de
  // sumar las 3 franjas juntas. priceKey/indKey son `uiCat|refId|tsLabel|comp`
  // y `uiCat|refId|tsLabel` respectivamente (ver definición más abajo).
  const filledByTimeslot = useMemo(() => {
    const m = {}
    for (const ts of timeslots) m[ts.label] = 0
    for (const [k, v] of Object.entries(entries)) {
      if (v === '' || isNaN(parseFloat(v))) continue
      const tsLabel = k.split('|')[2]
      if (tsLabel in m) m[tsLabel]++
    }
    for (const [k, ex] of Object.entries(indriveExtra)) {
      const recOk = ex?.rec != null && ex.rec !== '' && !isNaN(parseFloat(ex.rec))
      if (!recOk) continue
      const avg = entries[`${k}|InDrive`]
      const avgOk = avg != null && avg !== '' && !isNaN(parseFloat(avg))
      if (avgOk) continue // ya contado arriba vía `entries`
      const tsLabel = k.split('|')[2]
      if (tsLabel in m) m[tsLabel]++
    }
    for (const k of naKeys) {
      const tsLabel = k.split('|')[2]
      if (tsLabel in m) m[tsLabel]++
    }
    return m
  }, [entries, indriveExtra, naKeys, timeslots])

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
  function buildRows(uiCat, ref, ts) {
    const comps = getCiCompetitors(uiCity, uiCat, null, country, dbConfigs)
    const { year, week } = getISOYearWeek(date)
    const rush = isRushHour(ts.start_time?.slice(0, 5), dbCity) ?? false
    return (
      comps
        .map((comp) => {
          // Celda "sin data" (S/D): fila no_data=true, sin precio ni nada más.
          if (naKeys.has(priceKey(uiCat, ref.id, ts.label, comp))) {
            return {
              price: null,
              comp,
              ref,
              ts,
              uiCat,
              rush,
              year,
              week,
              bids: [],
              minBid: null,
              rec: null,
              eta: null,
              disc: null,
              na: true,
            }
          }
          const raw = entries[priceKey(uiCat, ref.id, ts.label, comp)] ?? ''
          const price = parseFloat(raw)
          const extra = indriveExtra[indKey(uiCat, ref.id, ts.label)]
          // Mig 136: pricing_observations vuelve a tener bid_1..bid_5 → hasta 5
          // bids. Guarda por si un borrador trajera más (nunca debería).
          const bids = comp === 'InDrive' ? (extra?.bids || []).slice(0, 5) : []
          const minBid = comp === 'InDrive' ? extra?.minBid || null : null
          // Precio recomendado por la app de InDrive → recommended_price. NO entra
          // al promedio de bids. Si no hay bids, el precio efectivo cae al
          // recomendado (v_effective_price), por eso una celda solo-recomendado
          // igual debe guardarse (ver filtro de abajo).
          const recNum = comp === 'InDrive' ? parseFloat(extra?.rec ?? '') : NaN
          const etaNum = parseFloat(etaEntries[priceKey(uiCat, ref.id, ts.label, comp)] ?? '')
          const discNum = parseFloat(discEntries[priceKey(uiCat, ref.id, ts.label, comp)] ?? '')
          return {
            price: isNaN(price) ? null : price,
            comp,
            ref,
            ts,
            uiCat,
            rush,
            year,
            week,
            bids,
            minBid,
            rec: isNaN(recNum) ? null : recNum,
            eta: isNaN(etaNum) ? null : etaNum,
            disc: isNaN(discNum) ? null : discNum,
            na: false,
          }
        })
        // Se descartan las celdas sin dato. Excepciones que SÍ se guardan:
        // InDrive con solo el recomendado (su precio efectivo es el recomendado)
        // y las celdas marcadas "sin data" (fila no_data=true).
        .filter((r) => r.na || r.price !== null || r.rec !== null)
    )
  }

  function buildInsertPayload(r, capturedTime) {
    const base = {
      city: dbCity,
      category: resolveDbParams(uiCity, r.uiCat, null, country, dbConfigs).dbCategory,
      // Normalización context-aware: en city='Corp' el canónico usa
      // espacios ('Yango Comfort'), en E/C es pegado ('YangoComfort').
      // r.comp viene del catálogo getCompetitors() que ya tiene el canónico,
      // pero pasamos por normalize por defensa-en-profundidad (idempotente).
      competition_name: normalizeCompetitorName(r.comp, { city: dbCity }),
      observed_date: date,
      // Hora REAL de captura (mig 148) — antes siempre la hora fija del
      // turno. `timeslot` (abajo) es quien identifica el turno ahora; acá
      // va la hora real del momento del guardado (Guardar Progreso/
      // Terminar), una sola marca por click, igual para todas las filas de
      // ese guardado — no por celda individual.
      observed_time: capturedTime,
      // Turno ESTABLE (mig 148): deriva de la hora CANÓNICA del timeslot,
      // nunca de observed_time — así el DELETE-antes-de-INSERT y el reload
      // (loadObservationsIntoForm) siguen encontrando la fila sin importar
      // a qué hora real se guardó.
      timeslot: timeslotLabel(r.ts.start_time?.slice(0, 5)),
      rush_hour: r.rush,
      surge,
      distance_bracket: r.ref.bracket,
      distance_km: r.ref.waze_distance ?? null,
      eta_min: r.eta ?? null,
      point_a: r.ref.point_a ?? null,
      point_b: r.ref.point_b ?? null,
      // Distrito (solo TukTuk lo usa en distance_references.zone) → así la CI
      // manual de TukTuk lleva el distrito igual que el bot y se agrega por zona
      // en el dashboard. Para el resto de categorías la ruta no tiene zone (null).
      // '' → null (ver comentario en el addRoute de performSave) — así las filas
      // nuevas de Corp quedan zone=NULL, igual que las ~17k filas históricas.
      zone: r.ref.zone || null,
      price_without_discount: r.price,
      price_with_discount: r.disc ?? null,
      year: r.year,
      week: r.week,
      data_source: 'manual',
      // Dueño de la fila: el hub que la cargó. Permite que dos hubs guarden la
      // misma ciudad+fecha sin pisarse (el DELETE se acota al dueño) y atribuye
      // cada celda para el monitoreo. Legacy = null (se reclama al re-guardar).
      uploaded_by: userEmail || null,
      // "Sin data" (S/D): el hub atendió la celda, no había oferta. Sin precio →
      // no ensucia promedios; el panel de representatividad lo cuenta aparte.
      no_data: r.na || false,
      country,
    }
    if (r.comp === 'InDrive') {
      r.bids.forEach((b, i) => {
        const n = parseFloat(b)
        if (!isNaN(n)) base[`bid_${i + 1}`] = n
      })
      const mn = parseFloat(r.minBid)
      if (!isNaN(mn)) base.minimal_bid = mn
      // Recomendado en su columna propia (NO en un bid, para no sesgar el
      // promedio). Si no hay bids, v_effective_price cae a recommended_price.
      if (r.rec != null) base.recommended_price = r.rec
    }
    return base
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
      setMsg({ type: 'err', text: t('dataentry.err_tuktuk_district_locked') })
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

    // Agrupar por (dbCat, franja) → set de BRACKETS que se re-insertan. El
    // DELETE se acota a ESOS brackets (.in), no a toda la categoría/franja.
    // Antes borraba categoría+franja entera: como varias rutas (brackets)
    // comparten categoría+franja, borrar por combo se llevaba puesta una ruta
    // hermana de OTRO bracket que estuviera a medias (o que no se re-guardara en
    // este checkpoint) y solo re-insertaba las completas → esa ruta parcial ya
    // guardada se perdía. Acotando por bracket, cada ruta solo toca sus filas.
    // Descriptores de RUTA a limpiar: (dbCat, franja, bracket, point_a, point_b).
    // El DELETE se acota a la RUTA EXACTA (incluidos point_a/point_b), no solo a
    // (categoría, bracket): varias rutas pueden compartir categoría+bracket y
    // diferir solo en los puntos (TukTuk por distrito). Si se acotara por bracket,
    // borrar se llevaría puesta una ruta hermana del mismo bracket que estuviera a
    // medias (o que no se re-guardara en este checkpoint) → esa ruta ya guardada
    // se perdía. Acotando por ruta, cada una solo toca sus propias filas.
    const SEP = '\u0001' // separador que no aparece en direcciones/coords
    const routeDels = new Map()
    // `timeslot` acá es la ETIQUETA estable del turno (mig 148: 'Morning'/
    // 'Midday'/'Evening'), NO la hora real de captura — así el DELETE sigue
    // encontrando la fila vieja sin importar a qué hora real se guardó cada
    // vez (antes se acotaba por `observed_time`, que con hora real cambia
    // en cada guardado y dejaría de matchear → filas duplicadas).
    const addRoute = (uiCat, dbCat, timeslot, bracket, pa, pb, rz) => {
      const k = [dbCat, timeslot, bracket, pa ?? '', pb ?? '', rz ?? ''].join(SEP)
      if (!routeDels.has(k))
        routeDels.set(k, {
          uiCat,
          dbCat,
          timeslot,
          bracket,
          pa: pa ?? null,
          pb: pb ?? null,
          zone: rz ?? null,
        })
    }
    for (const r of rowsToInsert) {
      const dbCat = resolveDbParams(uiCity, r.uiCat, null, country, dbConfigs).dbCategory
      addRoute(
        r.uiCat,
        dbCat,
        timeslotLabel(r.ts.start_time?.slice(0, 5)),
        r.ref.bracket,
        r.ref.point_a,
        r.ref.point_b,
        // '' → null: algunas rutas (Corp) tienen zone='' en distance_references
        // en vez de NULL — sin normalizar, esa cadena vacía se colaba como un
        // valor de zona "real" en el DELETE de abajo.
        r.ref.zone || null
      )
    }
    // Solo al TERMINAR se suman las rutas cargadas del historial (para borrar las
    // que el hub vació tras reabrir). En "Guardar progreso" NO: un checkpoint nunca
    // borra una ruta que no se está re-guardando — si una ruta cargada quedó a
    // medias, se conserva en BD hasta Terminar (donde ya no se permiten parciales).
    // loadedCombos = Map de descriptores de ruta {uiCat,dbCat,timeslot,bracket,pa,pb}.
    if (isFinish && loadedCombos) {
      for (const c of loadedCombos.values())
        addRoute(c.uiCat, c.dbCat, c.timeslot, c.bracket, c.pa, c.pb, c.zone ?? null)
    }

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
    // problemas con la normalización (CLAUDE.md §4).
    const routesPayload = Array.from(routeDels.values())
      .map((rt) => ({
        category: rt.dbCat,
        timeslot: rt.timeslot,
        bracket: rt.bracket,
        point_a: rt.pa,
        point_b: rt.pb,
        // Un competidor marcado "no ofrece" (ciHidden) conserva su histórico:
        // si no está visible, no entra en el acote y por lo tanto no se borra.
        competitors: (rt.uiCat
          ? getCiCompetitors(uiCity, rt.uiCat, null, country, dbConfigs)
          : []
        ).map((c) => normalizeCompetitorName(c, { city: dbCity })),
      }))
      // Sin competidores visibles no hay nada que borrar. Se filtra acá además
      // de en SQL para no mandar ruido por la red.
      .filter((rt) => rt.competitors.length > 0)

    const payloads = rowsToInsert.map((r) => buildInsertPayload(r, capturedTime))
    // Se captura el contador de ediciones ACÁ, junto con el payload — no
    // después del await. Un guardado de 324 celdas tarda segundos, y todo lo
    // que el hub teclee mientras viaja NO está en este payload: sellarlo al
    // volver lo marcaría como guardado siendo mentira.
    const seqEnviado = editSeqRef.current[bucketKey] ?? 0

    const { data: saveRes, error: saveErr } = await sb.rpc('save_ci_batch', {
      p_country: country,
      p_city: dbCity,
      p_date: date,
      // La zona CONSTANTE de la vista (el distrito activo en TukTuk, null en el
      // resto) — NUNCA la de la fila individual. Hay ~76k filas manuales con
      // zona no-null fuera de TukTuk (Aeropuerto por Excel) que un borrado sin
      // este acote se llevaba puestas en silencio.
      p_zone: zone ?? null,
      // Sin email se cae a solo-las-sin-dueño, nunca a un borrado sin predicado
      // de dueño (mig 139).
      p_user_email: userEmail || null,
      p_routes: routesPayload,
      p_rows: payloads,
      // Guard de concurrencia (mig 191): identidad de ESTA pestaña + la marca
      // de agua con la que se sincronizó. Si otra pestaña —u otro
      // dispositivo con la misma cuenta— escribió este bucket después, el
      // servidor aborta el guardado ENTERO en vez de borrar sus filas.
      p_session_id: SESSION_ID,
      p_expected_seq: readSyncSeq(),
      p_force: forceOverwrite === true,
    })
    if (saveErr) {
      // 55006 = otra pestaña/dispositivo escribió este bucket. El servidor NO
      // borró ni insertó nada: la data de la otra sigue intacta.
      if (saveErr.code === '55006') {
        setSaveConflict({ at: saveErr.details || null, isFinish })
        setMsg({ type: 'err', text: t('dataentry.err_save_conflict'), emphasize: true })
        setSaving(false)
        // NO se marca guardado, NO se limpia el borrador, NO se inserta en
        // ci_sessions y NO se borra el latido: el hub no perdió nada.
        return false
      }
      // Mensaje ACCIONABLE para el hub (no el .message crudo de Postgres —
      // jerga técnica tipo "duplicate key value violates..." no le dice qué
      // hacer). El detalle técnico va a consola para diagnóstico nuestro.
      console.error('[performSave] save_ci_batch error:', saveErr)
      setMsg({ type: 'err', text: t('dataentry.err_save_failed') })
      setSaving(false)
      return false
    }
    if (saveRes && Number.isFinite(Number(saveRes.seq))) writeSyncSeq(Number(saveRes.seq))
    setSaveConflict(null)
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
      const { error: sessErr } = await sb.from('ci_sessions').insert({
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
        setMsg({ type: 'err', text: t('dataentry.err_session_not_closed'), emphasize: true })
        setSaving(false)
        return false
      }
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
          await sb.from('ci_active_sessions').delete().eq('user_email', userEmail)
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
          let q = sb
            .from('ci_active_sessions')
            .delete()
            .eq('user_email', userEmail)
            .eq('country', closedCountry)
            .eq('city', closedCity)
            .eq('observed_date', closedDate)
          q = closedZone != null ? q.eq('zone', closedZone) : q.is('zone', null)
          q.then(
            () => {},
            () => {}
          )
        }, 10_000)
      }
      if (isFinalInScope) {
        setSessionActive(false)
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
  async function handleSaveProgress(forceOverwrite = false) {
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
      setMsg({ type: 'err', text: t('dataentry.err_no_full') })
      return
    }
    await performSave(rowsToInsert, false, true, forceOverwrite)
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
    const { hasPartial, hasEmpty } = validateAndCollectErrors(true)
    if (hasPartial || hasEmpty) {
      setMsg({ type: 'err', text: t('dataentry.err_finish') })
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
      setMsg({ type: 'err', text: t('dataentry.err_no_full') })
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
      const nextUi = remainingAfterThis[0]
      setUiCity(nextUi)
      setActiveTukTuk(null)
    }
  }

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
      setMsg({ type: 'ok', text: t('dataentry.already_viewing_session') })
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
    const targetBucketKey = s.zone ? `TT~${s.city}~${s.zone}` : s.city
    // Fusionar, nunca pisar: reemplazar el alcance borraba los frentes que
    // seguían a medias (ej. Punto A+B declarados) sin dejar rastro, y la
    // sesión después cerraba como final abandonándolos en silencio.
    setPendingScopeMembers((prev) =>
      prev.includes(targetBucketKey) ? prev : [...prev, targetBucketKey]
    )
    setShowHistory(false)
    if (s.zone) {
      // Sesión de TukTuk por distrito: volver a la ciudad base con TukTuk + el
      // distrito guardado en la sesión.
      setUiCity(tukTukInfo?.baseUiCity || targetUi)
      setActiveTukTuk(s.zone)
    } else {
      setUiCity(targetUi)
      setActiveTukTuk(null)
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
    setMsg({ type: 'ok', text: t('dataentry.loading_session') })
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
      setMsg({ type: 'ok', text: t('dataentry.just_finished_note') })
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
      const { data: wm, error: wmErr } = await sb
        .from('ci_bucket_writes')
        .select('write_seq')
        .eq('user_email', userEmail)
        .eq('country', country)
        .eq('city', loadDbCity)
        .eq('zone_key', loadZone ?? '')
        .eq('observed_date', loadDate)
        .maybeSingle()
      writeSyncSeqFor(
        country,
        loadDbCity,
        loadZone,
        loadDate,
        !wmErr && wm ? Number(wm.write_seq) : null
      )
    }

    let obsQuery = sb
      .from('pricing_observations')
      .select(
        'category, competition_name, observed_time, timeslot, distance_bracket, point_a, point_b, zone, price_without_discount, price_with_discount, recommended_price, eta_min, minimal_bid, bid_1, bid_2, bid_3, bid_4, bid_5, no_data, surge'
      )
      .eq('country', country)
      .eq('city', loadDbCity)
      .eq('observed_date', loadDate)
      .eq('data_source', 'manual')
    // TukTuk: acotar al distrito (zone). Vistas normales: sin filtro de zona (y
    // el guard de categorías de abajo descarta cualquier fila de TukTuk).
    if (loadZone != null) obsQuery = obsQuery.eq('zone', loadZone)
    // Cargar solo las filas propias (+ legacy sin dueño) para editar. Si se
    // cargaran también las de otro hub, al re-guardar se insertarían como
    // propias (el DELETE no borra las del otro dueño) → duplicados (mig 139).
    // Mismo criterio simétrico que el DELETE del guardado (siempre por dueño).
    obsQuery = userEmail
      ? obsQuery.or(`uploaded_by.eq.${userEmail},uploaded_by.is.null`)
      : obsQuery.is('uploaded_by', null)
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
      sb.rpc('get_ci_session_turno_timings', {
        p_country: country,
        p_city: loadDbCity,
        p_zone: loadZone,
        p_observed_date: loadDate,
      }),
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

      const comboKey = `${row.category}${dbTimeslot}${row.distance_bracket}${row.point_a ?? ''}${row.point_b ?? ''}`
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
      if (comp === 'InDrive') {
        const bids = [row.bid_1, row.bid_2, row.bid_3, row.bid_4, row.bid_5]
          .filter((b) => b != null)
          .map((b) => String(b))
        newIndrive[indKey(uiCat, ref.id, tsLabel)] = {
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
    setSurgeByCity((prev) => ({ ...prev, [bucket]: newSurge }))
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
  // bloquear nada, si otro hub está trabajando el mismo Punto de Aeropuerto
  // o el mismo distrito de TukTuk ahora mismo. La flexibilidad de
  // redistribuirse entre hubs es intencional (pedido 2) — esto es solo
  // visibilidad para coordinarse, nunca un candado.
  const [presence, setPresence] = useState([])
  const relevantForPresence = !!activeAirportMembers || isTukTuk
  useEffect(() => {
    if (!relevantForPresence || !country) return
    let cancelled = false
    const fetchPresence = () => {
      sb.rpc('get_active_sessions_presence', { p_country: country }).then(({ data, error }) => {
        if (!cancelled && !error) setPresence(data || [])
      })
    }
    fetchPresence()
    const id = setInterval(fetchPresence, 20_000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [relevantForPresence, country])

  // Hubs (≠ yo, ya excluidos por la RPC) activos ahora mismo en esa
  // ciudad/zona EXACTA — misma identidad que usa ci_active_sessions.
  const presenceFor = (city, zone) =>
    presence.filter((p) => p.city === city && (p.zone ?? null) === (zone ?? null))

  // ── Latido de sesión activa (para Monitoreo) ───────────
  // Mientras sessionActive, avisa periódicamente "sigo acá, en tal ciudad/
  // distrito, con tanto progreso" — ver mig 146 (tabla ci_active_sessions +
  // RPC upsert_ci_active_session). Nunca debe afectar el flujo real del hub:
  // todo en try/catch silencioso, jamás toca setMsg ni bloquea el guardado.
  const heartbeatRef = useRef(null)
  // Alcance declarado (mig 151, solo Aeropuerto) — para que Monitoreo
  // muestre "Aeropuerto A+B" en vez de solo la pestaña momentánea, que
  // confunde cuando el hub está alternando entre Punto A y Punto B dentro de
  // la MISMA sesión declarada como "Ambos".
  const scopeLabel =
    activeAirportMembers && pendingScopeMembers.length
      ? activeAirportMembers
          .filter((m) => pendingScopeMembers.includes(m.uiCity))
          .map((m) => m.side)
          .join('+')
      : null
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
  const fronts = useMemo(() => {
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
    return buildFronts({
      scopeMembers: pendingScopeMembers,
      extraFronts: pendingExtraFronts,
      currentBucket: bucketKey,
      filledByBucket,
      totalByBucket: { ...totalByBucket, [bucketKey]: totalExpected },
    })
  }, [
    pendingScopeMembers,
    pendingExtraFronts,
    bucketKey,
    filledCount,
    totalExpected,
    totalByBucket,
    entriesByCity,
    indriveByCity,
    naByCity,
  ])

  heartbeatRef.current = {
    country,
    city: dbCity,
    zone,
    date,
    filledCount,
    totalExpected,
    fronts,
    // Desglose por turno (mig 150) — para que Monitoreo muestre en qué
    // turno está cada hub, no solo el total agregado.
    // `timings` viaja en el mismo jsonb que ya usa Monitoreo (turno_progress) —
    // clave nueva, aditiva: LiveSessionsPanel solo lee .filled/.total_per_turno,
    // no rompe nada. Persiste en vivo cada heartbeat (~25s) para no perder el
    // dato si el navegador se cierra antes de Terminar Sesión.
    turnoProgress: {
      total_per_turno: totalExpectedPerTimeslot,
      filled: filledByTimeslot,
      timings: turnoTimings,
    },
    scopeLabel,
  }
  // Fallos de latido consecutivos (mig 149) — contador puramente local, se
  // reporta en el próximo latido exitoso para que Monitoreo (admin) pueda
  // distinguir "esta sesión tuvo problemas intermitentes de red" de "el hub
  // cerró la laptop" — ambos se ven idénticos si solo se mira last_seen_at.
  const heartbeatFailStreakRef = useRef(0)

  const sendHeartbeat = useCallback(async () => {
    const p = heartbeatRef.current
    if (!p || !p.city) return
    try {
      const failures = heartbeatFailStreakRef.current
      const { error } = await sb.rpc('upsert_ci_active_session', {
        p_country: p.country,
        p_city: p.city,
        p_zone: p.zone,
        p_observed_date: p.date,
        p_filled_count: p.filledCount,
        p_total_expected: p.totalExpected,
        p_recent_failures: failures,
        p_turno_progress: p.turnoProgress,
        p_scope_label: p.scopeLabel,
        p_fronts: p.fronts && p.fronts.length ? p.fronts : null,
      })
      // supabase-js NO tira excepción por un error a nivel Postgres/RPC (solo
      // por fallos de red) — sin este chequeo explícito, un error del lado del
      // servidor (RLS, función ambigua, etc.) se contaba como latido exitoso.
      if (error) throw error
      heartbeatFailStreakRef.current = 0
      // Confirmación real de servidor — ver indicador "confirmado en
      // servidor" en el header. Un latido exitoso ya prueba que el backend
      // nos escucha, no hace falta esperar a un guardado explícito.
      setLastHeartbeatOkAt(Date.now())
    } catch {
      // best-effort: un fallo acá nunca debe interrumpir al hub (el
      // indicador de servidor simplemente no se refresca y va envejeciendo
      // hasta mostrar el aviso — ver umbral abajo). Sí se cuenta para
      // reportarlo en el próximo latido exitoso (ver arriba).
      heartbeatFailStreakRef.current += 1
    }
  }, [])

  // Piso de confiabilidad: late cada ~25s mientras la sesión esté activa,
  // sin importar si el hub está tipeando (evita que last_seen_at se vea
  // "viejo" solo porque está mirando distancias/fotos sin escribir).
  useEffect(() => {
    if (!sessionActive || !userEmail) return
    sendHeartbeat()
    const id = setInterval(sendHeartbeat, 25_000)
    return () => clearInterval(id)
  }, [sessionActive, userEmail, sendHeartbeat])

  // Ping extra con el mismo debounce que el autosave del borrador — refleja
  // un cambio de distrito/progreso más rápido que el intervalo de 25s.
  useEffect(() => {
    if (!sessionActive || !userEmail) return
    const id = setTimeout(sendHeartbeat, 1500)
    return () => clearTimeout(id)
  }, [sessionActive, userEmail, bucketKey, date, filledCount, sendHeartbeat])

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
              <Button onClick={handleSaveProgress} disabled={saving}>
                {saving
                  ? t('dataentry.saving')
                  : `${t('dataentry.save_progress')}${savableCount > 0 ? ` (${savableCount})` : ''}`}
              </Button>
              <Button
                className="bg-green-800 hover:bg-green-900"
                onClick={handleFinishSession}
                disabled={saving}
              >
                {pendingScopeMembers.length > 1 || pendingExtraFronts.length > 0
                  ? t('dataentry.end_session_point')
                  : t('dataentry.end_session')}
              </Button>
            </>
          )}
        </div>
      </div>

      <InstructionsBanner t={t} />
      {pendingExtraFronts.length > 0 && (
        <div className="de-locked-district-banner">
          {t('dataentry.extra_fronts_pending', {
            list: pendingExtraFronts.map(frontLabel).join(', '),
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
                      : 'TukTuk'
              const active =
                tb.type === 'tuktuk'
                  ? isTukTuk && uiCity === tb.baseUiCity
                  : tb.type === 'airport'
                    ? !isTukTuk && tb.members.some((m) => m.uiCity === uiCity)
                    : tb.type === 'corp'
                      ? !isTukTuk && uiCity === 'Corp'
                      : !isTukTuk && uiCity === tb.uiCity
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
                      }
                    } else if (tb.type === 'airport') {
                      if (!active) {
                        // Aterrizar en un punto DECLARADO si lo hay: volver
                        // al Aeropuerto desde otro frente caía siempre en
                        // members[0], que si el hub había declarado solo el
                        // Punto B estaba bloqueado por su propio candado.
                        setUiCity(
                          (
                            tb.members.find((m) => pendingScopeMembers.includes(m.uiCity)) ||
                            tb.members[0]
                          ).uiCity
                        )
                        setActiveTukTuk(null)
                      }
                    } else {
                      setUiCity(tb.uiCity)
                      setActiveTukTuk(null)
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
                pendingScopeMembers.includes(mm.uiCity)
              )
              const locked =
                sessionActive && scopeOwnsThisCluster && !pendingScopeMembers.includes(m.uiCity)
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
              activeAirportMembers.some((m) => pendingScopeMembers.includes(m.uiCity)) &&
              activeAirportMembers.some((m) => !pendingScopeMembers.includes(m.uiCity)) && (
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
            {timeslots.map((ts) => (
              <span key={ts.label} className="de-ts-badge">
                {ts.label} ({ts.start_time?.slice(0, 5)}–{ts.end_time?.slice(0, 5)})
              </span>
            ))}
          </div>

          <div className="de-progress-pill">
            <span className="de-progress-filled">{filledCount}</span>
            <span className="de-progress-sep">/</span>
            <span className="de-progress-total">{totalExpected}</span>
            <span className="de-progress-label">{t('dataentry.fields')}</span>
          </div>

          {/* Indicadores "guardado/confirmado hace Xs" — su ticker de 1s vive
              adentro, aislado de la grilla. Reusa el mismo umbral de 3 min
              (LIVE_STALE_MS) que Monitoreo del lado del admin. */}
          <SaveStatusIndicators
            sessionActive={sessionActive}
            lastDraftSavedAt={lastDraftSavedAt}
            lastSaveOkAt={lastSaveOkAt}
            lastHeartbeatOkAt={lastHeartbeatOkAt}
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

      {/* Fallo de almacenamiento del navegador (durabilidad R5). Persistente
          y destacado: es la única situación donde el hub DEBE actuar ya, y
          antes no se enteraba de nada. */}
      {storageFailed && (
        <div className="de-msg de-msg--err de-msg--emphasize">
          <AlertTriangle className="de-msg__icon" size={20} />
          {t('dataentry.storage_failed')}
        </div>
      )}

      {/* Recuperación de conflicto (mig 191). Sin estas dos salidas el hub
          queda trabado: el servidor le frena el guardado y no tiene forma de
          seguir. Las dos son EXPLÍCITAS y dicen qué descartan — ninguna
          resuelve el conflicto en silencio. */}
      {saveConflict && (
        <div className="de-conflict">
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
          {timeslots.map((ts) => (
            <TurnoSection
              key={ts.label}
              timeslot={ts}
              filled={filledByTimeslot[ts.label] || 0}
              total={totalExpectedPerTimeslot}
              hasErrors={!!errorsByTimeslot[ts.label]}
            >
              {refsByBracket.map(({ bracket, groups, extras }) => (
                <div key={bracket} className="de-bracket-section">
                  {groups.map((group, gi) => (
                    <BracketRouteGroup
                      key={`${bracket}-${gi}`}
                      bracket={bracket}
                      group={group}
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
              ))}
            </TurnoSection>
          ))}
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
              <Button onClick={handleSaveProgress} disabled={saving}>
                {saving
                  ? t('dataentry.saving')
                  : `${t('dataentry.save_progress')}${savableCount > 0 ? ` (${savableCount})` : ''}`}
              </Button>
              <Button
                className="bg-green-800 hover:bg-green-900"
                onClick={handleFinishSession}
                disabled={saving}
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
            <span className={msg.type === 'ok' ? 'de-footer-ok' : 'de-footer-err'}>{msg.text}</span>
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
