import { useMemo } from 'react'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { sb } from '../lib/supabase'
import { BRACKETS, DEFAULT_WEIGHTS, LEGACY_WEIGHTS_PE } from '../lib/constants'
import { computePeriodAvg, buildWeightsMap } from '../algorithms/weightedAverage'
import { computeDelta, getSemaforoClass } from '../algorithms/semaforo'
import { getISOYearWeek as getYearWeek, toISODate } from '../lib/dateUtils'
import { normalizeCompetitorName, toSnakeCase } from '../lib/normalize'

const ALL_TIME_SLOTS = ['early_morning', 'morning', 'midday', 'afternoon', 'evening']

function getSemaforoClassDynamic(deltaPct, bands) {
  if (deltaPct === null || deltaPct === undefined) return 'sem-none'
  if (!bands || bands.length === 0) return getSemaforoClass(deltaPct)
  const d = Number(deltaPct)
  for (const b of bands) {
    const min = b.min_pct != null ? Number(b.min_pct) : -Infinity
    const max = b.max_pct != null ? Number(b.max_pct) : Infinity
    if (d >= min && d <= max) return `sem-${b.band}`
  }
  return 'sem-red'
}

// Trae TODAS las filas de una RPC, paginando. PostgREST aplica su "Max Rows"
// (1000 por defecto, `supabase/config.toml`) también al resultado de una
// función, y lo hace SIN error: la respuesta se ve válida pero está truncada.
//
// El dashboard lo pisaba de lleno en la vista Histórica: 5 competidores × 6
// brackets × 52 semanas × surge{f,t} = 3.120 filas pedidas. Entraban las
// primeras 1.000 por el ORDER BY del RPC —Cabify y Didi— y Yango, Uber,
// InDrive y YangoComfort NO llegaban. Los KPIs "Yango WA", "Líder de mercado" y
// "Posición Yango" mostraban “—” o el líder equivocado, indistinguible de "no
// hay datos". Con el rango por defecto de 24 semanas ya son 1.440.
//
// El corte NO es "vino menos de lo que pedí": si el Max Rows del proyecto fuera
// menor que PASO, el primer chunk ya vendría corto y cortaríamos ahí. Se toma
// el tamaño del PRIMER chunk como paso efectivo del servidor y se sigue
// mientras cada página venga completa. Mismo criterio robusto que
// `fetchAllObservations`.
const PASO_RPC = 1000
const MAX_PAGINAS = 50 // 50k filas: techo de cordura, no un límite esperado

async function rpcCompleto(nombre, params) {
  const todas = []
  let paso = null

  for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
    const desde = todas.length
    const hasta = desde + (paso ?? PASO_RPC) - 1
    const { data, error } = await sb.rpc(nombre, params).range(desde, hasta)
    if (error) return { data: null, error }

    const chunk = data || []
    todas.push(...chunk)
    if (paso === null) paso = chunk.length
    if (chunk.length === 0 || paso === 0 || chunk.length < paso) break
  }

  return { data: todas, error: null }
}

