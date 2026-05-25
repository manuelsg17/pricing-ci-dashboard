import { useState, useEffect, useMemo, useRef } from 'react'
import {
  getCountryConfig,
  resolveDbParams,
  getCompetitors,
} from '../lib/constants'
import { sb } from '../lib/supabase'
import { useCountry } from '../context/CountryContext'
import { getMondayWeeksAgo, toISODate } from '../lib/dateUtils'

// ── URL hash helpers ────────────────────────────────────────────
function readHash() {
  try {
    if (!window.location.hash || window.location.hash === '#') return {}
    return Object.fromEntries(new URLSearchParams(window.location.hash.slice(1)))
  } catch { return {} }
}

function writeHash(params) {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') p.set(k, String(v))
  }
  const hash = p.toString()
  window.history.replaceState(null, '', hash ? '#' + hash : window.location.pathname)
}

export function useFilters(country) {
  // dbConfigs viene de CountryContext (cargado al boot, refrescado por live-sync).
  // Lo leemos vía ref para que los efectos cascade que ya están vinculados a
  // [country] no se re-disparen cuando dbConfigs cambie (live-sync) y reseteen
  // filtros del usuario. Los useMemo SÍ incluyen dbConfigs en deps para
  // recomputar config/competitors cuando llega data fresca.
  const { dbConfigs } = useCountry()
  const dbConfigsRef = useRef(dbConfigs)
  useEffect(() => { dbConfigsRef.current = dbConfigs }, [dbConfigs])

  const countryConfig = useMemo(
    () => getCountryConfig(country, dbConfigs),
    [country, dbConfigs]
  )
  const CITIES              = countryConfig.cities
  const CATEGORIES_BY_CITY  = countryConfig.categoriesByCity

  // Parse URL hash once on first render to restore saved state
  const H = useRef(readHash())

  // suppressCascades: true on mount (so hash-restored values aren't overwritten by cascade effects),
  // also set to true during applyPreset to prevent cascades from wiping applied values.
  const suppressCascades = useRef(true)

  // Computar la city efectiva antes de inicializar category — esto
  // evita el bug "cambio de país deja category undefined":
  //   1. Usuario en Peru, hash tiene city=Lima, cat=Economy/Comfort
  //   2. Cambia a Colombia, FilterProvider remount (key={country})
  //   3. CITIES = [Bogotá, Cali, ...] — Lima no es válida
  //   4. Antes: category inicializaba con CATEGORIES_BY_CITY['Lima']
  //      = undefined → cats=[] → category=undefined → fetch aborta
  //   5. Ahora: city se valida primero, category usa la city válida.
  const initialCity = (() => {
    const h = H.current['city']
    return h && CITIES.includes(h) ? h : CITIES[0]
  })()

  const [city,        setCity]        = useState(initialCity)
  const [category,    setCategory]    = useState(() => {
    const h = H.current['cat']
    const cats = CATEGORIES_BY_CITY[initialCity] || []
    return h && cats.includes(h) ? h : (cats[0] || '')
  })
  // subCategory: legacy state kept for filter shape compatibility (preset
  // payloads, getCompetitors/resolveDbParams signatures). Post airport-as-
  // top-level-city migration, the UI no longer surfaces a sub-category
  // picker, so this stays null in practice.
  const [subCategory, setSubCategory] = useState(null)
  const [zone,        setZone]        = useState(() => H.current['zone'] || 'All')
  const [surge,       setSurge]       = useState(() => {
    const h = H.current['surge']
    if (h === 'true') return true
    if (h === 'false') return false
    return null
  })
  const [dataSource,  setDataSource]  = useState(() => {
    const h = H.current['src']
    return (h && h !== 'all') ? h : null
  })
  // compareVs: si el hash trae 'Cabify' pero el país nuevo no lo tiene,
  // cae a 'Yango' por defecto. Sin esto, charts comparativas no renderean.
  const [compareVs,   setCompareVs]   = useState(() => {
    const h = H.current['cmp']
    if (!h) return 'Yango'
    const initialCat = (() => {
      const hc = H.current['cat']
      const cats = CATEGORIES_BY_CITY[initialCity] || []
      return hc && cats.includes(hc) ? hc : (cats[0] || '')
    })()
    const validComps = getCompetitors(initialCity, initialCat, null, country, dbConfigs)
    return validComps.includes(h) ? h : (validComps[0] || 'Yango')
  })
  const [viewMode,      setViewMode]      = useState(() => H.current['view'] || 'weekly')
  const [weekStart,     setWeekStart]     = useState(() => H.current['ws'] || toISODate(getMondayWeeksAgo(8)))
  const [dailyStart,    setDailyStart]    = useState(() => H.current['ds'] || toISODate(new Date(Date.now() - 6 * 86400000)))

  const dailyEnd = useMemo(() => {
    const d = new Date(dailyStart + 'T00:00:00')
    d.setDate(d.getDate() + 6)
    return toISODate(d)
  }, [dailyStart])

  const [historicFrom,  setHistoricFrom]  = useState(() => H.current['hf'] || toISODate(getMondayWeeksAgo(24)))
  const [historicTo,    setHistoricTo]    = useState(() => H.current['ht'] || toISODate(getMondayWeeksAgo(0)))
  const [zones,         setZones]         = useState(['All'])

  const ALL_TIME_SLOTS = ['early_morning', 'morning', 'midday', 'afternoon', 'evening']
  const [timeOfDay, setTimeOfDay] = useState(() => {
    try {
      const h = H.current['tod']
      if (h) return h.split(',').filter(s => ALL_TIME_SLOTS.includes(s))
    } catch { /* ignore */ }
    return ALL_TIME_SLOTS
  })

  // Ajustar weekStart al lunes de la semana más reciente con datos (solo si no hay hash)
  useEffect(() => {
    if (H.current['ws']) return // already set from URL hash
    sb.from('pricing_observations')
      .select('observed_date')
      .eq('country', country)
      .order('observed_date', { ascending: false })
      .limit(1)
      .then(({ data }) => {
        if (!data?.length) return
        const latest = new Date(data[0].observed_date + 'T00:00:00')
        const dayOfWeek = latest.getDay()
        const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek
        const latestMonday = new Date(latest)
        latestMonday.setDate(latest.getDate() + diffToMonday)
        const startMonday = new Date(latestMonday)
        startMonday.setDate(latestMonday.getDate() - 7 * 7)
        setWeekStart(toISODate(startMonday))
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [country])

  // ── Cascade effects (suppressed on initial mount and during applyPreset) ──

  // country → reset city, category, zone, compareVs (explicit defense-in-depth)
  useEffect(() => {
    if (suppressCascades.current) return
    const firstCity = CITIES[0]
    setCity(firstCity)
    const cats = CATEGORIES_BY_CITY[firstCity] || []
    const firstCat = cats[0] || ''
    setCategory(firstCat)
    setSubCategory(null)
    setZone('All')
    // Resetear compareVs explícitamente. Si el usuario venía con
    // compareVs='Cabify' (Perú) y cambia a Colombia donde Cabify no
    // existe, el cascade de category lo reseteará pero solo si
    // category también cambió. Reseteo explícito = garantía.
    const comps = getCompetitors(firstCity, firstCat, null, country, dbConfigsRef.current)
    setCompareVs(comps[0] || 'Yango')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [country])

  // city → reset category
  useEffect(() => {
    if (suppressCascades.current) return
    const cats = CATEGORIES_BY_CITY[city] || []
    setCategory(cats[0] || '')
    setSubCategory(null)
    setZone('All')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [city])

  // category → reset zone, compareVs, subCategory
  useEffect(() => {
    if (suppressCascades.current) return
    setZone('All')
    setSubCategory(null)
    const comps = getCompetitors(city, category, null, country, dbConfigsRef.current)
    setCompareVs(comps[0] || 'Yango')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [city, category, country])

  // Enable cascades after initial mount effects have run
  useEffect(() => { suppressCascades.current = false }, [])

  // Resolver parámetros de DB
  // dbConfigs en deps: cuando el wizard onboardea un país nuevo o un admin
  // edita country_config en otra sesión, queremos recomputar dbCity/dbCategory
  // con la data fresca. Sin esto, países wizard-creados resuelven a hardcoded.
  const { dbCity, dbCategory } = useMemo(
    () => resolveDbParams(city, category, subCategory, country, dbConfigs),
    [city, category, subCategory, country, dbConfigs]
  )

  // Cargar zonas disponibles
  useEffect(() => {
    if (!dbCity || !dbCategory) return
    let cancelled = false
    sb.rpc('get_available_zones', { p_city: dbCity, p_category: dbCategory, p_country: country })
      .then(({ data }) => {
        if (cancelled) return
        const list = ['All', ...(data || []).map(r => r.zone).filter(z => z && z !== 'All')]
        setZones(list)
      })
    return () => { cancelled = true }
  }, [country, dbCity, dbCategory])

  // Calcular rango de semanas
  const weekColumnsRaw = useMemo(() => {
    if (viewMode === 'historic') {
      const from  = new Date(historicFrom + 'T00:00:00')
      const to    = new Date(historicTo   + 'T00:00:00')
      const cols  = []
      const d     = new Date(from)
      while (d <= to && cols.length < 52) {
        cols.push(new Date(d))
        d.setDate(d.getDate() + 7)
      }
      return cols.length ? cols : [from]
    }
    const base = new Date(weekStart + 'T00:00:00')
    return Array.from({ length: 8 }, (_, i) => {
      const d = new Date(base)
      d.setDate(d.getDate() + i * 7)
      return d
    })
  }, [viewMode, weekStart, historicFrom, historicTo])

  // Estabilizar referencia: el contenido (fechas ISO) cambia raramente, pero
  // el array se reconstruye en cada cambio de cualquier dep. Usamos join('|')
  // sobre las fechas ISO para mantener la misma ref mientras el contenido no
  // cambie — evita invalidar memos downstream (usePricingData matrix, etc).
  const weekColumnsKey = weekColumnsRaw.map(d => d.toISOString()).join('|')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const weekColumns = useMemo(() => weekColumnsRaw, [weekColumnsKey])

  const competitorsRaw = useMemo(
    () => getCompetitors(city, category, subCategory, country, dbConfigs),
    [city, category, subCategory, country, dbConfigs]
  )
  // Misma estabilización de referencia para competitors.
  const competitorsKey = competitorsRaw.join('|')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const competitors = useMemo(() => competitorsRaw, [competitorsKey])

  const filters = useMemo(() => ({
    country,
    city,
    category,
    subCategory,
    dbCity,
    dbCategory,
    zone,
    surge,
    dataSource,
    compareVs,
    viewMode,
    weekStart,
    weekColumns,
    dailyStart,
    dailyEnd,
    historicFrom,
    historicTo,
    competitors,
    timeOfDay,
  }), [country, city, category, subCategory, dbCity, dbCategory, zone, surge, dataSource, compareVs, viewMode, weekStart, weekColumns, dailyStart, dailyEnd, historicFrom, historicTo, competitors, timeOfDay])

  // ── Write filter state to URL hash ──────────────────────────────────────
  useEffect(() => {
    if (suppressCascades.current) return // skip during mount / preset apply
    writeHash({
      city,
      cat:  category,
      sub:  subCategory || '',
      zone,
      surge: surge === null ? 'all' : String(surge),
      src:  dataSource || 'all',
      cmp:  compareVs,
      view: viewMode,
      ws:   viewMode === 'weekly'   ? weekStart   : '',
      ds:   viewMode === 'daily'    ? dailyStart  : '',
      hf:   viewMode === 'historic' ? historicFrom : '',
      ht:   viewMode === 'historic' ? historicTo   : '',
      tod:  timeOfDay.length === ALL_TIME_SLOTS.length ? '' : timeOfDay.join(','),
    })
  }, [city, category, subCategory, zone, surge, dataSource, compareVs, viewMode, weekStart, dailyStart, historicFrom, historicTo, timeOfDay])

  // ── Batch-apply a preset without triggering cascades ────────────────────
  function applyPreset(p) {
    suppressCascades.current = true
    if (p.city)         setCity(p.city)
    if (p.category)     setCategory(p.category)
    setSubCategory(p.subCategory || null)
    setZone(p.zone || 'All')
    setSurge(p.surge ?? null)
    setDataSource(p.dataSource || null)
    if (p.compareVs)    setCompareVs(p.compareVs)
    if (p.viewMode)     setViewMode(p.viewMode)
    if (p.weekStart)    setWeekStart(p.weekStart)
    if (p.dailyStart)   setDailyStart(p.dailyStart)
    if (p.historicFrom) setHistoricFrom(p.historicFrom)
    if (p.historicTo)   setHistoricTo(p.historicTo)
    if (p.timeOfDay)    setTimeOfDay(p.timeOfDay)
    // Re-enable cascades after React has painted this batch.
    // Two RAFs guarantees we run after all useEffect cascades for the
    // batched state updates have flushed (independent of device speed).
    requestAnimationFrame(() => {
      requestAnimationFrame(() => { suppressCascades.current = false })
    })
  }

  return {
    filters,
    zones,
    competitors,
    setCity,
    setCategory,
    setSubCategory,
    setZone,
    setSurge,
    setDataSource,
    setCompareVs,
    setViewMode,
    setWeekStart,
    setDailyStart,
    setHistoricFrom,
    setHistoricTo,
    timeOfDay,
    setTimeOfDay,
    ALL_TIME_SLOTS,
    applyPreset,
  }
}
