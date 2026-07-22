import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { sb } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { getCiCompetitors, resolveDbParams } from '../lib/constants'
import { normalizeCompetitorName } from '../lib/normalize'
import { getSourceCategory } from '../lib/distanceRefsReplication'
import { buildRefsByBracket } from '../lib/bracketGrouping'
import { capIndriveExtraBids } from '../lib/indriveAvg'
import { getISOYearWeek } from '../lib/dateUtils'
import { useRushHourConfig } from '../hooks/useRushHourConfig'
import { useCITimeslots } from '../hooks/useCITimeslots'
import { useI18n } from '../context/LanguageContext'
import { Button } from '../components/ui/shadcn/button'
import BracketRouteGroup from '../components/dataentry/BracketRouteGroup'
import InstructionsBanner from '../components/dataentry/InstructionsBanner'
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

// ⚠ PROVISIONAL (semana de texteo, 2026-07-20): permitir "Terminar Sesión"
// cuando el HP completó AL MENOS UN turno entero (Mañana / Tarde / Noche) con
// todos sus brackets, sin exigir los 3 turnos. No se permite terminar con
// filas a medias (parciales) — esas se siguen marcando como error.
//
// PARA VOLVER AL MODO ESTRICTO (toda la grilla completa, los 3 turnos): poner
// FINISH_REQUIRES_ALL = true (una línea) y listo.
const FINISH_REQUIRES_ALL = false

// ── Helpers ────────────────────────────────────────────────────────────────
function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

function fmtElapsed(ms) {
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0)
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
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

