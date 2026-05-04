import { useState, useEffect, useMemo, useRef } from 'react'
import { usePricingData }  from '../hooks/usePricingData'
import { useCountUp }      from '../hooks/useCountUp'
import { sb }              from '../lib/supabase'
import FilterBar           from '../components/dashboard/FilterBar'
import BracketSection      from '../components/dashboard/BracketSection'
import DashboardLegend     from '../components/dashboard/DashboardLegend'
import { useI18n }         from '../context/LanguageContext'
import { FilterProvider, useFilterContext } from '../context/FilterContext'
import { BRACKETS, getCountryConfig } from '../lib/constants'
import { useCountry }      from '../context/CountryContext'
import { SkeletonDashboard } from '../components/ui/Skeleton'
import EmptyState           from '../components/ui/EmptyState'
import '../styles/dashboard.css'

function DashboardContent({ dbWeights, dbSemaforo = [] }) {
  const { country, countryConfig } = useCountry()
  const { filters } = useFilterContext()
  const dashRef = useRef(null)
  const { t, locale } = useI18n()
  const { currency }  = countryConfig
  const [filterBarVisible, setFilterBarVisible] = useState(true)

  // #26 — drag & drop section order
  const defaultOrder = useMemo(() => [
    '_wa', 'very_short', 'short', 'median', 'average', 'long', 'very_long',
  ], [])
  const [sectionOrder, setSectionOrder] = useState(null) // null = default
  const dragBracketRef = useRef(null)

  const sections = useMemo(() => [
    { bracket: '_wa',        label: t('bracket.weighted_average') },
    { bracket: 'very_short', label: t('bracket.very_short') },
    { bracket: 'short',      label: t('bracket.short') },
    { bracket: 'median',     label: t('bracket.median') },
    { bracket: 'average',    label: t('bracket.average') },
    { bracket: 'long',       label: t('bracket.long') },
    { bracket: 'very_long',  label: t('bracket.very_long') },
  ], [t])

  const orderedSections = useMemo(() => {
    if (!sectionOrder) return sections
    return sectionOrder
      .map(b => sections.find(s => s.bracket === b))
      .filter(Boolean)
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
    const order = sectionOrder || sections.map(s => s.bracket)
    const fromIdx = order.indexOf(from)
    const toIdx   = order.indexOf(bracket)
    const next    = [...order]
    next.splice(fromIdx, 1)
    next.splice(toIdx, 0, from)
    setSectionOrder(next)
  }

  const {
    loading, error,
    priceMatrix, deltaMatrix, semaforoMatrix, diffMatrix, sampleMatrix,
    chartData, deltaChartData, periods, frozenWeeks,
  } = usePricingData(filters, dbWeights, locale, dbSemaforo)

  // Market events for daily view
  const [marketEvents, setMarketEvents] = useState([])
  useEffect(() => {
    if (filters.viewMode !== 'daily') { setMarketEvents([]); return }
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
        if (error) { setMarketEvents([]); return }
        setMarketEvents(data || [])
      })
    return () => { cancelled = true }
  }, [filters.country, filters.viewMode, filters.dbCity, filters.dailyStart, filters.dailyEnd])

  // ── KPI computations ────────────────────────────────────────────────
  const kpis = useMemo(() => {
    if (!periods.length || !priceMatrix) return null
    const latestKey = periods[periods.length - 1]?.key
    if (!latestKey) return null

    const yangoComp = filters.compareVs
    const yangoWA   = priceMatrix[yangoComp]?.[latestKey]?.['_wa'] ?? null

    const compPrices = filters.competitors
      .map(c => ({ comp: c, wa: priceMatrix[c]?.[latestKey]?.['_wa'] ?? null }))
      .filter(x => x.wa != null)
      .sort((a, b) => a.wa - b.wa)

    const leader   = compPrices[0] || null
    const yangoRank = yangoWA != null
      ? compPrices.findIndex(x => x.comp === yangoComp) + 1
      : null

    let totalObs = 0
    for (const comp of filters.competitors) {
      for (const b of BRACKETS) {
        const entry = priceMatrix[comp]?.[latestKey]?.[b]
        if (typeof entry === 'object' && entry?.count) totalObs += entry.count
        else if (typeof entry === 'number') totalObs++
      }
    }

    const lastPeriodLabel = periods[periods.length - 1]?.label || '—'
    const prevKey  = periods[periods.length - 2]?.key ?? null
    const prevWA   = prevKey ? (priceMatrix[yangoComp]?.[prevKey]?.['_wa'] ?? null) : null
    const wowDelta = yangoWA != null && prevWA != null ? yangoWA - prevWA : null

    return { yangoWA, leader, yangoRank, total: compPrices.length, lastPeriodLabel, wowDelta }
  }, [periods, priceMatrix, filters.compareVs, filters.competitors])

  // #32 — animated KPI values
  const animYangoWA  = useCountUp(kpis?.yangoWA  ?? null)
  const animWowDelta = useCountUp(kpis?.wowDelta ?? null)

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
  function handleExportCSV() {
    if (!periods.length || !priceMatrix) return
    const periodLabels = periods.map(p => p.label || p.key)
    const csvRows = [
      ['city', 'category', 'bracket', 'competitor', ...periodLabels].join(','),
    ]
    const allBrackets = ['_wa', ...BRACKETS]
    const escape = v => {
      if (v == null) return ''
      const s = String(v)
      return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    for (const comp of filters.competitors) {
      for (const b of allBrackets) {
        const row = [filters.dbCity, filters.dbCategory, b, comp]
        for (const p of periods) {
          const cell = priceMatrix[comp]?.[p.key]?.[b]
          const val = typeof cell === 'object' ? cell?.price : cell
          row.push(val != null ? Number(val).toFixed(2) : '')
        }
        csvRows.push(row.map(escape).join(','))
      }
    }
    const csv = csvRows.join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `dashboard-ci-${filters.dbCity}-${filters.dbCategory}-${new Date().toISOString().slice(0,10)}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  // ── Export PDF ────────────────────────────────────────────────────────
  async function handleExportPDF() {
    const { default: html2canvas } = await import('html2canvas')
    const { default: jsPDF }       = await import('jspdf')
    const pdf = new jsPDF('landscape', 'mm', 'a4')
    const pageW = pdf.internal.pageSize.getWidth()

    pdf.setFontSize(14)
    pdf.setTextColor(229, 57, 53)
    pdf.text(`Pricing CI — ${filters.dbCity} / ${filters.dbCategory}`, 14, 16)
    pdf.setFontSize(9)
    pdf.setTextColor(100, 100, 100)
    pdf.text(`Exportado: ${new Date().toLocaleDateString()}  |  ${filters.viewMode}  |  ${kpis?.lastPeriodLabel || ''}`, 14, 22)

    const canvas   = await html2canvas(dashRef.current, { scale: 1.5, useCORS: true })
    const imgData  = canvas.toDataURL('image/jpeg', 0.85)
    const imgWidth = pageW - 28
    const imgHeight = (canvas.height / canvas.width) * imgWidth

    // Paginate if image is taller than a page
    const pageH = pdf.internal.pageSize.getHeight() - 32
    let yOffset = 0
    let pageY   = 28
    let first   = true
    while (yOffset < imgHeight) {
      if (!first) { pdf.addPage(); pageY = 14 }
      pdf.addImage(imgData, 'JPEG', 14, pageY, imgWidth, imgHeight, '', 'FAST', 0)
      yOffset += pageH
      pdf.setPage(pdf.internal.getNumberOfPages())
      first = false
    }

    pdf.save(`pricing-ci-${filters.dbCity}-${filters.dbCategory}-${new Date().toISOString().slice(0,10)}.pdf`)
  }

  return (
    <div className="dashboard" ref={dashRef}>
      {/* ── KPI Bar — scrolls naturally above the sticky filter ── */}
      {!loading && kpis && (
        <div className="kpi-bar">
          <div className="kpi-card">
            <div className="kpi-card__label">{t('dashboard.kpi.yango_wa')}</div>
            <div className="kpi-card__value" style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              {animYangoWA != null ? `${currency} ${animYangoWA.toFixed(2)}` : '—'}
              {/* #19 — WoW badge */}
              {animWowDelta != null && (
                <span style={{
                  fontSize: 10, fontWeight: 700, padding: '1px 5px', borderRadius: 4,
                  background: animWowDelta > 0 ? '#fee2e2' : animWowDelta < 0 ? '#dcfce7' : '#f1f5f9',
                  color:      animWowDelta > 0 ? '#b91c1c' : animWowDelta < 0 ? '#15803d' : '#64748b',
                }}>
                  {animWowDelta > 0 ? '↑' : animWowDelta < 0 ? '↓' : '→'}{' '}
                  {animWowDelta > 0 ? '+' : ''}{animWowDelta.toFixed(2)}
                </span>
              )}
            </div>
          </div>
          <div className={`kpi-card${kpis.leader?.comp === filters.compareVs ? ' kpi-card--highlight' : ''}`}>
            <div className="kpi-card__label">{t('dashboard.kpi.market_leader')}</div>
            <div className="kpi-card__value">{kpis.leader ? kpis.leader.comp : '—'}</div>
            <div className="kpi-card__sub">
              {kpis.leader ? `${currency} ${kpis.leader.wa.toFixed(2)}` : ''}
            </div>
          </div>
          <div className="kpi-card">
            <div className="kpi-card__label">{t('dashboard.kpi.yango_position')}</div>
            <div className="kpi-card__value">
              {kpis.yangoRank != null ? `${kpis.yangoRank}º ${t('dashboard.kpi.position_of')} ${kpis.total}` : '—'}
            </div>
          </div>
          <div className="kpi-card">
            <div className="kpi-card__label">{t('dashboard.kpi.data_as_of')}</div>
            <div className="kpi-card__value kpi-card__value--sm">{kpis.lastPeriodLabel}</div>
          </div>
          <button className="kpi-export-btn" onClick={handleExportPNG} title={t('dashboard.export_png')}>
            {t('dashboard.export_png')}
          </button>
          <button className="kpi-export-btn" onClick={handleExportCSV} title="Exportar tabla a CSV">
            ⬇ CSV
          </button>
          <button className="kpi-export-btn" onClick={handleExportPDF} title={t('dashboard.export_pdf')}>
            {t('dashboard.export_pdf')}
          </button>
          <DashboardLegend
            country={filters.country}
            dbCity={filters.dbCity}
            dbCategory={filters.dbCategory}
            currency={currency}
          />
        </div>
      )}

      {/* ── Filter bar — sticky just below topbar ── */}
      <div className="filter-bar-wrapper">
        <div className="filter-bar-toggle">
          {sectionOrder && (
            <button
              className="filter-bar-toggle__btn"
              style={{ marginRight: 'auto' }}
              onClick={() => setSectionOrder(null)}
              title={t('dashboard.reset_order')}
            >
              ↺ {t('dashboard.reset_order')}
            </button>
          )}
          <button
            className="filter-bar-toggle__btn"
            onClick={() => setFilterBarVisible(v => !v)}
            title={filterBarVisible ? t('filter.collapse') : t('filter.expand')}
          >
            {filterBarVisible ? '▲' : '▼'} {filterBarVisible ? t('filter.collapse') : t('filter.expand')}
          </button>
        </div>
        <FilterBar className={filterBarVisible ? '' : 'filter-bar--collapsed'} />
      </div>

      {/* #38 — first load skeleton */}
      {loading && periods.length === 0 && <SkeletonDashboard />}

      {error && (
        <div className="state-box state-box--error">{t('app.error')}: {error}</div>
      )}

      {!loading && !error && periods.length === 0 && (
        <EmptyState
          icon="📊"
          title={t('dashboard.no_data')}
          message="No hay observaciones para los filtros seleccionados. Prueba ampliar el rango de fechas, cambiar de ciudad/categoría o sube data desde 'Cargar Data'."
        />
      )}

      {/* #37 — stale overlay while refetching */}
      {periods.length > 0 && (
        <div style={{ position: 'relative' }}>
          {loading && (
            <div style={{
              position: 'absolute', inset: 0, zIndex: 10,
              background: 'rgba(255,255,255,0.55)',
              backdropFilter: 'blur(2px)',
              display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
              paddingTop: 24, borderRadius: 8, pointerEvents: 'none',
            }}>
              <span style={{
                background: 'rgba(255,255,255,0.9)', border: '1px solid var(--color-border)',
                borderRadius: 99, padding: '4px 14px', fontSize: 11, fontWeight: 600,
                color: 'var(--color-muted)', boxShadow: 'var(--shadow-sm)',
              }}>
                {t('dashboard.updating')}
              </span>
            </div>
          )}

          {/* #26 — draggable sections */}
          {orderedSections.map(({ bracket, label }) => (
            <div
              key={bracket}
              draggable
              onDragStart={e => handleDragStart(e, bracket)}
              onDragOver={handleDragOver}
              onDrop={e => handleDrop(e, bracket)}
            >
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
                chartData={chartData[bracket] || []}
                deltaChartData={deltaChartData[bracket] || []}
                events={marketEvents}
                semaforoBands={dbSemaforo}
                frozenWeeks={frozenWeeks}
                loading={loading}
                viewMode={filters.viewMode}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function Dashboard({ dbWeights, dbSemaforo }) {
  return (
    <FilterProvider>
      <DashboardContent dbWeights={dbWeights} dbSemaforo={dbSemaforo} />
    </FilterProvider>
  )
}
