import { useState, useEffect, useMemo, useRef } from 'react'
import { usePricingData } from '../hooks/usePricingData'
import { sb } from '../lib/supabase'
import FilterBar from '../components/dashboard/FilterBar'
import BracketSection from '../components/dashboard/BracketSection'
import AnimatedKpiValue from '../components/dashboard/AnimatedKpiValue'
import AnimatedWowBadge from '../components/dashboard/AnimatedWowBadge'

// Empty arrays estables a nivel de módulo. Sin esto, `chartData[bracket] || []`
// crearía un nuevo [] en cada render → BracketSection (ahora memoizado) se
// re-rendea aunque nada haya cambiado. Reusar la misma referencia rompe el
// patrón.
const EMPTY_ARR = Object.freeze([])

import DashboardLegend from '../components/dashboard/DashboardLegend'
import WowCallouts from '../components/dashboard/WowCallouts'
import BotCoverageCard from '../components/dashboard/BotCoverageCard'
import WhatIfSimulator from '../components/dashboard/WhatIfSimulator'
import AnomalyDigestCompact from '../components/dashboard/AnomalyDigestCompact'
import OpsAlertsPanel from '../components/dashboard/OpsAlertsPanel'
import { prettyCompetitor, rivalsOf } from '../lib/normalize'
import { useI18n } from '../context/LanguageContext'
import { useFilterContext } from '../context/FilterContext'
import { useConfigContext } from '../context/ConfigProvider'
import { BRACKETS } from '../lib/constants'
import { SIMPLE_AVG_SINCE } from '../algorithms/weightedAverage'
import { Button } from '../components/ui/shadcn/button'
import { isoWeekMonday, toISODate } from '../lib/dateUtils'
import { useDataIncidents } from '../hooks/useDataIncidents'
import { useCountry } from '../context/CountryContext'
import { SkeletonDashboard } from '../components/ui/Skeleton'
import EmptyState from '../components/ui/EmptyState'
import SectionErrorBoundary from '../components/ui/SectionErrorBoundary'
import { humanizeError } from '../lib/humanizeError'
import { escapeCsvCell } from '../lib/csvSafety'
import {
  SlidersHorizontal,
  Download,
  ChevronDown,
  ChevronUp,
  RotateCcw,
  AlertCircle,
  AlertTriangle,
  Lock,
  BarChart3,
  Loader2,
  Info,
} from 'lucide-react'
import '../styles/dashboard.css'

// Corte Ponderado→Simple: fechas derivadas de SIMPLE_AVG_SINCE (sin hardcodear,
// sin drift). Lunes de la última semana ponderada (W-1) y de la primera simple.
const WA_CUTOFF_WEIGHTED_LABEL = isoWeekMonday(
  SIMPLE_AVG_SINCE.year,
  SIMPLE_AVG_SINCE.week - 1
).toLocaleDateString('es-PE', { day: 'numeric', month: 'long', year: 'numeric' })
const WA_CUTOFF_SIMPLE_LABEL = isoWeekMonday(
  SIMPLE_AVG_SINCE.year,
  SIMPLE_AVG_SINCE.week
).toLocaleDateString('es-PE', { day: 'numeric', month: 'long', year: 'numeric' })

