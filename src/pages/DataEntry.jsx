import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { sb } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { getCompetitors, resolveDbParams } from '../lib/constants'
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
    (extra) => (extra?.bids || []).some((b) => b !== '') || (extra?.minBid || '') !== ''
  )
}

import { useCountry } from '../context/CountryContext'

// ── Componente principal ───────────────────────────────────────────────────
export default function DataEntry() {
  const { session } = useAuth()
  const userEmail = session?.user?.email || ''
  const { t, locale } = useI18n()
  const { country, countryConfig, dbConfigs } = useCountry()

  const uiCities = countryConfig.cities

  const [uiCity, setUiCity] = useState(uiCities[0] || 'Lima')
  const [date, setDate] = useState(todayStr())
  const [surge, setSurge] = useState(false)
  const [refs, setRefs] = useState([])
  const [refsLoading, setRefsLoading] = useState(false)
  // Ciudad a la que pertenecen las `refs` actualmente en estado. Clave para
  // "Abrir" una sesión de OTRA ciudad: sin esto, el effect de carga corría en
  // el mismo commit con las refs de la ciudad anterior (refsLoading todavía
  // false) y mapeaba mal la data. Se setea recién cuando las refs de la ciudad
  // objetivo llegaron.
  const [refsDbCity, setRefsDbCity] = useState(null)

  // entries: key = `${uiCat}|${refId}|${tsLabel}|${comp}` → price string
  const [entries, setEntries] = useState({})
  // indriveExtra: key = `${uiCat}|${refId}|${tsLabel}` → { bids, minBid }
  const [indriveExtra, setIndriveExtra] = useState({})
  // etaEntries: key = `${uiCat}|${refId}|${tsLabel}|${comp}` → ETA en minutos
  // (string). Opcional: se captura antes del precio pero no bloquea el
  // "completado" de la fila (el guardado usa los precios). Va a eta_min.
  const [etaEntries, setEtaEntries] = useState({})
  // discEntries: key = `${uiCat}|${refId}|${tsLabel}|${comp}` → precio CON
  // descuento (string). El precio principal es el SIN descuento (entries);
  // este es un extra opcional que no bloquea el "completado". Va a
  // price_with_discount.
  const [discEntries, setDiscEntries] = useState({})
  // errorKeys: Set of price keys with error
  const [errorKeys, setErrorKeys] = useState(new Set())

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
  // el flujo normal (carga desde cero), así que no cambia ese caso.
  const [loadedCombos, setLoadedCombos] = useState(null)

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

  const categories = useMemo(
    () => countryConfig.categoriesByCity[uiCity] || [],
    [countryConfig, uiCity]
  )

  // dbCity: the DB city for the current UI city (use first non-special category)
  const { dbCity } = useMemo(
    () => resolveDbParams(uiCity, categories[0] || '', null, country, dbConfigs),
    [uiCity, categories, country, dbConfigs]
  )

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
  useEffect(() => {
    const firstCity = countryConfig.cities[0]
    setUiCity(firstCity)
    setRefs([]) // Limpiar rutas antiguas inmediatamente
    setEntries({})
    setIndriveExtra({})
    setEtaEntries({})
    setDiscEntries({})
    setLoadedCombos(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [country, countryConfig])

  // ── Load refs ──────────────────────────────────────────
  useEffect(() => {
    if (!dbCity) return
    setRefsLoading(true)
    setRefsDbCity(null) // las refs en estado ya no corresponden a `dbCity`
    setEntries({})
    setIndriveExtra({})
    setEtaEntries({})
    setDiscEntries({})
    setLoadedCombos(null)
    setErrorKeys(new Set())
    setMsg(null)
    sb.from('distance_references')
      .select('*')
      .eq('country', country)
      .eq('city', dbCity)
      .order('category')
      .order('bracket')
      .order('point_a')
      .then(({ data }) => {
        setRefs(data || [])
        setRefsDbCity(dbCity)
        setRefsLoading(false)
      })
  }, [dbCity, country])

  // ── Reset on date change ───────────────────────────────
  useEffect(() => {
    setEntries({})
    setIndriveExtra({})
    setEtaEntries({})
    setDiscEntries({})
    setLoadedCombos(null)
    setErrorKeys(new Set())
    setMsg(null)
  }, [date])

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
    loadObservationsIntoForm(pendingLoad.dbCity, pendingLoad.date)
    setPendingLoad(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingLoad, refsLoading, refsDbCity, dbCity, date, refs])

  // ── Autosave a localStorage (draft) ────────────────────
  // Clave por (country, uiCity, date). Restaura al cambiar a una clave con
  // borrador existente; persiste cada cambio con debounce 2s; limpia tras
  // guardado exitoso a Supabase (ver handleSave / handleSaveProgress).
  const draftKey = `de:draft:${country}:${uiCity}:${date}`
  const draftHydratedRef = useRef(false)
  // Indicador "guardado hace Xs" — se lee en el header (progress pill).
  const [lastDraftSavedAt, setLastDraftSavedAt] = useState(null)
  const [nowTick, setNowTick] = useState(() => Date.now())

  useEffect(() => {
    draftHydratedRef.current = false
    setLastDraftSavedAt(null)
    try {
      const raw = localStorage.getItem(draftKey)
      if (raw) {
        const parsed = JSON.parse(raw)
        const filled = countFilledEntries(parsed.entries)
        const etaFilled = countFilledEntries(parsed.etaEntries)
        const discFilled = countFilledEntries(parsed.discEntries)
        if (filled > 0 || etaFilled > 0 || discFilled > 0) {
          const { capped, avgUpdates } = capIndriveExtraBids(parsed.indriveExtra || {})
          setEntries({ ...parsed.entries, ...avgUpdates })
          setIndriveExtra(capped)
          setEtaEntries(parsed.etaEntries || {})
          setDiscEntries(parsed.discEntries || {})
          if (typeof parsed.surge === 'boolean') setSurge(parsed.surge)
          setLastDraftSavedAt(parsed.savedAt || null)
          setMsg({
            type: 'ok',
            text: `📝 Borrador restaurado (${filled} celdas).`,
          })
        }
      }
    } catch {
      /* ignore corrupt draft */
    }
    // Marcar hidratado en el siguiente tick para evitar que el effect de save
    // dispare con el estado vacío inicial antes de que cargue el draft.
    const id = setTimeout(() => {
      draftHydratedRef.current = true
    }, 0)
    return () => clearTimeout(id)
  }, [draftKey])

  useEffect(() => {
    if (!draftHydratedRef.current) return
    const id = setTimeout(() => {
      try {
        const hasData =
          countFilledEntries(entries) > 0 ||
          countFilledEntries(etaEntries) > 0 ||
          countFilledEntries(discEntries) > 0 ||
          hasMeaningfulIndriveExtra(indriveExtra)
        if (hasData) {
          const savedAt = Date.now()
          localStorage.setItem(
            draftKey,
            JSON.stringify({ entries, indriveExtra, etaEntries, discEntries, surge, savedAt })
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
  }, [entries, indriveExtra, etaEntries, discEntries, surge, draftKey])

  // Ref siempre al día con el último estado — para el flush síncrono de abajo.
  const draftSnapshotRef = useRef({ entries, indriveExtra, etaEntries, discEntries, surge })
  draftSnapshotRef.current = { entries, indriveExtra, etaEntries, discEntries, surge }

  // Flush SÍNCRONO del borrador al cambiar de ciudad/fecha o al SALIR de la
  // página (desmontar / navegar a otra sección). El autosave con debounce
  // podría no haber disparado sus últimos ~1.5s; sin este flush, cambiar de
  // pestaña o de ciudad "por casualidad" perdía las últimas celdas cargadas.
  // El cleanup corre con la clave VIEJA (closure de draftKey) y el último
  // estado (ref) ANTES de que los resets de ciudad/fecha limpien `entries`.
  useEffect(() => {
    return () => {
      try {
        const s = draftSnapshotRef.current
        const hasData =
          countFilledEntries(s.entries) > 0 ||
          countFilledEntries(s.etaEntries) > 0 ||
          countFilledEntries(s.discEntries) > 0 ||
          hasMeaningfulIndriveExtra(s.indriveExtra)
        if (hasData) {
          localStorage.setItem(
            draftKey,
            JSON.stringify({
              entries: s.entries,
              indriveExtra: s.indriveExtra,
              etaEntries: s.etaEntries,
              discEntries: s.discEntries,
              surge: s.surge,
              savedAt: Date.now(),
            })
          )
        }
      } catch {
        /* quota / disabled */
      }
    }
  }, [draftKey])

  const clearDraft = useCallback(() => {
    try {
      localStorage.removeItem(draftKey)
    } catch {}
  }, [draftKey])

  // ── Aviso del navegador si hay cambios sin guardar ─────
  useEffect(() => {
    const hasUnsaved =
      countFilledEntries(entries) > 0 ||
      countFilledEntries(etaEntries) > 0 ||
      countFilledEntries(discEntries) > 0 ||
      hasMeaningfulIndriveExtra(indriveExtra)
    if (!hasUnsaved) return
    const handler = (e) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [entries, etaEntries, discEntries, indriveExtra])

  // ── Indicador "guardado hace Xs" — ticker ──────────────
  useEffect(() => {
    if (lastDraftSavedAt == null) return
    const id = setInterval(() => setNowTick(Date.now()), 1000)
    return () => clearInterval(id)
  }, [lastDraftSavedAt])

  // ── Otro borrador sin terminar (distinta ciudad/fecha) ─
  const [otherDraft, setOtherDraft] = useState(null)

  useEffect(() => {
    if (countFilledEntries(entries) > 0) {
      setOtherDraft(null)
      return
    }
    const prefix = `de:draft:${country}:`
    let best = null
    for (let i = 0; i < localStorage.length; i++) {
      // Try/catch POR CLAVE — un borrador corrupto (ej. localStorage
      // manipulado a mano, o un JSON parcial de un crash) no debe abortar
      // el escaneo entero y esconder los demás borradores válidos.
      try {
        const k = localStorage.key(i)
        if (!k || !k.startsWith(prefix) || k === draftKey) continue
        const raw = localStorage.getItem(k)
        if (!raw) continue
        const parsed = JSON.parse(raw)
        const count = countFilledEntries(parsed?.entries)
        if (count === 0) continue
        const rest = k.slice(prefix.length) // "{city}:{date}"
        const sep = rest.lastIndexOf(':')
        if (sep === -1) continue
        const savedAt = parsed.savedAt || 0
        if (!best || savedAt > best.savedAt) {
          best = { key: k, city: rest.slice(0, sep), date: rest.slice(sep + 1), count, savedAt }
        }
      } catch {
        /* borrador corrupto en esta clave puntual — seguir con las demás */
      }
    }
    setOtherDraft(best)
    // Re-escanea solo al cambiar de vista (o cuando la vista actual queda
    // vacía), no en cada tecla — `entries` se lee en el cuerpo del efecto.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [country, draftKey])

  function jumpToOtherDraft() {
    if (!otherDraft) return
    setUiCity(otherDraft.city)
    setDate(otherDraft.date)
    setOtherDraft(null)
  }

  function discardOtherDraft() {
    if (!otherDraft) return
    try {
      localStorage.removeItem(otherDraft.key)
    } catch {
      /* ignore */
    }
    setOtherDraft(null)
  }

  // ── Group refs by UI category + bracket ───────────────
  const refsByUICat = useMemo(() => {
    const result = {}
    for (const cat of categories) result[cat] = []
    for (const ref of refs) {
      const uiCat = dbCatToUICat[ref.category]
      if (uiCat && result[uiCat]) result[uiCat].push(ref)
    }
    return result
  }, [refs, dbCatToUICat, categories])

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

  const setEntry = useCallback((uiCat, refId, tsLabel, comp, val) => {
    setEntries((prev) => ({ ...prev, [priceKey(uiCat, refId, tsLabel, comp)]: val }))
    // clear error on edit
    setErrorKeys((prev) => {
      const n = new Set(prev)
      n.delete(priceKey(uiCat, refId, tsLabel, comp))
      return n
    })
  }, [])

  const getEntry = (uiCat, refId, tsLabel, comp) =>
    entries[priceKey(uiCat, refId, tsLabel, comp)] ?? ''

  // ETA por competidor (misma clave que el precio, guardado aparte en
  // etaEntries → columna eta_min). Opcional: no cuenta para el "completado".
  const getEta = (uiCat, refId, tsLabel, comp) =>
    etaEntries[priceKey(uiCat, refId, tsLabel, comp)] ?? ''
  const setEta = useCallback((uiCat, refId, tsLabel, comp, val) => {
    setEtaEntries((prev) => ({ ...prev, [priceKey(uiCat, refId, tsLabel, comp)]: val }))
  }, [])

  // Precio CON descuento por competidor (misma clave que el precio principal,
  // guardado aparte en discEntries → columna price_with_discount). Opcional:
  // no cuenta para el "completado" de la fila.
  const getDisc = (uiCat, refId, tsLabel, comp) =>
    discEntries[priceKey(uiCat, refId, tsLabel, comp)] ?? ''
  const setDisc = useCallback((uiCat, refId, tsLabel, comp, val) => {
    setDiscEntries((prev) => ({ ...prev, [priceKey(uiCat, refId, tsLabel, comp)]: val }))
  }, [])

  const setIndrive = useCallback((uiCat, refId, tsLabel, extra, avg) => {
    setIndriveExtra((prev) => ({ ...prev, [indKey(uiCat, refId, tsLabel)]: extra }))
    setEntries((prev) => ({ ...prev, [priceKey(uiCat, refId, tsLabel, 'InDrive')]: avg }))
    setErrorKeys((prev) => {
      const n = new Set(prev)
      n.delete(priceKey(uiCat, refId, tsLabel, 'InDrive'))
      return n
    })
  }, [])

  // ── Row validation ─────────────────────────────────────
  // Returns 'empty' | 'full' | 'partial' for a (uiCat, ref, ts) row
  function rowState(uiCat, ref, ts) {
    const comps = getCompetitors(uiCity, uiCat, null, country, dbConfigs)
    const vals = comps.map((c) => entries[priceKey(uiCat, ref.id, ts.label, c)] ?? '')
    const filled = vals.filter((v) => v !== '' && !isNaN(parseFloat(v)))
    if (filled.length === 0) return 'empty'
    if (filled.length === comps.length) return 'full'
    return 'partial'
  }

  // ── Count filled ───────────────────────────────────────
  const filledCount = useMemo(() => countFilledEntries(entries), [entries])

  // ── Build rows to insert ───────────────────────────────
  function buildRows(uiCat, ref, ts) {
    const comps = getCompetitors(uiCity, uiCat, null, country, dbConfigs)
    const { year, week } = getISOYearWeek(date)
    const rush = isRushHour(ts.start_time?.slice(0, 5), dbCity) ?? false
    return comps
      .map((comp) => {
        const raw = entries[priceKey(uiCat, ref.id, ts.label, comp)] ?? ''
        const price = parseFloat(raw)
        const extra = indriveExtra[indKey(uiCat, ref.id, ts.label)]
        // Mig 136: pricing_observations vuelve a tener bid_1..bid_5 → hasta 5
        // bids. Guarda por si un borrador trajera más (nunca debería).
        const bids = comp === 'InDrive' ? (extra?.bids || []).slice(0, 5) : []
        const minBid = comp === 'InDrive' ? extra?.minBid || null : null
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
          eta: isNaN(etaNum) ? null : etaNum,
          disc: isNaN(discNum) ? null : discNum,
        }
      })
      .filter((r) => r.price !== null)
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
      price_without_discount: r.price,
      price_with_discount: r.disc ?? null,
      year: r.year,
      week: r.week,
      data_source: 'manual',
      country,
    }
    if (r.comp === 'InDrive') {
      r.bids.forEach((b, i) => {
        const n = parseFloat(b)
        if (!isNaN(n)) base[`bid_${i + 1}`] = n
      })
      const mn = parseFloat(r.minBid)
      if (!isNaN(mn)) base.minimal_bid = mn
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
      const comps = getCompetitors(uiCity, uiCat, null, country, dbConfigs)
      for (const ref of catRefs) {
        for (const ts of timeslots) {
          const state = rowState(uiCat, ref, ts)
          if (state === 'partial') {
            hasPartial = true
            // mark missing cells
            comps.forEach((comp) => {
              const v = entries[priceKey(uiCat, ref.id, ts.label, comp)] ?? ''
              if (v === '' || isNaN(parseFloat(v))) {
                newErrors.add(priceKey(uiCat, ref.id, ts.label, comp))
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
    setErrorKeys(newErrors)
    return { hasPartial, hasEmpty, errorCount: newErrors.size }
  }

  // ── Save shared logic ──────────────────────────────────
  async function performSave(rowsToInsert, isFinish = false) {
    setSaving(true)
    setMsg(null)

    // Group by (dbCat, ts) for targeted delete
    const combos = new Set(
      rowsToInsert.map(
        (r) =>
          `${resolveDbParams(uiCity, r.uiCat, null, country, dbConfigs).dbCategory}|${r.ts.start_time?.slice(0, 5)}`
      )
    )
    // Si la sesión se abrió del historial para editar, incluir también los
    // combos (categoría|franja) que se cargaron aunque ahora queden vacíos —
    // así, si el HP borra una franja/categoría entera, se elimina en BD en vez
    // de quedar huérfana (el DELETE base solo cubre lo que se re-inserta).
    if (loadedCombos) for (const c of loadedCombos) combos.add(c)
    for (const combo of combos) {
      const [cat, time] = combo.split('|')
      const { error: delErr } = await sb
        .from('pricing_observations')
        .delete()
        .eq('country', country)
        .eq('city', dbCity)
        .eq('category', cat)
        .eq('observed_date', date)
        .eq('observed_time', time)
        .eq('data_source', 'manual')
      if (delErr) {
        setMsg({ type: 'err', text: `Error al limpiar: ${delErr.message}` })
        setSaving(false)
        return false
      }
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
    }
    setSaving(false)
    return true
  }

  // ── Guardar progreso ───────────────────────────────────
  async function handleSaveProgress() {
    const { hasPartial } = validateAndCollectErrors(false)
    if (hasPartial) {
      setMsg({ type: 'err', text: t('dataentry.err_partial') })
      return
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
    setUiCity(targetUi)
    setDate(s.observed_date)
    setPendingLoad({ dbCity: s.city, date: s.observed_date })
    setMsg({ type: 'ok', text: t('dataentry.loading_session') })
  }

  // Trae las observaciones manuales de (ciudad, fecha) y las vuelca al form,
  // mapeando cada fila de BD de vuelta a (uiCat, refId, franja, competidor).
  // Las filas que no se puedan mapear (ruta borrada, franja fuera del set,
  // etc.) se saltan en silencio — nunca rompen la carga del resto.
  async function loadObservationsIntoForm(loadDbCity, loadDate) {
    const { data, error } = await sb
      .from('pricing_observations')
      .select(
        'category, competition_name, observed_time, distance_bracket, point_a, point_b, price_without_discount, price_with_discount, eta_min, minimal_bid, bid_1, bid_2, bid_3, bid_4, bid_5'
      )
      .eq('country', country)
      .eq('city', loadDbCity)
      .eq('observed_date', loadDate)
      .eq('data_source', 'manual')
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
    const combos = new Set() // (dbCategory|HH:MM) de lo que se cargó, para el DELETE al re-guardar
    let mapped = 0

    for (const row of data || []) {
      const uiCat = dbCatToUICat[row.category]
      if (!uiCat) continue
      const ref =
        refByFull[
          `${row.category}|${row.distance_bracket}|${row.point_a ?? ''}|${row.point_b ?? ''}`
        ] || refByCatBracket[`${row.category}|${row.distance_bracket}`]
      if (!ref) continue
      const tsLabel = tsByTime[(row.observed_time || '').slice(0, 5)]
      if (!tsLabel) continue

      if (!compMapByCat[uiCat]) {
        const map = {}
        for (const c of getCompetitors(uiCity, uiCat, null, country, dbConfigs)) {
          map[normalizeCompetitorName(c, { city: loadDbCity })] = c
        }
        compMapByCat[uiCat] = map
      }
      const comp = compMapByCat[uiCat][row.competition_name] || row.competition_name

      combos.add(`${row.category}|${(row.observed_time || '').slice(0, 5)}`)
      const k = priceKey(uiCat, ref.id, tsLabel, comp)
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
        }
      }
      mapped++
    }

    setEntries(newEntries)
    setEtaEntries(newEta)
    setDiscEntries(newDisc)
    setIndriveExtra(newIndrive)
    setLoadedCombos(combos.size ? combos : null)
    setErrorKeys(new Set())
    setMsg({ type: 'ok', text: t('dataentry.session_loaded', { n: mapped }) })
  }

  // ── Total expected rows ────────────────────────────────
  const totalExpected = useMemo(() => {
    let n = 0
    for (const uiCat of categories) {
      const catRefs = refsByUICat[uiCat] || []
      const comps = getCompetitors(uiCity, uiCat, null, country, dbConfigs)
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
              <Button onClick={handleSaveProgress} disabled={saving || filledCount === 0}>
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
        {/* City tabs */}
        <div className="de-city-tabs">
          {uiCities.map((c) => (
            <button
              key={c}
              className={`de-city-tab${uiCity === c ? ' active' : ''}`}
              onClick={() => {
                setUiCity(c)
                setMsg(null)
              }}
            >
              {c}
            </button>
          ))}
        </div>

        <div className="de-session-controls">
          <label className="de-ctrl">
            <span>{t('dataentry.date')}</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>

          <label className="de-ctrl de-ctrl--surge">
            <input type="checkbox" checked={surge} onChange={(e) => setSurge(e.target.checked)} />
            <span>Surge</span>
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

      {/* ── Borrador sin terminar en otra ciudad/fecha ── */}
      {otherDraft && (
        <div className="de-msg de-msg--ok de-other-draft">
          <span>
            {t('dataentry.other_draft_note', {
              city: otherDraft.city,
              date: otherDraft.date,
              n: otherDraft.count,
            })}
          </span>
          <span className="de-other-draft-actions">
            <Button size="sm" onClick={jumpToOtherDraft}>
              {t('dataentry.other_draft_jump')}
            </Button>
            <Button size="sm" variant="outline" onClick={discardOtherDraft}>
              {t('dataentry.other_draft_discard')}
            </Button>
          </span>
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
      {refsLoading ? (
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
                  t={t}
                />
              ))}
              {extras.length > 0 && (
                <div className="de-bracket-extras">
                  <div className="de-bracket-extras-title">{t('dataentry.extra_routes_title')}</div>
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
      {!refsLoading && refs.length > 0 && (
        <div className="de-footer">
          {sessionActive ? (
            <>
              <Button onClick={handleSaveProgress} disabled={saving || filledCount === 0}>
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
                          <td>{s.city}</td>
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