// Rebanadas vacías compartidas (identidad estable) para el estado por-ciudad:
// evitan crear un objeto nuevo por render cuando la ciudad activa no tiene datos
// (si no, las deps de los effects "cambiarían" en cada render).
const EMPTY_OBJ = {}
const EMPTY_SET = new Set()

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
  const [refs, setRefs] = useState([])
  const [refsLoading, setRefsLoading] = useState(false)
  // Ciudad a la que pertenecen las `refs` actualmente en estado. Clave para
  // "Abrir" una sesión de OTRA ciudad: sin esto, el effect de carga corría en
  // el mismo commit con las refs de la ciudad anterior (refsLoading todavía
  // false) y mapeaba mal la data. Se setea recién cuando las refs de la ciudad
  // objetivo llegaron.
  const [refsDbCity, setRefsDbCity] = useState(null)

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

  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState(null)

  // Session management
  const sessionStartRef = useRef(null)
  const [sessionActive, setSessionActive] = useState(false)
  const [elapsed, setElapsed] = useState('00:00')

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
  // Cache de rutas por ciudad — cambiar de ciudad no vuelve a pegarle a la BD ni
  // muestra spinner (clave para intercalar A/B sin parpadeo).
  const refsCacheRef = useRef({})
  // "Contexto" del formulario = país + fecha. Al cambiar, TODAS las ciudades
  // quedan obsoletas (eran de la fecha vieja) → se limpian y se re-permite
  // hidratar cada ciudad una vez. `hydratedCitiesRef` recuerda qué ciudades ya
  // se hidrataron en el contexto actual, para no re-hidratar al intercalar A↔B
  // (la memoria manda) — se rastrea por ref, no por el estado en memoria, para
  // no depender del timing de los setState de limpieza.
  const loadedContextRef = useRef(null)
  const hydratedCitiesRef = useRef(new Set())

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
        ensure(CORP_UNDER[c] || c).tabs.push({ type: 'corp', uiCity: c })
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

  // Cascada: reseteo cuando cambia el país
  useEffect(() => {
    const firstCity = countryConfig.cities[0]
    setUiCity(firstCity)
    setActiveTukTuk(null)
    // dbCity es reactivo a uiCity y categories, así no hay problema
  }, [country, countryConfig])

  // ── Timer — only when session is active ───────────────
  useEffect(() => {
    if (!sessionActive) return
    const id = setInterval(() => {
      setElapsed(fmtElapsed(Date.now() - sessionStartRef.current))
    }, 1000)
    return () => clearInterval(id)
  }, [sessionActive])

  // ── Start session ──────────────────────────────────────
  function handleStartSession() {
    sessionStartRef.current = Date.now()
    setElapsed('00:00')
    setSessionActive(true)
    setMsg(null)
  }

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

  useEffect(() => {
    if (showHistory) loadSessionHistory()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showHistory])

  // ── Reset city when country changes ───────────────────
  // El cambio de país resetea la ciudad y el cache de rutas; los datos del
  // formulario los limpia el effect de restauración al detectar el cambio de
  // contexto (país cambió → nueva draftKey → limpia todas las ciudades).
  useEffect(() => {
    const firstCity = countryConfig.cities[0]
    setUiCity(firstCity)
    setActiveTukTuk(null)
    refsCacheRef.current = {} // otro país → otras ciudades/rutas
    setRefs([]) // Limpiar rutas antiguas inmediatamente
    setRefsDbCity(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [country, countryConfig])

  // ── Load refs (cacheadas por ciudad) ───────────────────
  // Cambiar de ciudad NO resetea el formulario: el estado por-ciudad se mantiene
  // en memoria y las rutas salen del cache si ya se cargaron (intercalar A/B es
  // instantáneo, sin spinner ni parpadeo). Solo la primera visita a una ciudad
  // pega a la BD.
  useEffect(() => {
    if (!dbCity) return
    const cached = refsCacheRef.current[dbCity]
    if (cached) {
      setRefs(cached)
      setRefsDbCity(dbCity)
      setRefsLoading(false)
      return
    }
    setRefsLoading(true)
    setRefsDbCity(null) // las refs en estado ya no corresponden a `dbCity`
    sb.from('distance_references')
      .select('*')
      .eq('country', country)
      .eq('city', dbCity)
      .order('category')
      .order('bracket')
      .order('point_a')
      .then(({ data }) => {
        refsCacheRef.current[dbCity] = data || []
        setRefs(data || [])
        setRefsDbCity(dbCity)
        setRefsLoading(false)
      })
  }, [dbCity, country])

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
  // automáticamente al primero — mismo criterio que Aeropuerto entra a Punto A.
  useEffect(() => {
    if (activeTukTuk === '' && tukTukDistricts.length > 0) {
      setActiveTukTuk(tukTukDistricts[0])
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
      bucketKey
    )
    setPendingLoad(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingLoad, refsLoading, refsDbCity, dbCity, date, refs, zone, bucketKey])

  // ── Autosave a localStorage (draft) ────────────────────
  // Clave por (country, uiCity, date). Restaura al cambiar a una clave con
  // borrador existente; persiste cada cambio con debounce 2s; limpia tras
  // guardado exitoso a Supabase (ver handleSave / handleSaveProgress).
  // viewId = uiCity en vistas normales (sin cambios) o `TT~<dbCity>~<distrito>`
  // en TukTuk, para que cada distrito tenga su propio borrador.
  const draftKey = `de:draft:${country}:${viewId}:${date}`
  const draftHydratedRef = useRef(false)
  // Indicador "guardado hace Xs" — se lee en el header (progress pill).
  const [lastDraftSavedAt, setLastDraftSavedAt] = useState(null)
  const [nowTick, setNowTick] = useState(() => Date.now())

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
    }
    // Hidratar esta ciudad UNA vez por contexto. Al intercalar A↔B, la 2da vez
    // ya está en el set → no se re-hidrata (la memoria, más nueva, manda).
    if (!hydratedCitiesRef.current.has(targetCity)) {
      hydratedCitiesRef.current.add(targetCity)
      try {
        const raw = localStorage.getItem(draftKey)
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
            setLastDraftSavedAt(parsed.savedAt || null)
            setMsg({
              type: 'ok',
              text: `📝 Borrador restaurado (${restored + naArr.length} celdas).`,
            })
          }
        }
      } catch {
        /* ignore corrupt draft */
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

  useEffect(() => {
    if (!draftHydratedRef.current) return
    const id = setTimeout(() => {
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
              savedAt,
            })
          )
          setLastDraftSavedAt(savedAt)
        } else {
          localStorage.removeItem(draftKey)
          setLastDraftSavedAt(null)
        }
      } catch {
        /* quota / disabled */
      }
    }, 1500)
    return () => clearTimeout(id)
  }, [entries, indriveExtra, etaEntries, discEntries, surge, naKeys, draftKey])

  // Flush SÍNCRONO del borrador al cambiar de ciudad/fecha o al SALIR de la
  // página (desmontar / navegar). El autosave con debounce podría no haber
  // disparado sus últimos ~1.5s; sin este flush, cambiar de ciudad y luego
  // refrescar perdía las últimas celdas de la ciudad vieja. Se capturan la
  // ciudad y la clave de ESTA corrida; el cleanup lee la rebanada de ESA ciudad
  // desde perCityRef (que retiene todas las ciudades), así flushea la ciudad
  // vieja bajo su clave vieja aunque ya se haya cambiado de ciudad.
  useEffect(() => {
    const flushCity = bucketKey
    const flushKey = draftKey
    return () => {
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
          localStorage.setItem(
            flushKey,
            JSON.stringify({
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
        /* quota / disabled */
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey])

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

  // ── Indicador "guardado hace Xs" — ticker ──────────────
  useEffect(() => {
    if (lastDraftSavedAt == null) return
    const id = setInterval(() => setNowTick(Date.now()), 1000)
    return () => clearInterval(id)
  }, [lastDraftSavedAt])

  // ── Borradores sin terminar (todos, por país) ──────────
  // Un "borrador" = una (ciudad, fecha) con datos SIN TERMINAR, guardado solo
  // en este navegador (localStorage, uno por país/ciudad/fecha). Escaneamos
  // TODAS las claves de este país para: (1) listarle al hub sus borradores con
  // Reanudar/Descartar y (2) aplicar el tope de MAX_DRAFTS borradores a la vez.
  // draftScanTick fuerza un re-escaneo tras terminar/descartar una sesión.
  const MAX_DRAFTS = 2
  const [activeDrafts, setActiveDrafts] = useState([])
  const [draftScanTick, setDraftScanTick] = useState(0)

  useEffect(() => {
    const prefix = `de:draft:${country}:`
    const list = []
    for (let i = 0; i < localStorage.length; i++) {
      // Try/catch POR CLAVE — un borrador corrupto no debe abortar el escaneo
      // entero y esconder los demás borradores válidos.
      try {
        const k = localStorage.key(i)
        if (!k || !k.startsWith(prefix)) continue
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
    if (d.resume?.tukTuk) {
      setUiCity(d.resume.uiCity)
      setActiveTukTuk(d.resume.zone)
    } else {
      setUiCity(d.resume?.uiCity ?? d.city)
      setActiveTukTuk(null)
    }
    setDate(d.date)
    setMsg(null)
  }

  function discardDraft(d) {
    try {
      localStorage.removeItem(d.key)
    } catch {
      /* ignore */
    }
    setActiveDrafts((prev) => prev.filter((x) => x.key !== d.key))
    setDraftScanTick((tk) => tk + 1)
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
    setEntriesByCity((prev) => ({ ...prev, [c]: { ...(prev[c] || {}), [k]: val } }))
    clearErrorKeyFor(c, k) // clear error on edit
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
    setEtaByCity((prev) => ({ ...prev, [c]: { ...(prev[c] || {}), [k]: val } }))
  }, [])

  // Precio CON descuento por competidor (misma clave que el precio principal,
  // guardado aparte en discEntries → columna price_with_discount). Opcional:
  // no cuenta para el "completado" de la fila.
  const getDisc = (uiCat, refId, tsLabel, comp) =>
    discEntries[priceKey(uiCat, refId, tsLabel, comp)] ?? ''
  const setDisc = useCallback((uiCat, refId, tsLabel, comp, val) => {
    const c = bucketRef.current
    const k = priceKey(uiCat, refId, tsLabel, comp)
    setDiscByCity((prev) => ({ ...prev, [c]: { ...(prev[c] || {}), [k]: val } }))
  }, [])

  const setIndrive = useCallback((uiCat, refId, tsLabel, extra, avg) => {
    const c = bucketRef.current
    const ik = indKey(uiCat, refId, tsLabel)
    const pk = priceKey(uiCat, refId, tsLabel, 'InDrive')
    setIndriveByCity((prev) => ({ ...prev, [c]: { ...(prev[c] || {}), [ik]: extra } }))
    setEntriesByCity((prev) => ({ ...prev, [c]: { ...(prev[c] || {}), [pk]: avg } }))
    clearErrorKeyFor(c, pk)
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

  function buildInsertPayload(r) {
    const base = {
      city: dbCity,
      category: resolveDbParams(uiCity, r.uiCat, null, country, dbConfigs).dbCategory,
      // Normalización context-aware: en city='Corp' el canónico usa
      // espacios ('Yango Comfort'), en E/C es pegado ('YangoComfort').
      // r.comp viene del catálogo getCompetitors() que ya tiene el canónico,
      // pero pasamos por normalize por defensa-en-profundidad (idempotente).
      competition_name: normalizeCompetitorName(r.comp, { city: dbCity }),
      observed_date: date,
      observed_time: r.ts.start_time?.slice(0, 5),
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
  async function performSave(rowsToInsert, isFinish = false) {
    setSaving(true)
    setMsg(null)

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
    const addRoute = (uiCat, dbCat, time, bracket, pa, pb, rz) => {
      const k = [dbCat, time, bracket, pa ?? '', pb ?? '', rz ?? ''].join(SEP)
      if (!routeDels.has(k))
        routeDels.set(k, {
          uiCat,
          dbCat,
          time,
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
        r.ts.start_time?.slice(0, 5),
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
    // loadedCombos = Map de descriptores de ruta {uiCat,dbCat,time,bracket,pa,pb}.
    if (isFinish && loadedCombos) {
      for (const c of loadedCombos.values())
        addRoute(c.uiCat, c.dbCat, c.time, c.bracket, c.pa, c.pb, c.zone ?? null)
    }

    // Los DELETE por ruta se disparan en PARALELO (Promise.all) para no encadenar
    // un round-trip por ruta — clave para que guardar/terminar no se vuelva lento
    // en ciudades con muchas rutas (ej. TukTuk, 7 distritos × bracket).
    const delResults = await Promise.all(
      Array.from(routeDels.values()).map((rt) => {
        // Acotar el DELETE a los competidores VISIBLES (getCiCompetitors) de esa
        // categoría — así un competidor "no ofrece" (ciHidden) con histórico NO se
        // borra al re-guardar. Nombres normalizados igual que buildInsertPayload.
        const visibleNames = (
          rt.uiCat ? getCiCompetitors(uiCity, rt.uiCat, null, country, dbConfigs) : []
        ).map((c) => normalizeCompetitorName(c, { city: dbCity }))
        if (visibleNames.length === 0) return Promise.resolve({ error: null })
        let q = sb
          .from('pricing_observations')
          .delete()
          .eq('country', country)
          .eq('city', dbCity)
          .eq('category', rt.dbCat)
          .eq('observed_date', date)
          .eq('observed_time', rt.time)
          .eq('distance_bracket', rt.bracket)
          .eq('data_source', 'manual')
          .in('competition_name', visibleNames)
        q = rt.pa != null ? q.eq('point_a', rt.pa) : q.is('point_a', null)
        q = rt.pb != null ? q.eq('point_b', rt.pb) : q.is('point_b', null)
        // Zona (distrito): SOLO en la vista TukTuk se acota el DELETE a SU
        // distrito (nunca pisa otro distrito). El guard es `isTukTuk` (de la
        // vista activa), NO solo "rt.zone != null": hay ~76k filas manuales de
        // auto con zona no-null en el histórico (y Corp guarda zone='' en
        // distance_references) — sin este guard explícito, una ruta cargada del
        // historial (loadedCombos) podía colar esa zona vieja al DELETE y dejar
        // filas huérfanas sin borrar. Fuera de TukTuk, el comportamiento es
        // idéntico al de antes de este cambio (sin predicado de zona).
        if (isTukTuk && rt.zone != null) q = q.eq('zone', rt.zone)
        // Acotar al dueño (este hub) + legacy sin dueño (NULL). SIEMPRE por dueño:
        // sin email se cae a solo-NULL, nunca a un DELETE sin predicado de dueño.
        q = userEmail
          ? q.or(`uploaded_by.eq.${userEmail},uploaded_by.is.null`)
          : q.is('uploaded_by', null)
        return q
      })
    )
    const delErr = delResults.find((r) => r && r.error)?.error
    if (delErr) {
      setMsg({ type: 'err', text: `Error al limpiar: ${delErr.message}` })
      setSaving(false)
      return false
    }

    const payloads = rowsToInsert.map(buildInsertPayload)
    const BATCH = 200
    for (let i = 0; i < payloads.length; i += BATCH) {
      const { error: insErr } = await sb
        .from('pricing_observations')
        .insert(payloads.slice(i, i + BATCH))
      if (insErr) {
        setMsg({ type: 'err', text: `Error al insertar: ${insErr.message}` })
        setSaving(false)
        return false
      }
    }

    if (isFinish) {
      const now = new Date()
      const start = sessionStartRef.current || Date.now()
      const dur = Math.round(((now - new Date(start)) / 60000) * 10) / 10
      await sb.from('ci_sessions').insert({
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
        rows_saved: payloads.length,
      })
      setSessionActive(false)
      setElapsed('00:00')
      setMsg({
        type: 'ok',
        text: `✓ Sesión completada en ${dur} min. ${payloads.length} registros guardados.`,
      })
    } else {
      setMsg({
        type: 'ok',
        text: `✓ ${payloads.length} registros guardados. Puedes seguir completando.`,
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
  async function handleSaveProgress() {
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
    await performSave(rowsToInsert, false)
  }

  // ¿Está ENTERO un turno (ts)? Todas las filas (categoría × ruta) de esa
  // franja tienen que estar full, y tiene que haber al menos una fila real
  // (si la ciudad no tiene rutas, no cuenta como "turno completo").
  function isTimeslotComplete(ts) {
    let total = 0
    let full = 0
    for (const uiCat of categories) {
      for (const ref of refsByUICat[uiCat] || []) {
        total++
        if (rowState(uiCat, ref, ts) === 'full') full++
      }
    }
    return total > 0 && full === total
  }

  // ── Terminar sesión ────────────────────────────────────
  async function handleFinishSession() {
    if (FINISH_REQUIRES_ALL) {
      // Modo estricto: toda la grilla (los 3 turnos) tiene que estar llena.
      const { hasPartial, hasEmpty } = validateAndCollectErrors(true)
      if (hasPartial || hasEmpty) {
        setMsg({ type: 'err', text: t('dataentry.err_finish') })
        return
      }
    } else {
      // Modo provisional: no se permiten filas a medias (parciales)…
      const { hasPartial } = validateAndCollectErrors(false)
      if (hasPartial) {
        setMsg({ type: 'err', text: t('dataentry.err_partial') })
        return
      }
      // …y hay que tener al menos UN turno entero (Mañana/Tarde/Noche).
      if (!timeslots.some(isTimeslotComplete)) {
        setMsg({ type: 'err', text: t('dataentry.err_finish_need_timeslot') })
        return
      }
    }
    // buildRows ya filtra las celdas vacías, así que en modo provisional solo
    // se guardan las filas que el HP realmente llenó (los turnos incompletos
    // no generan filas).
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
    await performSave(rowsToInsert, true)
  }

  // ── Abrir una sesión pasada para editar/agregar ───────
  function openHistorySession(s) {
    const targetUi = dbCityToUiCity[s.city] || s.city
    // Arrancar una sesión para que aparezcan Guardar/Terminar y el HP pueda
    // editar y re-guardar (el guardado es idempotente: DELETE+INSERT por
    // categoría/franja, así que re-guardar la misma fecha la actualiza).
    if (!sessionActive) {
      sessionStartRef.current = Date.now()
      setSessionActive(true)
    }
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
    targetBucket = null
  ) {
    const bucket = targetBucket ?? loadDbCity
    let obsQuery = sb
      .from('pricing_observations')
      .select(
        'category, competition_name, observed_time, distance_bracket, point_a, point_b, zone, price_without_discount, price_with_discount, recommended_price, eta_min, minimal_bid, bid_1, bid_2, bid_3, bid_4, bid_5, no_data, surge'
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
    const { data, error } = await obsQuery
    if (error) {
      setMsg({ type: 'err', text: `${t('dataentry.err_load_session')} ${error.message}` })
      return
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
    const tsByTime = {}
    for (const ts of timeslots) tsByTime[ts.start_time?.slice(0, 5)] = ts.label
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
      const tsLabel = tsByTime[(row.observed_time || '').slice(0, 5)]
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

      const rTime = (row.observed_time || '').slice(0, 5)
      const comboKey = `${row.category}${rTime}${row.distance_bracket}${row.point_a ?? ''}${row.point_b ?? ''}`
      if (!combos.has(comboKey))
        combos.set(comboKey, {
          uiCat,
          dbCat: row.category,
          time: rTime,
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
    setEntriesByCity((prev) => ({ ...prev, [bucket]: newEntries }))
    setEtaByCity((prev) => ({ ...prev, [bucket]: newEta }))
    setDiscByCity((prev) => ({ ...prev, [bucket]: newDisc }))
    setIndriveByCity((prev) => ({ ...prev, [bucket]: newIndrive }))
    setNaByCity((prev) => ({ ...prev, [bucket]: newNa }))
    setSurgeByCity((prev) => ({ ...prev, [bucket]: newSurge }))
    setLoadedCombosByCity((prev) => ({ ...prev, [bucket]: combos.size ? combos : null }))
    setErrorKeysByCity((prev) => ({ ...prev, [bucket]: new Set() }))
    setMsg({ type: 'ok', text: t('dataentry.session_loaded', { n: mapped }) })
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

  // ── Render ─────────────────────────────────────────────
  return (
    <div className="de-page">
      {/* ── Header ── */}
      <div className="de-header">
        <div className="de-header__left">
          <h1>{t('dataentry.title')}</h1>
          {sessionActive && (
            <div className="de-timer de-timer--active" title="Sesión en curso">
              ⏱ {elapsed}
            </div>
          )}
        </div>
        <div className="de-header__actions">
          {!sessionActive ? (
            <Button
              className="bg-green-600 shadow-[0_2px_6px_rgba(22,163,74,0.3)] hover:bg-green-700"
              onClick={handleStartSession}
              disabled={saving}
            >
              {t('dataentry.start_session')}
            </Button>
          ) : (
            <>
              <Button onClick={handleSaveProgress} disabled={saving}>
                {saving
                  ? t('dataentry.saving')
                  : `${t('dataentry.save_progress')}${filledCount > 0 ? ` (${filledCount})` : ''}`}
              </Button>
              <Button
                className="bg-green-800 hover:bg-green-900"
                onClick={handleFinishSession}
                disabled={saving}
              >
                {t('dataentry.end_session')}
              </Button>
            </>
          )}
        </div>
      </div>

      <InstructionsBanner t={t} />

      {/* ── Session bar ── */}
      <div className="de-session-bar">
        {/* Pestañas agrupadas por ciudad (Lima: Normal · Corp · ✈ · TukTuk) */}
        <div className="de-city-tabs">
          {cityClusters.map((cluster) => {
            const soloNormal = cluster.tabs.length === 1 && cluster.tabs[0].type === 'normal'
            return (
              <div key={cluster.base} className="de-city-cluster">
                {!soloNormal && <span className="de-cluster-name">{cluster.base}</span>}
                {cluster.tabs.map((tb) => {
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
                            setActiveTukTuk(tukTukDistricts[0] ?? '')
                          }
                        } else if (tb.type === 'airport') {
                          if (!active) {
                            setUiCity(tb.members[0].uiCity)
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
                })}
              </div>
            )
          })}
        </div>

        {/* Sub-pestañas Punto A | Punto B cuando hay un aeropuerto activo */}
        {activeAirportMembers && (
          <div className="de-airport-subtabs">
            {activeAirportMembers.map((m) => {
              const n = countAllFilled(entriesByCity[m.uiCity], indriveByCity[m.uiCity])
              return (
                <button
                  key={m.uiCity}
                  className={`de-airport-subtab${uiCity === m.uiCity ? ' active' : ''}`}
                  onClick={() => {
                    setUiCity(m.uiCity)
                    setActiveTukTuk(null)
                    setMsg(null)
                  }}
                >
                  Punto {m.side}
                  {n > 0 && <span className="de-airport-subtab-badge">{n}</span>}
                </button>
              )
            })}
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
                return (
                  <button
                    key={d}
                    className={`de-airport-subtab${activeTukTuk === d ? ' active' : ''}`}
                    onClick={() => {
                      setActiveTukTuk(d)
                      setMsg(null)
                    }}
                  >
                    {d}
                    {n > 0 && <span className="de-airport-subtab-badge">{n}</span>}
                  </button>
                )
              })
            )}
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

          {lastDraftSavedAt != null && (
            <span className="de-autosave-indicator">
              {t('dataentry.autosaved_ago', {
                s: Math.max(0, Math.floor((nowTick - lastDraftSavedAt) / 1000)),
              })}
            </span>
          )}
        </div>
      </div>

      {/* ── Status message ── */}
      {msg && (
        <div className={`de-msg${msg.type === 'ok' ? ' de-msg--ok' : ' de-msg--err'}`}>
          {msg.text}
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
          {refsByBracket.map(({ bracket, groups, extras }) => (
            <div key={bracket} className="de-bracket-section">
              {groups.map((group, gi) => (
                <BracketRouteGroup
                  key={`${bracket}-${gi}`}
                  bracket={bracket}
                  group={group}
                  categories={categories}
                  timeslots={timeslots}
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
                      timeslots={timeslots}
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
        </>
      )}
      {/* Footer repeat buttons */}
      {!blockNewSlot && !refsLoading && refs.length > 0 && (
        <div className="de-footer">
          {sessionActive ? (
            <>
              <Button onClick={handleSaveProgress} disabled={saving}>
                {saving
                  ? t('dataentry.saving')
                  : `${t('dataentry.save_progress')}${filledCount > 0 ? ` (${filledCount})` : ''}`}
              </Button>
              <Button
                className="bg-green-800 hover:bg-green-900"
                onClick={handleFinishSession}
                disabled={saving}
              >
                {t('dataentry.end_session')}
              </Button>
            </>
          ) : (
            <Button
              className="bg-green-600 shadow-[0_2px_6px_rgba(22,163,74,0.3)] hover:bg-green-700"
              onClick={handleStartSession}
              disabled={saving}
            >
              {t('dataentry.start_session')}
            </Button>
          )}
          {msg && (
            <span className={msg.type === 'ok' ? 'de-footer-ok' : 'de-footer-err'}>{msg.text}</span>
          )}
        </div>
      )}

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
                      return (
                        <tr key={s.id}>
                          <td>{start.toLocaleDateString(locale)}</td>
                          <td>
                            {s.city}
                            {s.zone ? ` · ${s.zone}` : ''}
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
                            <strong>{s.duration_minutes} min</strong>
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