function DashboardContent() {
  const { countryConfig } = useCountry()
  const { filters } = useFilterContext()
  // Sprint 2.4: configs read-only desde ConfigProvider (eliminado prop drilling)
  const { weights: dbWeights, semaforo: dbSemaforo } = useConfigContext()
  const dashRef = useRef(null)
  const { t, locale } = useI18n()
  const { currency } = countryConfig
  const [filterBarVisible, setFilterBarVisible] = useState(true)

  // #26 — drag & drop section order
  const [sectionOrder, setSectionOrder] = useState(null) // null = default
  const dragBracketRef = useRef(null)

  const sections = useMemo(
    () => [
      { bracket: '_wa', label: t('bracket.weighted_average') },
      { bracket: 'very_short', label: t('bracket.very_short') },
      { bracket: 'short', label: t('bracket.short') },
      { bracket: 'median', label: t('bracket.median') },
      { bracket: 'average', label: t('bracket.average') },
      { bracket: 'long', label: t('bracket.long') },
      { bracket: 'very_long', label: t('bracket.very_long') },
    ],
    [t]
  )

  const orderedSections = useMemo(() => {
    if (!sectionOrder) return sections
    return sectionOrder.map((b) => sections.find((s) => s.bracket === b)).filter(Boolean)
  }, [sections, sectionOrder])

  function handleDragStart(e, bracket) {
    dragBracketRef.current = bracket
    e.dataTransfer.effectAllowed = 'move'
  }
  function handleDragOver(e) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }
  function handleDrop(e, bracket) {
    e.preventDefault()
    const from = dragBracketRef.current
    if (!from || from === bracket) return
    const order = sectionOrder || sections.map((s) => s.bracket)
    const fromIdx = order.indexOf(from)
    const toIdx = order.indexOf(bracket)
    const next = [...order]
    next.splice(fromIdx, 1)
    next.splice(toIdx, 0, from)
    setSectionOrder(next)
  }

  const {
    loading,
    error,
    priceMatrix: rawPriceMatrix,
    deltaMatrix: rawDeltaMatrix,
    semaforoMatrix: rawSemaforoMatrix,
    diffMatrix: rawDiffMatrix,
    sampleMatrix,
    chartData: rawChartData,
    deltaChartData: rawDeltaChartData,
    periods,
    frozenWeeks,
    frozenIgnoresFilters,
    staleWeeks,
  } = usePricingData(filters, dbWeights, locale, dbSemaforo)

  // ── Marcas de "sin data por falla del sistema" (mig 229) ────────────────
  // Precalculado UNA vez acá (comp → periodKey → motivo) y pasado a los
  // BracketSection como lookup O(1): la marca no depende del bracket, y
  // calcularla dentro de cada tabla repetiría el cruce 18 veces (§5, la
  // grilla es sensible a re-renders).
  const incidents = useDataIncidents(filters.country)
  const incidentMarks = useMemo(() => {
    if (!incidents.length || !periods.length) return null
    const marks = {}
    for (const p of periods) {
      // Rango de fechas del período: un día exacto (vista diaria) o
      // lunes→domingo ISO (semanal/histórica).
      let from, to
      if (p.date) {
        from = to = p.date
      } else {
        const monday = isoWeekMonday(p.year, p.week)
        const sunday = new Date(monday)
        sunday.setDate(monday.getDate() + 6)
        from = toISODate(monday)
        to = toISODate(sunday)
      }
      for (const inc of incidents) {
        if (inc.city && inc.city !== filters.dbCity) continue
        if (inc.date_from > to || inc.date_to < from) continue
        for (const comp of filters.competitors) {
          if (inc.competitor && inc.competitor !== comp) continue
          if (!marks[comp]) marks[comp] = {}
          // Si dos incidentes tocan la misma celda, gana el primero — con
          // un solo motivo visible alcanza para explicar el hueco.
          // Se guarda el CÓDIGO; la traducción la hace la celda con t().
          if (!marks[comp][p.key]) marks[comp][p.key] = inc.reason_code
        }
      }
    }
    return Object.keys(marks).length ? marks : null
  }, [incidents, periods, filters.dbCity, filters.competitors])

  // ── What-if simulator: aplica un % a Yango y recalcula deltas/charts ────
  const [simEnabled, setSimEnabled] = useState(false)
  const [simPct, setSimPct] = useState(0)

  // Dropdown de exportar (PNG/CSV/PDF) en la barra de herramientas
  const [exportOpen, setExportOpen] = useState(false)

  const { priceMatrix, deltaMatrix, semaforoMatrix, diffMatrix, chartData, deltaChartData } =
    useMemo(() => {
      if (!simEnabled || simPct === 0) {
        return {
          priceMatrix: rawPriceMatrix,
          deltaMatrix: rawDeltaMatrix,
          semaforoMatrix: rawSemaforoMatrix,
          diffMatrix: rawDiffMatrix,
          chartData: rawChartData,
          deltaChartData: rawDeltaChartData,
        }
      }
      const factor = 1 + simPct / 100
      const yangoComp = filters.compareVs

      // 1. Clonar priceMatrix y multiplicar Yango (compareVs)
      const newPriceMatrix = {}
      for (const comp of Object.keys(rawPriceMatrix || {})) {
        newPriceMatrix[comp] = {}
        for (const periodKey of Object.keys(rawPriceMatrix[comp])) {
          const cell = rawPriceMatrix[comp][periodKey]
          if (comp === yangoComp && cell) {
            const adj = {}
            for (const b of Object.keys(cell)) {
              adj[b] = cell[b] != null ? cell[b] * factor : null
            }
            newPriceMatrix[comp][periodKey] = adj
          } else {
            newPriceMatrix[comp][periodKey] = cell
          }
        }
      }

      // 2. Recalcular delta/diff vs compareVs
      const newDeltaMatrix = {}
      const newSemaforoMatrix = {}
      const newDiffMatrix = {}
      for (const comp of filters.competitors) {
        newDeltaMatrix[comp] = {}
        newSemaforoMatrix[comp] = {}
        newDiffMatrix[comp] = {}
        for (const p of periods) {
          const baseRow = newPriceMatrix[yangoComp]?.[p.key] || {}
          const compRow = newPriceMatrix[comp]?.[p.key] || {}
          const isBase = comp === yangoComp
          const dRow = {},
            sRow = {},
            fRow = {}
          for (const b of [...BRACKETS, '_wa']) {
            const c = compRow[b],
              y = baseRow[b]
            dRow[b] = isBase ? 0 : c != null && y != null ? ((c - y) / y) * 100 : null
            fRow[b] = isBase ? 0 : c != null && y != null ? c - y : null
            // Mantener semáforo del cálculo original — la simulación solo
            // afecta los precios, no las bandas dinámicas (evita flicker raro).
            sRow[b] = rawSemaforoMatrix?.[comp]?.[p.key]?.[b] || 'sem-none'
          }
          newDeltaMatrix[comp][p.key] = dRow
          newSemaforoMatrix[comp][p.key] = sRow
          newDiffMatrix[comp][p.key] = fRow
        }
      }

      // 3. Reconstruir chartData / deltaChartData con valores ajustados
      const newChartData = {}
      const newDeltaChartData = {}
      for (const b of [...BRACKETS, '_wa']) {
        newChartData[b] = []
        newDeltaChartData[b] = []
        for (const p of periods) {
          const pricePoint = { period: p.label }
          const deltaPoint = { period: p.label }
          for (const comp of filters.competitors) {
            pricePoint[comp] = newPriceMatrix[comp]?.[p.key]?.[b] ?? null
            deltaPoint[comp] = newDeltaMatrix[comp]?.[p.key]?.[b] ?? null
          }
          newChartData[b].push(pricePoint)
          newDeltaChartData[b].push(deltaPoint)
        }
      }

      return {
        priceMatrix: newPriceMatrix,
        deltaMatrix: newDeltaMatrix,
        semaforoMatrix: newSemaforoMatrix,
        diffMatrix: newDiffMatrix,
        chartData: newChartData,
        deltaChartData: newDeltaChartData,
      }
    }, [
      simEnabled,
      simPct,
      filters.compareVs,
      filters.competitors,
      periods,
      rawPriceMatrix,
      rawDeltaMatrix,
      rawSemaforoMatrix,
      rawDiffMatrix,
      rawChartData,
      rawDeltaChartData,
    ])

  // Market events for daily view
  const [marketEvents, setMarketEvents] = useState([])
  useEffect(() => {
    if (filters.viewMode !== 'daily') {
      setMarketEvents([])
      return
    }
    let cancelled = false
    sb.from('market_events')
      .select('id, city, event_date, event_type, impact, description')
      .eq('country', filters.country)
      .eq('city', filters.dbCity)
      .gte('event_date', filters.dailyStart)
      .lte('event_date', filters.dailyEnd)
      .order('event_date')
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) {
          setMarketEvents([])
          return
        }
        setMarketEvents(data || [])
      })
    return () => {
      cancelled = true
    }
  }, [filters.country, filters.viewMode, filters.dbCity, filters.dailyStart, filters.dailyEnd])

  // ── KPI computations ────────────────────────────────────────────────
  const kpis = useMemo(() => {
    if (!periods.length || !priceMatrix) return null
    const latestKey = periods[periods.length - 1]?.key
    if (!latestKey) return null

    const yangoComp = filters.compareVs
    const yangoWA = priceMatrix[yangoComp]?.[latestKey]?.['_wa'] ?? null

    // Sample size + bracket coverage del WA actual de Yango — para advertir
    // cuando la KPI proviene de pocos datos. sampleMatrix tiene counts por
    // bracket; un bracket "cubierto" es uno con count>0 Y price válido (>1).
    const latestPrices = priceMatrix[yangoComp]?.[latestKey] || {}
    const latestSamples = sampleMatrix[yangoComp]?.[latestKey] || {}
    let yangoSampleN = 0
    let yangoCoverage = 0
    const yangoEmptyBrackets = []
    for (const b of BRACKETS) {
      const price = latestPrices[b]
      const count = Number(latestSamples[b] || 0)
      yangoSampleN += count
      if (count > 0 && price != null && Number(price) > 1) {
        yangoCoverage++
      } else {
        yangoEmptyBrackets.push(b)
      }
    }

    // El universo de la comparación: la base + sus rivales REALES.
    //
    // `rivalsOf` saca del set a las otras marcas Yango cuando la base es Yango
    // (mismo criterio que la base con `!~~* 'Yango%'`, mig 163). Antes acá se
    // filtraba solo `!== compareVs`, así que 'YangoComfort' entraba como rival:
    // Yango podía perder el "Líder de mercado" contra sí misma, el ranking
    // contaba una posición de más, y el promedio de la competencia quedaba
    // contaminado con el precio de una marca propia.
    const rivales = new Set(rivalsOf(filters.competitors, yangoComp))
    const compPrices = filters.competitors
      .filter((c) => c === yangoComp || rivales.has(c))
      .map((c) => ({ comp: c, wa: priceMatrix[c]?.[latestKey]?.['_wa'] ?? null }))
      .filter((x) => x.wa != null)
      .sort((a, b) => a.wa - b.wa)

    const leader = compPrices[0] || null

    // Delta de Yango vs el rival más barato del período — no el promedio de
    // todos los rivales (decisión del user 2026-08-29: "vs Top" debe medir
    // qué tan lejos está Yango del competidor más agresivo en precio, no una
    // foto borrosa del mercado en general). compPrices ya viene ordenado
    // ascendente por wa, así que el primer no-Yango con precio real ES el
    // rival más barato.
    // > 0 → Yango está más caro que ese rival. < 0 → Yango está más barato.
    const rivalEntries = compPrices.filter((x) => x.comp !== yangoComp && x.wa > 0)
    const cheapestRival = rivalEntries.length > 0 ? rivalEntries[0] : null
    const yangoVsCompAvgPct =
      yangoWA != null && cheapestRival != null && cheapestRival.wa > 0
        ? ((yangoWA - cheapestRival.wa) / cheapestRival.wa) * 100
        : null
    const yangoVsCompRivalName = cheapestRival?.comp ?? null

    const lastPeriodLabel = periods[periods.length - 1]?.label || '—'
    const prevKey = periods[periods.length - 2]?.key ?? null
    const prevWA = prevKey ? (priceMatrix[yangoComp]?.[prevKey]?.['_wa'] ?? null) : null
    const wowDelta = yangoWA != null && prevWA != null ? yangoWA - prevWA : null

    // % de períodos donde Yango fue el más barato (líder)
    let yangoCheapestCount = 0
    let yangoComparablePeriods = 0
    for (const p of periods) {
      const yWa = priceMatrix[yangoComp]?.[p.key]?.['_wa']
      if (yWa == null) continue
      const others = filters.competitors
        .filter((c) => rivales.has(c))
        .map((c) => priceMatrix[c]?.[p.key]?.['_wa'])
        .filter((v) => v != null)
      if (!others.length) continue
      yangoComparablePeriods++
      if (yWa <= Math.min(...others)) yangoCheapestCount++
    }
    const yangoLeaderPct =
      yangoComparablePeriods > 0
        ? Math.round((yangoCheapestCount / yangoComparablePeriods) * 100)
        : null

    return {
      yangoWA,
      leader,
      lastPeriodLabel,
      wowDelta,
      yangoLeaderPct,
      yangoComparablePeriods,
      yangoSampleN,
      yangoCoverage,
      yangoEmptyBrackets,
      yangoVsCompAvgPct,
      yangoVsCompRivalName,
    }
  }, [periods, priceMatrix, sampleMatrix, filters.compareVs, filters.competitors])

  // ── Outlier count from recent bot_sync_log runs ──────────────────────
  const [outlierTotal, setOutlierTotal] = useState(null)
  useEffect(() => {
    let cancelled = false
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400_000).toISOString()
    sb.from('bot_sync_log')
      .select('outlier_count')
      .eq('country', filters.country)
      .gte('started_at', sevenDaysAgo)
      .then(({ data }) => {
        if (cancelled) return
        const total = (data || []).reduce((s, r) => s + (r.outlier_count || 0), 0)
        setOutlierTotal(total)
      })
    return () => {
      cancelled = true
    }
  }, [filters.country])

  // #32 — animated KPI values: viven dentro de <AnimatedKpiValue> y
  // <AnimatedWowBadge>. Antes useCountUp se llamaba acá → ~30 setState/s
  // durante 500ms forzaba el re-render del dashboard entero (charts, todas
  // las BracketSection, etc.). Aislado en sub-componentes, solo esos nodos
  // se re-renderean a 60fps.

  // ── Export PNG ────────────────────────────────────────────────────────
  async function handleExportPNG() {
    const { default: html2canvas } = await import('html2canvas')
    const canvas = await html2canvas(dashRef.current, { scale: 2, useCORS: true })
    const link = document.createElement('a')
    link.download = `dashboard-ci-${filters.dbCity}-${filters.dbCategory}.png`
    link.href = canvas.toDataURL()
    link.click()
  }

  // ── Export CSV ────────────────────────────────────────────────────────
  // Sprint 3.5: usa escapeCsvCell (lib/csvSafety.js) que además de RFC 4180
  // (quoting + escape de comillas) prefija con ' los valores que arrancan
  // con =/+/-/@/\t/\r → previene CSV formula injection si en el futuro
  // algún campo libre (note, custom label) contiene payload.
  function handleExportCSV() {
    if (!periods.length || !priceMatrix) return
    const periodLabels = periods.map((p) => p.label || p.key)
    const csvRows = [['city', 'category', 'bracket', 'competitor', ...periodLabels].join(',')]
    const allBrackets = ['_wa', ...BRACKETS]
    for (const comp of filters.competitors) {
      for (const b of allBrackets) {
        const row = [filters.dbCity, filters.dbCategory, b, comp]
        for (const p of periods) {
          const cell = priceMatrix[comp]?.[p.key]?.[b]
          const val = typeof cell === 'object' ? cell?.price : cell
          row.push(val != null ? Number(val).toFixed(2) : '')
        }
        csvRows.push(row.map(escapeCsvCell).join(','))
      }
    }
    const csv = csvRows.join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `dashboard-ci-${filters.dbCity}-${filters.dbCategory}-${new Date().toISOString().slice(0, 10)}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  // ── Export PDF ────────────────────────────────────────────────────────
  async function handleExportPDF() {
    const { default: html2canvas } = await import('html2canvas')
    const { default: jsPDF } = await import('jspdf')
    const pdf = new jsPDF('landscape', 'mm', 'a4')
    const pageW = pdf.internal.pageSize.getWidth()

    pdf.setFontSize(14)
    pdf.setTextColor(229, 57, 53)
    pdf.text(
      t('dashboard.pdf.title', { city: filters.dbCity, category: filters.dbCategory }),
      14,
      16
    )
    pdf.setFontSize(9)
    pdf.setTextColor(100, 100, 100)
    pdf.text(
      `${t('dashboard.pdf.exported_at', { date: new Date().toLocaleDateString(locale) })}  |  ${filters.viewMode}  |  ${kpis?.lastPeriodLabel || ''}`,
      14,
      22
    )

    const canvas = await html2canvas(dashRef.current, { scale: 1.5, useCORS: true })
    const imgData = canvas.toDataURL('image/jpeg', 0.85)
    const imgWidth = pageW - 28
    const imgHeight = (canvas.height / canvas.width) * imgWidth

    // Paginate if image is taller than a page
    const pageH = pdf.internal.pageSize.getHeight() - 32
    let yOffset = 0
    let pageY = 28
    let first = true
    while (yOffset < imgHeight) {
      if (!first) {
        pdf.addPage()
        pageY = 14
      }
      pdf.addImage(imgData, 'JPEG', 14, pageY, imgWidth, imgHeight, '', 'FAST', 0)
      yOffset += pageH
      pdf.setPage(pdf.internal.getNumberOfPages())
      first = false
    }

    pdf.save(
      `pricing-ci-${filters.dbCity}-${filters.dbCategory}-${new Date().toISOString().slice(0, 10)}.pdf`
    )
  }

  return (
    <div className="dashboard" ref={dashRef}>
      {/* ── Alertas operativas del watchdog del scraper (mig 227) ──
          Va PRIMERO: si el bot dejó de traer datos, eso invalida la lectura
          de todo lo que viene abajo. El panel se oculta solo cuando no hay
          alertas abiertas. */}
      <OpsAlertsPanel />

      {/* ── Anomaly digest compact (link a Mercado para detalle) ── */}
      {loading ? (
        <div className="dash-banner-skel" />
      ) : (
        periods.length > 3 && (
          <AnomalyDigestCompact
            priceMatrix={rawPriceMatrix}
            periods={periods}
            competitors={filters.competitors}
            compareVs={filters.compareVs}
          />
        )
      )}

      {/* ── What-if simulator banner ── */}
      {simEnabled && (
        <WhatIfSimulator
          pct={simPct}
          setPct={setSimPct}
          onClose={() => {
            setSimEnabled(false)
            setSimPct(0)
          }}
          compareVs={filters.compareVs}
        />
      )}

      {/* ── WoW Callouts banner ── */}
      {loading ? (
        <div className="dash-banner-skel" />
      ) : (
        periods.length > 1 && (
          <WowCallouts
            priceMatrix={priceMatrix}
            competitors={filters.competitors}
            periods={periods}
          />
        )
      )}

      {/* ── Frescura de la data del bot (semáforo + matriz ciudad×bracket) ── */}
      <BotCoverageCard />

      {/* Representatividad de la data: sacada del Dashboard el 2026-08-29 a
          pedido del user ("no entiendo cómo usarlo, no lo uso"). NO se borró:
          sigue viva en Monitoreo, que es donde corresponde una métrica de
          calidad de datos — el Dashboard es la vista que se presenta. */}

      {/* ── Barra de herramientas (acciones) + KPI Bar ── */}
      {!loading && kpis && (
        <>
          {/* Head-to-Head y Analytics removidos el 2026-08-30 a pedido del
              user ("no los uso para nada, no me dan un plus"). Los componentes
              (HeadToHeadView/AdvancedAnalyticsView) quedan en el repo
              desconectados — Vite no los incluye en el bundle si nadie los
              importa, y volver a enchufarlos es revertir este commit. */}
          <div className="dash-toolbar">
            <Button
              variant="outline"
              size="sm"
              className={
                simEnabled
                  ? 'border-yango bg-[var(--color-yango-light)] text-[var(--color-yango-dark)] hover:bg-[var(--color-yango-light)]'
                  : ''
              }
              onClick={() => setSimEnabled((s) => !s)}
              title={t('dashboard.sim.toggle_tooltip')}
            >
              <SlidersHorizontal size={14} />{' '}
              {simEnabled ? t('dashboard.sim.on') : t('dashboard.sim.toggle')}
            </Button>
            <div style={{ position: 'relative' }}>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setExportOpen((o) => !o)}
                title={t('dashboard.export_tooltip')}
              >
                <Download size={14} /> {t('dashboard.export')}{' '}
                <ChevronDown size={13} style={{ opacity: 0.6 }} />
              </Button>
              {exportOpen && (
                <>
                  <div
                    onClick={() => setExportOpen(false)}
                    style={{ position: 'fixed', inset: 0, zIndex: 199 }}
                  />
                  <div className="fb-popover fb-popover--right" style={{ minWidth: 160 }}>
                    <button
                      type="button"
                      className="fb-popover__item"
                      onClick={() => {
                        setExportOpen(false)
                        handleExportPNG()
                      }}
                      title={t('dashboard.export_png')}
                    >
                      {t('dashboard.export_png')}
                    </button>
                    <button
                      type="button"
                      className="fb-popover__item"
                      onClick={() => {
                        setExportOpen(false)
                        handleExportCSV()
                      }}
                      title={t('dashboard.export_csv_tooltip')}
                    >
                      {t('dashboard.export_csv')}
                    </button>
                    <button
                      type="button"
                      className="fb-popover__item"
                      onClick={() => {
                        setExportOpen(false)
                        handleExportPDF()
                      }}
                      title={t('dashboard.export_pdf')}
                    >
                      {t('dashboard.export_pdf')}
                    </button>
                  </div>
                </>
              )}
            </div>
            <DashboardLegend
              country={filters.country}
              dbCity={filters.dbCity}
              dbCategory={filters.dbCategory}
            />
          </div>
          <div className="kpi-bar">
            <div className="kpi-card">
              <div className="kpi-card__label">{t('dashboard.kpi.yango_wa')}</div>
              <div
                className="kpi-card__value"
                style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}
              >
                <AnimatedKpiValue target={kpis?.yangoWA ?? null} prefix={`${currency} `} />
                {/* #19 — WoW badge animado */}
                <AnimatedWowBadge target={kpis?.wowDelta ?? null} />
              </div>
              {kpis?.yangoWA != null &&
                (() => {
                  const lowN = kpis.yangoSampleN < 30
                  const lowCoverage = kpis.yangoCoverage < 4
                  const warn = lowN || lowCoverage
                  const emptyLabel = kpis.yangoEmptyBrackets?.length
                    ? ` · sin data: ${kpis.yangoEmptyBrackets.join(', ')}`
                    : ''
                  return (
                    <div
                      className="kpi-card__sub"
                      style={{
                        marginTop: 4,
                        fontSize: 11,
                        color: warn ? '#b45309' : 'var(--color-muted, #6b7280)',
                        fontWeight: warn ? 600 : 400,
                      }}
                      title={
                        `Promedio Ponderado calculado con ${kpis.yangoSampleN} observación${kpis.yangoSampleN === 1 ? '' : 'es'} ` +
                        `repartidas en ${kpis.yangoCoverage}/6 brackets.${emptyLabel}\n\n` +
                        (lowN
                          ? 'Sample size bajo (<30) — el WA tiene varianza alta semana a semana.\n'
                          : '') +
                        (lowCoverage
                          ? 'Cobertura baja (<4/6 brackets) — el WA refleja solo parte del rango de distancia, no es comparable directo con competidores de cobertura distinta.\n'
                          : '') +
                        (!warn ? 'Sample size y cobertura adecuados.' : '')
                      }
                    >
                      {warn && (
                        <AlertTriangle
                          size={11}
                          style={{ display: 'inline', verticalAlign: '-1px', marginRight: 3 }}
                        />
                      )}
                      n={kpis.yangoSampleN} · {kpis.yangoCoverage}/6 brackets
                    </div>
                  )
                })()}
            </div>
            {/* Yango vs Promedio Competencia — un solo número que responde
              "¿estoy arriba o abajo del mercado y por cuánto?" */}
            <div
              className="kpi-card"
              title={
                kpis.yangoVsCompAvgPct != null ? t('dashboard.kpi.vs_comp_avg.tooltip') : undefined
              }
            >
              <div className="kpi-card__label">{t('dashboard.kpi.vs_comp_avg')}</div>
              <div
                className="kpi-card__value"
                style={{
                  color:
                    kpis.yangoVsCompAvgPct == null
                      ? undefined
                      : Math.abs(kpis.yangoVsCompAvgPct) < 0.5
                        ? 'var(--color-muted, #6b7280)'
                        : kpis.yangoVsCompAvgPct > 0
                          ? 'var(--sem-red-fg)'
                          : 'var(--sem-green-fg)',
                }}
              >
                {kpis.yangoVsCompAvgPct == null
                  ? '—'
                  : `${kpis.yangoVsCompAvgPct > 0 ? '+' : ''}${kpis.yangoVsCompAvgPct.toFixed(1)}%`}
              </div>
              <div className="kpi-card__sub">
                {kpis.yangoVsCompAvgPct == null
                  ? ''
                  : Math.abs(kpis.yangoVsCompAvgPct) < 0.5
                    ? t('dashboard.kpi.vs_comp_avg.aligned')
                    : kpis.yangoVsCompAvgPct > 0
                      ? t('dashboard.kpi.vs_comp_avg.more_expensive', {
                          rival: prettyCompetitor(kpis.yangoVsCompRivalName),
                        })
                      : t('dashboard.kpi.vs_comp_avg.cheaper', {
                          rival: prettyCompetitor(kpis.yangoVsCompRivalName),
                        })}
              </div>
            </div>
            <div
              className={`kpi-card${kpis.leader?.comp === filters.compareVs ? ' kpi-card--highlight' : ''}`}
            >
              <div className="kpi-card__label">{t('dashboard.kpi.market_leader')}</div>
              <div className="kpi-card__value">
                {kpis.leader ? prettyCompetitor(kpis.leader.comp) : '—'}
              </div>
              <div className="kpi-card__sub">
                {kpis.leader ? `${currency} ${kpis.leader.wa.toFixed(2)}` : ''}
              </div>
            </div>
            {/* "Posición Yango" (Nº de N) removida el 2026-08-29 a pedido del
                user. El ranking crudo no se usaba: "% Yango líder" ya dice qué
                tan seguido Yango es el más barato, y "Yango vs Top" por cuánto
                queda arriba o abajo del rival más agresivo. */}
            <div className="kpi-card">
              <div className="kpi-card__label">{t('dashboard.kpi.data_as_of')}</div>
              <div className="kpi-card__value kpi-card__value--sm">{kpis.lastPeriodLabel}</div>
            </div>
            <div className="kpi-card" title={t('dashboard.kpi.leader_pct_tooltip')}>
              <div className="kpi-card__label">{t('dashboard.kpi.yango_leader_pct')}</div>
              <div className="kpi-card__value">
                {kpis.yangoLeaderPct != null ? `${kpis.yangoLeaderPct}%` : '—'}
              </div>
              <div className="kpi-card__sub">
                {kpis.yangoComparablePeriods
                  ? t('dashboard.kpi.in_n_periods', {
                      n: kpis.yangoComparablePeriods,
                      count: kpis.yangoComparablePeriods,
                    })
                  : ''}
              </div>
            </div>
            <div
              className="kpi-card"
              title={t('dashboard.kpi.outliers_tooltip')}
              style={outlierTotal && outlierTotal > 0 ? { borderColor: '#fca5a5' } : undefined}
            >
              <div className="kpi-card__label">{t('dashboard.kpi.outliers_label')}</div>
              <div
                className="kpi-card__value"
                style={{ color: outlierTotal && outlierTotal > 0 ? '#b91c1c' : undefined }}
              >
                {outlierTotal == null ? '—' : outlierTotal.toLocaleString()}
              </div>
              <div className="kpi-card__sub">{t('dashboard.kpi.outliers_sublabel')}</div>
            </div>
          </div>
        </>
      )}

      {/* ── Filter bar — sticky just below topbar ── */}
      <div className="filter-bar-wrapper">
        <div className="filter-bar-toggle">
          {sectionOrder && (
            <Button
              variant="outline"
              className="mr-auto h-auto rounded-full px-2.5 py-0.5 text-[10px] font-semibold"
              onClick={() => setSectionOrder(null)}
              title={t('dashboard.reset_order')}
            >
              <RotateCcw size={12} /> {t('dashboard.reset_order')}
            </Button>
          )}
          <Button
            variant="outline"
            className="h-auto rounded-full border-border px-2.5 py-0.5 text-[10px] font-semibold tracking-wide text-muted hover:border-yango hover:text-yango"
            onClick={() => setFilterBarVisible((v) => !v)}
            title={filterBarVisible ? t('filter.collapse') : t('filter.expand')}
          >
            <SlidersHorizontal size={12} />
            {filterBarVisible ? t('filter.collapse') : t('filter.expand')}
            {filterBarVisible ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </Button>
        </div>
        <FilterBar className={filterBarVisible ? '' : 'filter-bar--collapsed'} />
      </div>

      {/* #38 — first load skeleton */}
      {loading && periods.length === 0 && <SkeletonDashboard />}

      {error && (
        <div
          className="state-box state-box--error"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
        >
          <AlertCircle size={16} style={{ flexShrink: 0 }} /> {t('app.error')}:{' '}
          {humanizeError(error)}
        </div>
      )}

      {frozenIgnoresFilters && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            margin: '0 16px 8px',
            padding: '8px 12px',
            borderRadius: 10,
            background: '#fffdf5',
            border: '1px solid #fde9b8',
            borderLeft: '3px solid #f59e0b',
            fontSize: 12,
            color: '#78350f',
          }}
        >
          <Lock size={14} style={{ flexShrink: 0 }} /> Las semanas congeladas muestran el promedio
          de TODAS las franjas/surge/zonas — los filtros activos solo aplican a las semanas live.
        </div>
      )}

      {!loading && !error && periods.length === 0 && (
        <EmptyState
          icon={<BarChart3 size={40} strokeWidth={1.5} />}
          title={t('dashboard.no_data')}
          message={t('dashboard.empty_message_long')}
        />
      )}

      {/* #37 — stale overlay while refetching */}
      {periods.length > 0 && (
        <div style={{ position: 'relative' }}>
          {loading && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                zIndex: 10,
                background: 'rgba(255,255,255,0.55)',
                backdropFilter: 'blur(2px)',
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'center',
                paddingTop: 24,
                borderRadius: 8,
                pointerEvents: 'none',
              }}
            >
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  background: 'rgba(255,255,255,0.9)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 99,
                  padding: '4px 14px',
                  fontSize: 11,
                  fontWeight: 600,
                  color: 'var(--color-muted)',
                  boxShadow: 'var(--shadow-sm)',
                }}
              >
                <Loader2 size={13} className="animate-spin" /> {t('dashboard.updating')}
              </span>
            </div>
          )}

          {/* Aviso de metodología: hasta W24 Promedio Ponderado, desde W25 Simple. */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              margin: '0 16px 8px',
              padding: '8px 12px',
              borderRadius: 10,
              background: '#eff6ff',
              border: '1px solid #bfdbfe',
              borderLeft: '3px solid #3b82f6',
              fontSize: 12,
              color: '#1e3a8a',
            }}
          >
            <Info size={14} style={{ flexShrink: 0 }} />
            <span>
              <strong>{t('dashboard.wa_banner_weighted')}</strong>{' '}
              {t('dashboard.wa_banner_weighted_until', { date: WA_CUTOFF_WEIGHTED_LABEL })} ·{' '}
              <strong>{t('dashboard.wa_banner_simple')}</strong>{' '}
              {t('dashboard.wa_banner_simple_since', { date: WA_CUTOFF_SIMPLE_LABEL })}
            </span>
          </div>

          {/* #26 — draggable sections.
              Key incluye viewMode para forzar remount cuando se cambia
              entre weekly/daily/historic — evita el bug de recharts
              "Cannot read properties of null (reading 'dir')" causado por
              estado interno stale del chart cuando cambia la estructura
              de datos. */}
          {orderedSections.map(({ bracket, label }) => (
            <div
              key={`${bracket}-${filters.viewMode}`}
              draggable
              onDragStart={(e) => handleDragStart(e, bracket)}
              onDragOver={handleDragOver}
              onDrop={(e) => handleDrop(e, bracket)}
            >
              <SectionErrorBoundary label={label}>
                <BracketSection
                  bracket={bracket}
                  label={label}
                  currency={currency}
                  competitors={filters.competitors}
                  periods={periods}
                  priceMatrix={priceMatrix}
                  deltaMatrix={deltaMatrix}
                  semaforoMatrix={semaforoMatrix}
                  diffMatrix={diffMatrix}
                  sampleMatrix={sampleMatrix}
                  compareVs={filters.compareVs}
                  chartData={chartData[bracket] || EMPTY_ARR}
                  deltaChartData={deltaChartData[bracket] || EMPTY_ARR}
                  events={marketEvents}
                  semaforoBands={dbSemaforo}
                  frozenWeeks={frozenWeeks}
                  staleWeeks={staleWeeks}
                  incidentMarks={incidentMarks}
                  loading={loading}
                  viewMode={filters.viewMode}
                  categoryLabel={filters.dbCategory}
                />
              </SectionErrorBoundary>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// FilterProvider ahora vive en App.jsx envolviendo TODAS las pages, así los
// filtros persisten entre cambios de tab (analista no pierde Lima/Comfort
// al ir a Upload y volver). Las cascadas de useFilters dentro del provider
// resetean filtros país-específicos cuando cambia country.
// Sprint 2.4: dbWeights/dbSemaforo ahora vienen de useConfigContext() (App
// dejó de pasarlos como props).
export default function Dashboard() {
  return <DashboardContent />
}