export function usePricingData(filters, dbWeights, locale = 'es-PE', dbSemaforo = []) {
  const {
    country,
    dbCity,
    dbCategory,
    zone,
    surge,
    dataSource,
    viewMode,
    weekColumns,
    dailyStart,
    dailyEnd,
    timeOfDay,
  } = filters

  // Null → no filter (todas las franjas, incluyendo registros sin time_of_day)
  const timeOfDayParam = useMemo(() => {
    if (!timeOfDay || timeOfDay.length === ALL_TIME_SLOTS.length) return null
    return timeOfDay
  }, [timeOfDay])

  // ── Surge = ventanas de Rush Hour (mig 114) ──────────────────────────
  // El filtro Surge=Yes/No filtra por la columna rush_hour de cada
  // observación (pre-calculada en la BD desde observed_time + las ventanas
  // de Rush Hour, Config → Horarios → Rush Hour). Yes = la hora cae en una
  // ventana rush; No = fuera. El flag `surge` del scraper ya NO maneja el
  // filtro (se conserva solo para el drill-down). Las observaciones sin hora
  // (rush_hour NULL) quedan fuera de Yes/No y se ven solo en "Ambos".
  const rushHourParam = surge // true = Sí (en ventana), false = No, null = Ambos

  // ── Cargar datos desde Supabase (React Query) ────────────────────────
  // queryKey incluye TODOS los filtros que afectan el resultado — misma
  // key entre Dashboard/Market/Coverage/WeeklyReport con los mismos
  // filtros comparte caché real (antes cada página pagaba la query de
  // nuevo). `enabled` reemplaza el guard manual de "sin ciudad/categoría no
  // fetchear". `placeholderData: keepPreviousData` reemplaza el ref de
  // "shape anterior": mientras responde la nueva query se sigue mostrando
  // la anterior, pero el check de "Defense-in-depth" del useMemo de abajo
  // (que valida que rawRows matchea el viewMode actual) ya descarta esa
  // data vieja si la shape no matchea — mismo resultado visual que el
  // clear manual de antes, sin duplicar la lógica de detección de shape.
  const {
    data,
    isFetching,
    error: queryError,
  } = useQuery({
    queryKey: [
      'pricingData',
      viewMode,
      country,
      dbCity,
      dbCategory,
      zone,
      dataSource,
      timeOfDayParam,
      rushHourParam,
      viewMode === 'daily' ? [dailyStart, dailyEnd] : weekColumns,
    ],
    enabled: Boolean(dbCity && dbCategory),
    placeholderData: keepPreviousData,
    queryFn: async () => {
      if (viewMode === 'weekly' || viewMode === 'historic') {
        const firstWeek = weekColumns[0]
        const lastWeek = weekColumns[weekColumns.length - 1]
        const { year: y1, week: w1 } = getYearWeek(firstWeek)
        const lastDate = new Date(lastWeek)
        lastDate.setDate(lastDate.getDate() + 6)
        const { year: y2, week: w2 } = getYearWeek(lastDate)

        const [liveRes, frozenRes] = await Promise.all([
          rpcCompleto('get_dashboard_data_weekly_fast', {
            p_city: dbCity,
            p_category: dbCategory,
            p_country: country,
            p_zone: zone === 'All' ? null : zone,
            p_surge: null,
            p_week_start: w1,
            p_year_start: y1,
            p_week_end: w2,
            p_year_end: y2,
            p_data_source: dataSource,
            p_time_of_day: timeOfDayParam,
            p_rush_hour: rushHourParam,
          }),
          sb
            .from('pricing_wa_frozen')
            .select('competition_name,distance_bracket,year,week,avg_price,observation_count')
            .eq('country', country)
            .eq('city', dbCity)
            .eq('category', dbCategory)
            .gte('year', y1)
            .lte('year', y2),
        ])
        if (liveRes.error) throw liveRes.error
        if (frozenRes.error) throw frozenRes.error
        return { rawRows: liveRes.data || [], frozenRows: frozenRes.data || [] }
      }
      const { data: dailyData, error: err } = await rpcCompleto('get_dashboard_data_daily_fast', {
        p_city: dbCity,
        p_category: dbCategory,
        p_country: country,
        p_zone: zone === 'All' ? null : zone,
        p_surge: null,
        p_date_start: dailyStart,
        p_date_end: dailyEnd,
        p_data_source: dataSource,
        p_time_of_day: timeOfDayParam,
        p_rush_hour: rushHourParam,
      })
      if (err) throw err
      return { rawRows: dailyData || [], frozenRows: [] }
    },
  })

  // useMemo con identidad estable: sin esto, `data?.rawRows || []` crea un
  // array NUEVO en cada render (aunque `data` no cambie), lo que invalida
  // en cascada los useMemo de abajo que dependen de rawRows/frozenRows
  // (ver CLAUDE.md — regla de arrays/objetos con identidad estable).
  const rawRows = useMemo(() => data?.rawRows || [], [data])
  const frozenRows = useMemo(() => data?.frozenRows || [], [data])
  // isFetching (no isLoading): el hook viejo ponía loading=true en CADA
  // fetch, no solo el primero (setLoading(true) al inicio del efecto,
  // siempre) — isFetching preserva ese comportamiento exacto para no
  // cambiar la UX de los 4 consumidores (spinners/estados disabled).
  const loading = isFetching
  const error = queryError?.message || null

  // ── Construir set de semanas congeladas para indicador visual ──
  const frozenWeeks = useMemo(() => {
    const set = new Set()
    for (const r of frozenRows) {
      set.add(`${r.year}-W${String(r.week).padStart(2, '0')}`)
    }
    return set
  }, [frozenRows])

  // pricing_wa_frozen es un snapshot agregado SIN surge/franja/zona/source
  // (mig 43) — cuando hay filtros de esos activos, las semanas 🔒 muestran
  // el promedio de TODO mientras las live muestran solo lo filtrado. Este
  // flag permite avisarlo en la UI en vez de comparar peras con manzanas
  // en silencio.
  const frozenIgnoresFilters =
    frozenWeeks.size > 0 &&
    (surge != null || timeOfDayParam != null || (zone && zone !== 'All') || dataSource != null)

  // ── Índice de datos congelados: comp → periodKey → bracket → {avg_price, count} ──
  // Defense-in-depth: normalizar competition_name al indexar. Si data
  // legacy quedó en DB con variantes pegadas-sin-espacio para Corp, el
  // lookup posterior con nombres canónicos sigue matcheando.
  const frozenNested = useMemo(() => {
    const idx = {}
    for (const r of frozenRows) {
      const comp =
        normalizeCompetitorName(r.competition_name, { city: r.city }) || r.competition_name
      const pk = `${r.year}-W${String(r.week).padStart(2, '0')}`
      if (!idx[comp]) idx[comp] = {}
      if (!idx[comp][pk]) idx[comp][pk] = {}
      idx[comp][pk][r.distance_bracket] = {
        avgPrice: Number(r.avg_price),
        count: Number(r.observation_count),
      }
    }
    return idx
  }, [frozenRows])

  // ── Construir matriz de datos ───────────────────────────
  // Deps SPECIFICAS en lugar de pasar `filters` entero. Antes, cualquier cambio
  // en filters (timeOfDay, weekStart, historicFrom...) invalidaba este memo
  // aunque la matriz no dependa de esos campos. Ahora solo recomputa cuando
  // los campos efectivamente usados cambian.
  const {
    viewMode: f_viewMode,
    weekColumns: f_weekColumns,
    dbCity: f_dbCity,
    dbCategory: f_dbCategory,
    competitors: f_competitors,
    compareVs: f_compareVs,
    country: f_country,
  } = filters
  const {
    priceMatrix,
    deltaMatrix,
    semaforoMatrix,
    sampleMatrix,
    diffMatrix,
    chartData,
    deltaChartData,
    periods,
  } = useMemo(() => {
    const empty = {
      priceMatrix: {},
      deltaMatrix: {},
      semaforoMatrix: {},
      sampleMatrix: {},
      diffMatrix: {},
      chartData: {},
      deltaChartData: {},
      periods: [],
    }
    if (!rawRows.length && !frozenRows.length) {
      return empty
    }

    // Defense-in-depth: validar que rawRows matchean el viewMode actual.
    // Si están mismatched (race condition entre fetch y rerender), no
    // construimos la matriz para evitar pasar datos malformados a recharts.
    if (rawRows.length > 0) {
      const sample = rawRows[0]
      if ((f_viewMode === 'weekly' || f_viewMode === 'historic') && sample.year == null) {
        return empty
      }
      if (f_viewMode === 'daily' && !sample.observed_date) {
        return empty
      }
    }

    // Pesos para la rama PONDERADA (semanas <= 2026-W24). Desde 2026-W25 el WA
    // es promedio simple y estos pesos no se usan (ver computePeriodAvg).
    //   • Perú: pesos históricos REALES fijados en código (LEGACY_WEIGHTS_PE) —
    //     su tabla bracket_weights fue parchada a 16.6% (emergencia jul-2026), así
    //     que se ignora la BD y el histórico queda blindado ante futuros edits.
    //   • Otros países (Colombia): pesos vivos de la BD (correctos), con la cascada
    //     por (city, category) y fallback a DEFAULT_WEIGHTS.
    const weights =
      f_country === 'Peru'
        ? buildWeightsMap(LEGACY_WEIGHTS_PE, f_dbCity, f_dbCategory)
        : buildWeightsMap(dbWeights || [], f_dbCity, f_dbCategory, f_country) || DEFAULT_WEIGHTS

    // Determinar períodos (columnas)
    let periods = []
    if (f_viewMode === 'weekly' || f_viewMode === 'historic') {
      periods = f_weekColumns.map((d) => {
        const { year, week } = getYearWeek(d)
        return {
          key: `${year}-W${String(week).padStart(2, '0')}`,
          label: formatWeekLabel(d, locale),
          year,
          week,
        }
      })
    } else {
      // Rango continuo (todos los días entre dailyStart/dailyEnd), NO solo
      // las fechas que trajeron filas (auditoría 2026-07-29): con la lógica
      // vieja, un hueco real en el bot (ej. 3 días sin scrapear) hacía que
      // la columna "saltara" del 16 al 20 directo, sin ningún rastro de que
      // faltaban 3 días — indistinguible de un bug de la app. Mismo criterio
      // que la vista Semanal (f_weekColumns), que ya arma sus columnas de
      // forma continua en vez de derivarlas de la data.
      const days = []
      if (dailyStart && dailyEnd) {
        const cur = new Date(dailyStart + 'T00:00:00')
        const end = new Date(dailyEnd + 'T00:00:00')
        while (cur <= end) {
          days.push(toISODate(cur))
          cur.setDate(cur.getDate() + 1)
        }
      }
      periods = days.map((d) => ({
        key: d,
        label: formatDayLabel(d, locale),
        date: d,
      }))
    }

    // Agrupar: competitor → period → bracket → { avgPrice, count }
    // El RPC agrupa por surge (true/false/null son 3 grupos), por lo que puede
    // devolver múltiples filas por (comp, período, bracket). Combinamos con
    // promedio ponderado para que el filtro "Todos" incluya todas las surges.
    // Además normalizamos distance_bracket a snake_case lowercase como defensa
    // ante datos legados con formato inconsistente ('Short' vs 'short').
    const nested = {}
    const CANONICAL_BRACKETS = new Set([
      'very_short',
      'short',
      'median',
      'average',
      'long',
      'very_long',
    ])
    // Wrapper local: toSnakeCase del helper centralizado + strip de
    // sufijos zone-aware específicos del bot (Colombia subdivide brackets
    // por zona urbana, ej: short_zona_sur, short_a). Lógica de dominio
    // que NO vive en el helper genérico.
    const normalizeBracket = (b) => {
      if (b == null) return null
      let s = toSnakeCase(b)
      s = s.replace(/^airport_/, '')
      s = s.replace(/_(madrid|funza|mosquera|cota|chia|soacha|cajica|tenjo|sopo|sibate)$/, '')
      s = s.replace(
        /_(zona_sur|zona_norte|zona_centro|zona_este|zona_oeste|sur|norte|centro|este|oeste)$/,
        ''
      )
      s = s.replace(/_(a|b)$/, '')
      if (s === 'medium') s = 'median'
      if (CANONICAL_BRACKETS.has(s)) return s
      for (const c of ['very_short', 'very_long', 'short', 'median', 'average', 'long']) {
        if (s.startsWith(c)) return c
      }
      return null
    }
    let droppedNullBracket = 0
    for (const row of rawRows) {
      const periodKey =
        f_viewMode === 'weekly' || f_viewMode === 'historic'
          ? `${row.year}-W${String(row.week).padStart(2, '0')}`
          : row.observed_date

      const bracketKey = normalizeBracket(row.distance_bracket)
      if (!bracketKey) {
        droppedNullBracket++
        continue
      }

      // Defense-in-depth: normalizar competition_name al indexar para que
      // data legacy con variantes pegadas (YangoEconomy en city=Corp) siga
      // matcheando el lookup canónico de competitorsByDbCityCategory.
      const comp =
        normalizeCompetitorName(row.competition_name, { city: row.city }) || row.competition_name
      if (!nested[comp]) nested[comp] = {}
      if (!nested[comp][periodKey]) nested[comp][periodKey] = {}

      const existing = nested[comp][periodKey][bracketKey]
      const newPrice = Number(row.avg_price)
      const newCount = Number(row.observation_count)

      if (!existing) {
        nested[comp][periodKey][bracketKey] = {
          avgPrice: newPrice,
          count: newCount,
        }
      } else {
        const totalCount = existing.count + newCount
        const mergedAvg =
          totalCount > 0
            ? (existing.avgPrice * existing.count + newPrice * newCount) / totalCount
            : existing.avgPrice
        nested[comp][periodKey][bracketKey] = {
          avgPrice: mergedAvg,
          count: totalCount,
        }
      }
    }

    if (droppedNullBracket > 0 && rawRows.length > 0) {
      const pct = ((droppedNullBracket / rawRows.length) * 100).toFixed(1)
      console.warn(
        `[usePricingData] ${droppedNullBracket}/${rawRows.length} filas (${pct}%) descartadas por distance_bracket no canónico/null. País=${f_country}, ciudad=${f_dbCity}, categoría=${f_dbCategory}.`
      )
    }

    const competitors = f_competitors
    const priceMatrix = {}
    const deltaMatrix = {}
    const semaforoMatrix = {}
    const sampleMatrix = {}
    const diffMatrix = {}
    const chartData = {}
    const deltaChartData = {}

    // Inicializar chartData por bracket + WA
    for (const b of [...BRACKETS, '_wa']) {
      chartData[b] = []
      deltaChartData[b] = []
    }

    for (const period of periods) {
      // ISO year/week del período para el corte ponderado→simple (2026-W25+).
      // Weekly/historic ya traen year/week; daily se deriva de la fecha.
      const { year: pYear, week: pWeek } = period.year != null ? period : getYearWeek(period.date)

      // ── Paso 1: construir priceMatrix para todos los competidores ──
      for (const comp of competitors) {
        // Preferir datos congelados si existen para esta semana
        const isFrozen = frozenNested[comp]?.[period.key] != null
        const bracketData = isFrozen
          ? frozenNested[comp][period.key]
          : nested[comp]?.[period.key] || {}
        const bracketPrices = {}
        const bracketCounts = {}

        for (const b of BRACKETS) {
          bracketPrices[b] = bracketData[b]?.avgPrice ?? null
          bracketCounts[b] = bracketData[b]?.count ?? 0
        }

        const wa = computePeriodAvg(bracketPrices, weights, pYear, pWeek)

        if (!priceMatrix[comp]) priceMatrix[comp] = {}
        if (!sampleMatrix[comp]) sampleMatrix[comp] = {}

        priceMatrix[comp][period.key] = { ...bracketPrices, _wa: wa }
        sampleMatrix[comp][period.key] = { ...bracketCounts }
      }

      // ── Paso 2: calcular delta/semaforo/diff vs compareVs ──
      const baseData = priceMatrix[f_compareVs]?.[period.key] || {}
      const baseWA = baseData._wa ?? null

      for (const comp of competitors) {
        if (!deltaMatrix[comp]) deltaMatrix[comp] = {}
        if (!semaforoMatrix[comp]) semaforoMatrix[comp] = {}
        if (!diffMatrix[comp]) diffMatrix[comp] = {}

        const isBase = comp === f_compareVs
        const compData = priceMatrix[comp][period.key]
        const compWA = compData._wa ?? null

        const deltaWA = isBase ? 0 : computeDelta(compWA, baseWA)
        const diffWA = isBase ? 0 : compWA != null && baseWA != null ? compWA - baseWA : null

        const bDelta = {}
        const bSemaforo = {}
        const bDiff = {}

        for (const b of BRACKETS) {
          const compP = compData[b]
          const baseP = baseData[b] ?? null
          const d = isBase ? 0 : computeDelta(compP, baseP)
          bDelta[b] = d
          bSemaforo[b] = getSemaforoClassDynamic(d, dbSemaforo)
          bDiff[b] = isBase ? 0 : compP != null && baseP != null ? compP - baseP : null
        }

        deltaMatrix[comp][period.key] = { _wa: deltaWA, ...bDelta }
        semaforoMatrix[comp][period.key] = {
          _wa: getSemaforoClassDynamic(deltaWA, dbSemaforo),
          ...bSemaforo,
        }
        diffMatrix[comp][period.key] = { _wa: diffWA, ...bDiff }
      }

      // ── Paso 3: chartData por bracket + WA ──
      for (const b of BRACKETS) {
        const pricePoint = { period: period.label }
        const deltaPoint = { period: period.label }
        for (const comp of competitors) {
          pricePoint[comp] = priceMatrix[comp][period.key][b] ?? null
          deltaPoint[comp] = deltaMatrix[comp][period.key][b] ?? null
        }
        chartData[b].push(pricePoint)
        deltaChartData[b].push(deltaPoint)
      }

      // WA chart
      const waPricePoint = { period: period.label }
      const waDeltaPoint = { period: period.label }
      for (const comp of competitors) {
        waPricePoint[comp] = priceMatrix[comp][period.key]._wa ?? null
        waDeltaPoint[comp] = deltaMatrix[comp][period.key]._wa ?? null
      }
      chartData['_wa'].push(waPricePoint)
      deltaChartData['_wa'].push(waDeltaPoint)
    }

    return {
      priceMatrix,
      deltaMatrix,
      semaforoMatrix,
      sampleMatrix,
      diffMatrix,
      chartData,
      deltaChartData,
      periods,
    }
  }, [
    rawRows,
    frozenRows,
    dbWeights,
    dbSemaforo,
    frozenNested,
    locale,
    // Solo los campos de filters que el cálculo realmente usa:
    f_viewMode,
    f_weekColumns,
    f_dbCity,
    f_dbCategory,
    f_competitors,
    f_compareVs,
    f_country,
    dailyStart,
    dailyEnd,
  ])

  return {
    loading,
    error,
    priceMatrix,
    deltaMatrix,
    semaforoMatrix,
    sampleMatrix,
    diffMatrix,
    chartData,
    deltaChartData,
    periods,
    frozenWeeks,
    frozenIgnoresFilters,
  }
}

// ── Helpers de formato ──────────────────────────────────
function formatWeekLabel(date, locale = 'es-PE') {
  const d = new Date(date)
  return d.toLocaleDateString(locale, { month: 'short', day: 'numeric' })
}

function formatDayLabel(dateStr, locale = 'es-PE') {
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString(locale, { weekday: 'short', day: 'numeric' })
}
