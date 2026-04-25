import { useState, useEffect, useMemo, useRef } from 'react'
import { usePricingData }  from '../hooks/usePricingData'
import { sb }              from '../lib/supabase'
import FilterBar           from '../components/dashboard/FilterBar'
import BracketSection      from '../components/dashboard/BracketSection'
import { useI18n }         from '../context/LanguageContext'
import { FilterProvider, useFilterContext } from '../context/FilterContext'
import { BRACKETS, getCountryConfig } from '../lib/constants'
import { useCountry }      from '../context/CountryContext'
import { SkeletonDashboard } from '../components/ui/Skeleton'
import EmptyState           from '../components/ui/EmptyState'
import '../styles/dashboard.css'

function DashboardContent({ dbWeights }) {
  const { country, countryConfig } = useCountry()
  const { filters } = useFilterContext()
  const dashRef = useRef(null)
  const { t, locale } = useI18n()
  const { currency }  = countryConfig

  const sections = useMemo(() => [
    { bracket: '_wa',        label: t('bracket.weighted_average') },
    { bracket: 'very_short', label: t('bracket.very_short') },
    { bracket: 'short',      label: t('bracket.short') },
    { bracket: 'median',     label: t('bracket.median') },
    { bracket: 'average',    label: t('bracket.average') },
    { bracket: 'long',       label: t('bracket.long') },
    { bracket: 'very_long',  label: t('bracket.very_long') },
  ], [t])

  const {
    loading, error,
    priceMatrix, deltaMatrix, semaforoMatrix, diffMatrix,
    chartData, deltaChartData, periods,
  } = usePricingData(filters, dbWeights, locale)

  // Load market events for daily view
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

    // Collect all competitor WA prices for latest period
    const compPrices = filters.competitors
      .map(c => ({ comp: c, wa: priceMatrix[c]?.[latestKey]?.['_wa'] ?? null }))
      .filter(x => x.wa != null)
      .sort((a, b) => a.wa - b.wa)

    const leader   = compPrices[0] || null
    const yangoRank = yangoWA != null
      ? compPrices.findIndex(x => x.comp === yangoComp) + 1
      : null

    // Total observations (count) for latest period across all competitors + brackets
    let totalObs = 0
    for (const comp of filters.competitors) {
      for (const b of BRACKETS) {
        const entry = priceMatrix[comp]?.[latestKey]?.[b]
        if (typeof entry === 'object' && entry?.count) totalObs += entry.count
        else if (typeof entry === 'number') totalObs++ // fallback
      }
    }

    const lastPeriodLabel = periods[periods.length - 1]?.label || '—'

    return { yangoWA, leader, yangoRank, total: compPrices.length, lastPeriodLabel }
  }, [periods, priceMatrix, filters.compareVs, filters.competitors])

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

  return (
    <div className="dashboard" ref={dashRef}>
      <FilterBar />

      {/* ── KPI Bar ── */}
      {!loading && kpis && (
        <div className="kpi-bar">
          <div className="kpi-card">
            <div className="kpi-card__label">{t('dashboard.kpi.yango_wa')}</div>
            <div className="kpi-card__value">
              {kpis.yangoWA != null ? `${currency} ${kpis.yangoWA.toFixed(2)}` : '—'}
            </div>
          </div>
          <div className={`kpi-card${kpis.leader?.comp === filters.compareVs ? ' kpi-card--highlight' : ''}`}>
            <div className="kpi-card__label">{t('dashboard.kpi.market_leader')}</div>
            <div className="kpi-card__value">
              {kpis.leader ? kpis.leader.comp : '—'}
            </div>
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
          <button className="kpi-export-btn" onClick={handleExportCSV} title="Exportar tabla a CSV" style={{ marginLeft: 6 }}>
            ⬇ CSV
          </button>
        </div>
      )}

      {loading && <SkeletonDashboard />}

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

      {!loading && periods.length > 0 && sections.map(({ bracket, label }) => (
        <BracketSection
          key={bracket}
          bracket={bracket}
          label={label}
          currency={currency}
          competitors={filters.competitors}
          periods={periods}
          priceMatrix={priceMatrix}
          deltaMatrix={deltaMatrix}
          semaforoMatrix={semaforoMatrix}
          diffMatrix={diffMatrix}
          compareVs={filters.compareVs}
          chartData={chartData[bracket] || []}
          deltaChartData={deltaChartData[bracket] || []}
          events={marketEvents}
        />
      ))}
    </div>
  )
}

export default function Dashboard({ dbWeights }) {
  return (
    <FilterProvider>
      <DashboardContent dbWeights={dbWeights} />
    </FilterProvider>
  )
}
