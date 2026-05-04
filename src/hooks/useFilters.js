import { useState, useEffect, useMemo, useRef } from 'react'
import {
  getCountryConfig,
  resolveDbParams,
  getCompetitors,
} from '../lib/constants'
import { sb } from '../lib/supabase'
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
  const countryConfig = useMemo(() => getCountryConfig(country), [country])
  const CITIES              = countryConfig.cities
  const CATEGORIES_BY_CITY  = countryConfig.categoriesByCity
  const AEROPUERTO_BY_CITY  = countryConfig.aeropuertoSubcategoriesByCity || {}
  const aeropuertoSubs = (c) => AEROPUERTO_BY_CITY[c] || countryConfig.aeropuertoSubcategories || []

  // Parse URL hash once on first render to restore saved state
  const H = useRef(readHash())

  // suppressCascades: true on mount (so hash-restored values aren't overwritten by cascade effects),
  // also set to true during applyPreset to prevent cascades from wiping applied values.
  const suppressCascades = useRef(true)

  const [city,        setCity]        = useState(() => {
    const h = H.current['city']
    return h && CITIES.includes(h) ? h : CITIES[0]
  })
  const [category,    setCategory]    = useState(() => {
    const h = H.current['cat']
    const cats = CATEGORIES_BY_CITY[H.current['city'] || CITIES[0]] || []
    return h && cats.includes(h) ? h : cats[0] || ''
  })
  const [subCategory, setSubCategory] = useState(() => H.current['sub'] || null)
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
  const [compareVs,   setCompareVs]   = useState(() => H.current['cmp'] || 'Yango')
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

  // country → reset city, category, zone
  useEffect(() => {
    if (suppressCascades.current) return
    const firstCity = CITIES[0]
    setCity(firstCity)
    const cats = CATEGORIES_BY_CITY[firstCity] || []
    setCategory(cats[0] || '')
    setSubCategory(null)
    setZone('All')
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
    const subs = aeropuertoSubs(city)
    if (category === 'Aeropuerto') {
      setSubCategory(prev => (prev && subs.includes(prev)) ? prev : subs[0])
    } else {
      setSubCategory(null)
    }
    const comps = getCompetitors(city, category, category === 'Aeropuerto' ? aeropuertoSubs(city)[0] : null, country)
    setCompareVs(comps[0] || 'Yango')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [city, category, country])

  // subCategory → update compareVs
  useEffect(() => {
    if (suppressCascades.current) return
    if (category === 'Aeropuerto' && subCategory) {
      const comps = getCompetitors(city, category, subCategory, country)
      setCompareVs(comps[0] || 'Yango')
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [city, category, subCategory, country])

  // Enable cascades after initial mount effects have run
  useEffect(() => { suppressCascades.current = false }, [])

  // Resolver parámetros de DB
  const { dbCity, dbCategory } = useMemo(
    () => resolveDbParams(city, category, subCategory, country),
    [city, category, subCategory, country]
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
  const weekColumns = useMemo(() => {
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

  const competitors = useMemo(
    () => getCompetitors(city, category, subCategory, country),
    [city, category, subCategory, country]
  )

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
    // Re-enable cascades after effects have fired for this batch
    setTimeout(() => { suppressCascades.current = false }, 150)
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
