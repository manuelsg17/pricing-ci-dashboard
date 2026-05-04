import { useRef, useEffect, useMemo, useState, useCallback } from 'react'
import {
  ComposedChart, Line, Area, BarChart, Bar,
  XAxis, YAxis, Tooltip,
  ResponsiveContainer, ReferenceLine, ReferenceArea, Brush,
} from 'recharts'
import { COMPETITOR_COLORS, BRACKETS } from '../../lib/constants'
import { useI18n } from '../../context/LanguageContext'
import DrillDownModal from './DrillDownModal'

const SAMPLE_LOW  = 30
const SAMPLE_MED  = 100

function sampleBg(n) {
  if (!n)              return 'transparent'
  if (n < SAMPLE_LOW)  return '#fee2e2'
  if (n < SAMPLE_MED)  return '#fef9c3'
  return '#dcfce7'
}
function sampleColor(n) {
  if (!n)              return '#94a3b8'
  if (n < SAMPLE_LOW)  return '#991b1b'
  if (n < SAMPLE_MED)  return '#854d0e'
  return '#166534'
}

const IMPACT_COLORS = { alto: '#dc2626', medio: '#d97706', bajo: '#94a3b8' }

// #4 — trend arrow: only in last column
function TrendArrow({ curr, prev }) {
  if (curr == null || prev == null) return null
  const diff = curr - prev
  if (Math.abs(diff / (prev || 1)) < 0.005) return <span style={{ color: '#94a3b8', fontSize: 9, marginLeft: 2 }}>→</span>
  return diff > 0
    ? <span style={{ color: '#dc2626', fontSize: 9, marginLeft: 2 }}>↑</span>
    : <span style={{ color: '#16a34a', fontSize: 9, marginLeft: 2 }}>↓</span>
}

// #6 — semaforo intensity scaling
function getSemaforoIntensityStyle(semClass, delta) {
  if (!delta || semClass === 'sem-none') return undefined
  const abs = Math.abs(Number(delta))
  const intensity = Math.min(abs / 20, 1)
  if (semClass === 'sem-green') {
    return {
      background: `rgba(212,237,218,${0.3 + intensity * 0.7})`,
      color: `rgb(${Math.round(21 - intensity * 5)}, ${Math.round(87 - intensity * 20)}, ${Math.round(36 - intensity * 10)})`,
    }
  }
  if (semClass === 'sem-red') {
    return {
      background: `rgba(248,215,218,${0.3 + intensity * 0.7})`,
      color: `rgb(${Math.round(114 + intensity * 30)}, ${Math.round(28 - intensity * 5)}, ${Math.round(36 - intensity * 5)})`,
    }
  }
  if (semClass === 'sem-yellow') {
    return {
      background: `rgba(255,243,205,${0.3 + intensity * 0.7})`,
      color: `rgb(${Math.round(133 + intensity * 20)}, ${Math.round(100 - intensity * 20)}, 4)`,
    }
  }
  return undefined
}

// #5 — mini sparkline SVG in competitor label
function Sparkline({ values, color = '#E53935' }) {
  const valid = values.filter(v => v != null)
  if (valid.length < 2) return null
  const min = Math.min(...valid)
  const max = Math.max(...valid)
  const range = max - min || 1
  const W = 48, H = 14
  const pts = values
    .map((v, i) => {
      if (v == null) return null
      const x = (i / (values.length - 1)) * W
      const y = H - ((v - min) / range) * (H - 2) - 1
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .filter(Boolean)
    .join(' ')

  return (
    <svg
      width={W} height={H}
      style={{ marginLeft: 5, verticalAlign: 'middle', flexShrink: 0, overflow: 'visible' }}
    >
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export default function BracketSection({
  bracket,
  label,
  competitors,
  periods,
  priceMatrix,
  deltaMatrix,
  semaforoMatrix,
  diffMatrix,
  sampleMatrix = {},
  compareVs,
  chartData,
  deltaChartData,
  events = [],
  currency = 'S/',
  semaforoBands = [],
  frozenWeeks,
  loading = false,
  viewMode = 'weekly',
  categoryLabel = '',
}) {
  const key = bracket
  const { t } = useI18n()

  const sectionRef = useRef(null)
  const priceWrapRef = useRef(null)
  const deltaWrapRef = useRef(null)
  const diffWrapRef  = useRef(null)
  const tableRef     = useRef(null)

  const [showSamples,  setShowSamples]  = useState(false)
  const [collapsed,    setCollapsed]    = useState(false)
  const [chartType,    setChartType]    = useState('line')
  const [hiddenComps,  setHiddenComps]  = useState(new Set())
  const [sortConfig,   setSortConfig]   = useState(null)
  // #41 — pin periods
  const [pinnedPeriods, setPinnedPeriods] = useState(new Set())
  // #39 — drill-down modal
  const [drillDown, setDrillDown] = useState(null) // { comp, periodKey }
  // #45 — copy feedback
  const [copyDone, setCopyDone] = useState(false)

  const getSampleCount = (comp, periodKey) => {
    const periodSamples = sampleMatrix?.[comp]?.[periodKey]
    if (!periodSamples) return 0
    if (key === '_wa') {
      return BRACKETS.reduce((sum, b) => sum + (periodSamples[b] || 0), 0)
    }
    return periodSamples[key] || 0
  }

  const summaryPeriod = useMemo(() => {
    for (let i = periods.length - 1; i >= 0; i--) {
      const total = competitors.reduce(
        (sum, comp) => sum + getSampleCount(comp, periods[i].key), 0
      )
      if (total > 0) return periods[i]
    }
    return periods[periods.length - 1] || null
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periods, competitors, sampleMatrix, key])

  const summaryPeriodKey   = summaryPeriod?.key
  const summaryPeriodLabel = summaryPeriod?.label || ''

  // #40 — sorted competitors
  const sortedCompetitors = useMemo(() => {
    if (!sortConfig) return competitors
    const { periodKey, dir } = sortConfig
    return [...competitors].sort((a, b) => {
      if (a === compareVs) return -1
      if (b === compareVs) return 1
      const va = priceMatrix[a]?.[periodKey]?.[key] ?? Infinity
      const vb = priceMatrix[b]?.[periodKey]?.[key] ?? Infinity
      return dir === 'asc' ? va - vb : vb - va
    })
  }, [competitors, sortConfig, priceMatrix, key, compareVs])

  useEffect(() => {
    if (collapsed) return
    const scrollToEnd = () => {
      [priceWrapRef, deltaWrapRef, diffWrapRef].forEach(ref => {
        if (ref.current) ref.current.scrollLeft = ref.current.scrollWidth
      })
    }
    const raf1 = requestAnimationFrame(() => requestAnimationFrame(scrollToEnd))
    window.addEventListener('resize', scrollToEnd)
    return () => { cancelAnimationFrame(raf1); window.removeEventListener('resize', scrollToEnd) }
  }, [periods, collapsed])

  // #2 — column hover via direct DOM class toggle
  const handleColEnter = useCallback((idx) => {
    const tables = tableRef.current?.querySelectorAll('.matrix-table')
    tables?.forEach(tbl => {
      tbl.querySelectorAll(`th:nth-child(${idx + 2}), td:nth-child(${idx + 2})`).forEach(el => {
        el.classList.add('col-highlighted')
      })
    })
  }, [])
  const handleColLeave = useCallback(() => {
    tableRef.current?.querySelectorAll('.col-highlighted').forEach(el => {
      el.classList.remove('col-highlighted')
    })
  }, [])

  function getPrice(comp, periodKey) { return priceMatrix[comp]?.[periodKey]?.[key] ?? null }
  function getDelta(comp, periodKey) { return deltaMatrix[comp]?.[periodKey]?.[key] ?? null }
  function getSemaforo(comp, periodKey) { return semaforoMatrix[comp]?.[periodKey]?.[key] ?? 'sem-none' }
  function getDiff(comp, periodKey) { return diffMatrix[comp]?.[periodKey]?.[key] ?? null }
  const isBase = (comp) => comp === compareVs

  // #12 — green tolerance band from semaforo config
  const greenBand = useMemo(() => semaforoBands?.find(b => b.band === 'green'), [semaforoBands])

  function compBadge(comp) {
    const color = COMPETITOR_COLORS[comp]
    if (!color) return comp
    return (
      <span style={{
        background: color, color: '#fff',
        borderRadius: 4, padding: '2px 8px',
        fontWeight: 700, fontSize: 11,
        whiteSpace: 'nowrap', letterSpacing: 0.2,
      }}>
        {comp}
      </span>
    )
  }

  // #41 — toggle pin on a period
  function togglePin(periodKey) {
    setPinnedPeriods(prev => {
      const next = new Set(prev)
      if (next.has(periodKey)) next.delete(periodKey)
      else next.add(periodKey)
      return next
    })
  }

  // #45 — copy section as image to clipboard
  async function handleCopySection() {
    try {
      const { default: html2canvas } = await import('html2canvas')
      const canvas = await html2canvas(sectionRef.current, { scale: 2, useCORS: true })
      canvas.toBlob(async blob => {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
        setCopyDone(true)
        setTimeout(() => setCopyDone(false), 2000)
      })
    } catch (e) {
      console.error('Copy failed:', e)
    }
  }

  // Chart type button bar
  function ChartTypeToggle() {
    const types = [
      { key: 'line', label: '〰' },
      { key: 'area', label: '▲' },
      { key: 'bar',  label: '▌▌' },
    ]
    return (
      <div style={{ display: 'flex', gap: 2 }}>
        {types.map(({ key: k, label }) => (
          <button
            key={k}
            type="button"
            onClick={() => setChartType(k)}
            title={t(`dashboard.chart.type_${k}`)}
            style={{
              padding: '2px 7px', fontSize: 10, fontWeight: 600,
              border: `1px solid ${chartType === k ? 'var(--color-yango)' : 'var(--color-border)'}`,
              background: chartType === k ? 'var(--color-yango-light)' : 'transparent',
              color: chartType === k ? 'var(--color-yango)' : 'var(--color-muted)',
              borderRadius: 4, cursor: 'pointer',
            }}
          >{label}</button>
        ))}
      </div>
    )
  }

  const lastPeriodIdx = periods.length - 1

  // #5 — sparkline data for each competitor (last N price values)
  function getSparkValues(comp) {
    return periods.map(p => getPrice(comp, p.key))
  }

  return (
    <div className="bracket-section" ref={sectionRef}>
      {/* Header */}
      <div className="bracket-section__title" style={{ flexWrap: 'wrap' }}>
        {/* #26 drag handle indicator */}
        <span
          title={t('dashboard.drag_reorder')}
          style={{ cursor: 'grab', opacity: 0.6, fontSize: 12, marginRight: 2, flexShrink: 0 }}
        >⠿</span>

        {/* #27 collapse toggle */}
        <button
          type="button"
          onClick={() => setCollapsed(c => !c)}
          title={t(collapsed ? 'dashboard.section.expand' : 'dashboard.section.collapse')}
          style={{
            background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.3)',
            color: '#fff', borderRadius: 4, padding: '1px 6px',
            fontSize: 10, cursor: 'pointer', fontWeight: 700, flexShrink: 0,
          }}
        >
          {collapsed ? '▼' : '▲'}
        </button>

        <span>{label}</span>

        {/* Section actions */}
        {!collapsed && (
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            {/* #45 — copy section as image */}
            <button
              type="button"
              onClick={handleCopySection}
              title={t('dashboard.copy_image')}
              style={{
                padding: '2px 8px', fontSize: 10, fontWeight: 600,
                background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.3)',
                color: '#fff', borderRadius: 4, cursor: 'pointer',
              }}
            >
              {copyDone ? t('dashboard.kpi.copy_done') : '📋'}
            </button>

            {/* Sample counts */}
            <div
              style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, textTransform: 'none', letterSpacing: 0, flexWrap: 'wrap' }}
              title={t('samples.summary_title_attr').replace('{label}', summaryPeriodLabel)}
            >
              <span style={{ color: 'rgba(255,255,255,0.75)', marginRight: 2 }}>
                n {summaryPeriodLabel}{categoryLabel ? ` · ${categoryLabel}` : ''}:
              </span>
              {competitors.map(comp => {
                const n = getSampleCount(comp, summaryPeriodKey)
                return (
                  <span
                    key={`title-${comp}`}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 4,
                      background: 'rgba(255,255,255,0.92)', color: '#1f2937',
                      padding: '1px 6px', borderRadius: 4, fontWeight: 600, fontSize: 10,
                    }}
                  >
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: COMPETITOR_COLORS[comp] || '#64748b' }} />
                    {comp}: <strong style={{ color: sampleColor(n) }}>{n}</strong>
                  </span>
                )
              })}
              <button
                type="button"
                onClick={() => setShowSamples(s => !s)}
                style={{
                  marginLeft: 4, padding: '2px 8px',
                  border: '1px solid rgba(255,255,255,0.4)', background: 'rgba(255,255,255,0.15)',
                  color: '#fff', borderRadius: 4, cursor: 'pointer', fontSize: 10, fontWeight: 600,
                }}
                title={t('samples.toggle_title')}
              >
                {showSamples ? t('samples.toggle_hide') : t('samples.toggle_show')}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Collapsible body */}
      {!collapsed && (
        <>
          {/* Samples panel */}
          {showSamples && (
            <div style={{ padding: '10px 14px', background: '#f8fafc', borderBottom: '1px solid #e2e8f0', overflowX: 'auto' }}>
              <div style={{ fontSize: 10, color: '#475569', marginBottom: 6 }}>
                <strong>{t('samples.legend_title')}</strong> {t('samples.legend_per')} —{' '}
                <span style={{ background: '#fee2e2', padding: '0 4px', borderRadius: 3 }}>&lt;{SAMPLE_LOW}</span>{' '}{t('samples.legend_low')} ·{' '}
                <span style={{ background: '#fef9c3', padding: '0 4px', borderRadius: 3 }}>{SAMPLE_LOW}–{SAMPLE_MED - 1}</span>{' '}{t('samples.legend_med')} ·{' '}
                <span style={{ background: '#dcfce7', padding: '0 4px', borderRadius: 3 }}>≥{SAMPLE_MED}</span>{' '}{t('samples.legend_high')}
              </div>
              <table className="matrix-table" style={{ fontSize: 11 }}>
                <thead>
                  <tr>
                    <th className="col-label">{t('dashboard.table.competitor')}</th>
                    {periods.map(p => (
                      <th key={p.key} style={frozenWeeks?.has(p.key) ? { background: '#eef2ff', color: '#4338ca' } : undefined}>
                        {frozenWeeks?.has(p.key) ? '🔒 ' : ''}{p.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {competitors.map(comp => (
                    <tr key={`samples-${comp}`}>
                      <td className="col-label">{compBadge(comp)}</td>
                      {periods.map(p => {
                        const n = getSampleCount(comp, p.key)
                        return (
                          <td key={p.key} style={{ background: sampleBg(n), color: sampleColor(n), fontWeight: 600, textAlign: 'center' }}>
                            {n || '—'}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* 3 tables */}
          <div className="bracket-section__tables" ref={tableRef}>

            {/* Tabla 1: Precios absolutos */}
            <div className="bracket-section__table-wrap">
              <div className="bracket-section__table-title">{t('dashboard.table.price')} {currency}</div>
              <div className="matrix-wrap" ref={priceWrapRef}>
                <table className="matrix-table">
                  <thead>
                    <tr>
                      <th className="col-label">{t('dashboard.table.competitor')}</th>
                      {periods.map((p, i) => {
                        const isPinned = pinnedPeriods.has(p.key)
                        const isFrozen = frozenWeeks?.has(p.key)
                        const isSort   = sortConfig?.periodKey === p.key
                        return (
                          <th
                            key={p.key}
                            onMouseEnter={() => handleColEnter(i)}
                            onMouseLeave={handleColLeave}
                            onClick={() => {
                              if (sortConfig?.periodKey === p.key) {
                                if (sortConfig.dir === 'asc') {
                                  setSortConfig({ periodKey: p.key, dir: 'desc' })
                                } else {
                                  setSortConfig(null)
                                }
                              } else {
                                setSortConfig({ periodKey: p.key, dir: 'asc' })
                              }
                            }}
                            style={{
                              cursor: 'pointer',
                              ...(isFrozen ? { background: '#eef2ff', color: '#4338ca' } : {}),
                              ...(isSort   ? { background: '#fef3c7' } : {}),
                              ...(isPinned ? { borderBottom: '2px solid #E53935' } : {}),
                            }}
                            title={isFrozen ? t('dashboard.frozen_period') : undefined}
                          >
                            <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3 }}>
                              {isFrozen ? '🔒 ' : ''}
                              {p.label}
                              {isSort ? (sortConfig.dir === 'asc' ? ' ↑' : ' ↓') : ''}
                              {/* #41 pin button */}
                              <button
                                type="button"
                                onClick={e => { e.stopPropagation(); togglePin(p.key) }}
                                title={isPinned ? t('dashboard.unpin_period') : t('dashboard.pin_period')}
                                style={{
                                  background: 'none', border: 'none', padding: 0,
                                  cursor: 'pointer', fontSize: 9, lineHeight: 1,
                                  opacity: isPinned ? 1 : 0.3,
                                  color: isPinned ? '#E53935' : 'inherit',
                                }}
                              >📍</button>
                            </span>
                          </th>
                        )
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedCompetitors.map(comp => (
                      <tr key={comp} className={isBase(comp) ? 'row-yango' : ''}>
                        {/* #5 — competitor label with sparkline */}
                        <td className="col-label">
                          <div style={{ display: 'flex', alignItems: 'center' }}>
                            {compBadge(comp)}
                            <Sparkline
                              values={getSparkValues(comp)}
                              color={COMPETITOR_COLORS[comp] || '#64748b'}
                            />
                          </div>
                        </td>
                        {periods.map((p, i) => {
                          const v    = getPrice(comp, p.key)
                          const prev = i > 0 ? getPrice(comp, periods[i - 1].key) : null
                          const isLast = i === lastPeriodIdx
                          return (
                            <td
                              key={p.key}
                              onClick={() => v != null && setDrillDown({ comp, periodKey: p.key })}
                              style={{ cursor: v != null ? 'pointer' : 'default' }}
                              title={v != null ? t('dashboard.drill.title') : undefined}
                            >
                              {v != null ? (
                                <>
                                  {v.toFixed(2)}
                                  {isLast && <TrendArrow curr={v} prev={prev} />}
                                </>
                              ) : loading
                                ? <span className="skel-cell" />
                                : <span className="cell-empty">—</span>
                              }
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Tabla 2: % Delta */}
            <div className="bracket-section__table-wrap">
              <div className="bracket-section__table-title">{t('dashboard.table.delta_vs')} {compareVs}</div>
              <div className="matrix-wrap" ref={deltaWrapRef}>
                <table className="matrix-table">
                  <thead>
                    <tr>
                      <th className="col-label">{t('dashboard.table.competitor')}</th>
                      {periods.map((p, i) => (
                        <th
                          key={p.key}
                          onMouseEnter={() => handleColEnter(i)}
                          onMouseLeave={handleColLeave}
                          style={frozenWeeks?.has(p.key) ? { background: '#eef2ff', color: '#4338ca' } : undefined}
                        >
                          {frozenWeeks?.has(p.key) ? '🔒 ' : ''}{p.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedCompetitors.map(comp => (
                      <tr key={comp} className={isBase(comp) ? 'row-yango' : ''}>
                        <td className="col-label">{compBadge(comp)}</td>
                        {periods.map(p => {
                          const d   = getDelta(comp, p.key)
                          const sem = getSemaforo(comp, p.key)
                          if (isBase(comp)) return <td key={p.key} className="sem-none bs-base-cell">0%</td>
                          if (d == null) return (
                            <td key={p.key} className="sem-none">
                              {loading ? <span className="skel-cell" /> : <span className="cell-empty">—</span>}
                            </td>
                          )
                          const intensityStyle = getSemaforoIntensityStyle(sem, d)
                          const sign = d >= 0 ? '+' : ''
                          return (
                            <td key={p.key} className={intensityStyle ? undefined : sem} style={intensityStyle}>
                              {sign}{d.toFixed(0)}%
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Tabla 3: Diferencia S/ */}
            <div className="bracket-section__table-wrap">
              <div className="bracket-section__table-title">{t('dashboard.table.diff')} {currency}</div>
              <div className="matrix-wrap" ref={diffWrapRef}>
                <table className="matrix-table">
                  <thead>
                    <tr>
                      <th className="col-label">{t('dashboard.table.competitor')}</th>
                      {periods.map((p, i) => (
                        <th
                          key={p.key}
                          onMouseEnter={() => handleColEnter(i)}
                          onMouseLeave={handleColLeave}
                          style={frozenWeeks?.has(p.key) ? { background: '#eef2ff', color: '#4338ca' } : undefined}
                        >
                          {frozenWeeks?.has(p.key) ? '🔒 ' : ''}{p.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedCompetitors.map(comp => (
                      <tr key={comp} className={isBase(comp) ? 'row-yango' : ''}>
                        <td className="col-label">{compBadge(comp)}</td>
                        {periods.map(p => {
                          const d = getDiff(comp, p.key)
                          if (isBase(comp)) return <td key={p.key} className="bs-base-cell">0.00</td>
                          if (d == null) return (
                            <td key={p.key}>
                              {loading ? <span className="skel-cell" /> : <span className="cell-empty">—</span>}
                            </td>
                          )
                          const sign = d >= 0 ? '+' : ''
                          const cls  = d > 0 ? 'diff-pos' : d < 0 ? 'diff-neg' : ''
                          return <td key={p.key} className={cls}>{sign}{d.toFixed(2)}</td>
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Charts */}
          <div className="bracket-section__charts">
            <MiniChart
              title={`${t('dashboard.chart.price')} ${currency}`}
              data={chartData}
              competitors={competitors}
              compareVs={compareVs}
              yFormatter={v => v.toFixed(1)}
              events={events}
              chartType={chartType}
              hiddenComps={hiddenComps}
              setHiddenComps={setHiddenComps}
              chartTypeToggle={<ChartTypeToggle />}
              syncId={`bracket-${bracket}`}
              viewMode={viewMode}
              exportName={`chart-price-${bracket}`}
            />
            <MiniChart
              title={t('dashboard.chart.delta')}
              data={deltaChartData}
              competitors={competitors}
              compareVs={compareVs}
              yFormatter={v => `${v.toFixed(0)}%`}
              isPercent
              events={events}
              chartType={chartType}
              hiddenComps={hiddenComps}
              setHiddenComps={setHiddenComps}
              greenBand={greenBand}
              syncId={`bracket-${bracket}`}
              viewMode={viewMode}
              exportName={`chart-delta-${bracket}`}
            />
          </div>
        </>
      )}

      {/* #39 — drill-down modal */}
      {drillDown && (
        <DrillDownModal
          open
          onClose={() => setDrillDown(null)}
          comp={drillDown.comp}
          periodKey={drillDown.periodKey}
          bracket={key}
          currency={currency}
          viewMode={viewMode}
        />
      )}
    </div>
  )
}

// ── MiniChart ────────────────────────────────────────────────────────────────

function MiniChart({
  title, data, competitors, compareVs,
  yFormatter, isPercent = false, events = [],
  chartType = 'line', hiddenComps, setHiddenComps,
  chartTypeToggle, greenBand, syncId,
  viewMode = 'weekly', exportName = 'chart',
}) {
  const { t } = useI18n()
  const chartCardRef = useRef(null)
  const hasData = data && data.length > 0 && competitors.some(c => data.some(d => d[c] != null))
  const periodKeys = new Set((data || []).map(d => d.period))
  const visibleComps = competitors.filter(c => !hiddenComps?.has(c))

  const toggleHide = (comp) => {
    setHiddenComps?.(prev => {
      const next = new Set(prev)
      if (next.has(comp)) next.delete(comp)
      else next.add(comp)
      return next
    })
  }

  // #43 — per-chart PNG export
  async function handleExportChart() {
    try {
      const { default: html2canvas } = await import('html2canvas')
      const canvas = await html2canvas(chartCardRef.current, { scale: 2, useCORS: true, backgroundColor: '#ffffff' })
      const link = document.createElement('a')
      link.download = `${exportName}.png`
      link.href = canvas.toDataURL()
      link.click()
    } catch (e) {
      console.error('Chart export failed:', e)
    }
  }

  function renderSeries(comp) {
    const color  = COMPETITOR_COLORS[comp] || '#999'
    const isBaseComp = comp === compareVs
    const sw     = isBaseComp ? 2.5 : 1.5

    const commonProps = {
      key: comp, type: 'monotone', dataKey: comp,
      stroke: color, strokeWidth: sw,
      connectNulls: false,
      isAnimationActive: true, animationDuration: 600, animationEasing: 'ease-out',
    }

    if (chartType === 'bar') {
      return <Bar key={comp} dataKey={comp} fill={color} radius={[2,2,0,0]} maxBarSize={12} isAnimationActive animationDuration={400} />
    }
    if (isBaseComp || chartType === 'area') {
      return (
        <Area
          {...commonProps}
          fill={color}
          fillOpacity={isBaseComp ? 0.12 : 0.06}
          dot={isBaseComp ? { r: 2 } : false}
        />
      )
    }
    return <Line {...commonProps} dot={{ r: 2 }} />
  }

  const ChartComponent = chartType === 'bar' ? BarChart : ComposedChart

  // Chart height: smaller in historic mode to leave room for Brush
  const chartHeight = viewMode === 'historic' ? 130 : 150

  return (
    <div className="chart-card" ref={chartCardRef}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6, gap: 4 }}>
        <div className="chart-card__title" style={{ margin: 0 }}>{title}</div>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          {chartTypeToggle}
          {/* #43 — per-chart export */}
          <button
            type="button"
            onClick={handleExportChart}
            title={t('dashboard.export_chart')}
            style={{
              padding: '2px 6px', fontSize: 10,
              border: '1px solid var(--color-border)',
              background: 'transparent', color: 'var(--color-muted)',
              borderRadius: 4, cursor: 'pointer',
            }}
          >📷</button>
        </div>
      </div>

      {!hasData ? (
        <div style={{ fontSize: 11, color: '#aaa', textAlign: 'center', padding: '16px 0' }}>{t('app.no_data')}</div>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={chartHeight}>
            <ChartComponent data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }} syncId={syncId}>
              <XAxis dataKey="period" tick={{ fontSize: 9 }} interval="preserveStartEnd" />
              <YAxis
                tick={{ fontSize: 9 }}
                width={isPercent ? 36 : 32}
                tickFormatter={v => v != null ? yFormatter(v) : ''}
              />
              <Tooltip
                contentStyle={{ fontSize: 11 }}
                formatter={(v, name) => {
                  if (v == null) return 'N/A'
                  return [isPercent ? `${v.toFixed(0)}%` : v.toFixed(2), name]
                }}
                labelFormatter={label => `${t('dataentry.col_date')}: ${label}`}
              />

              {/* #12 — tolerance band */}
              {isPercent && greenBand && (
                <ReferenceArea
                  y1={greenBand.min_pct ?? 0}
                  y2={greenBand.max_pct ?? 10}
                  fill="#dcfce7"
                  fillOpacity={0.35}
                  strokeOpacity={0}
                />
              )}

              {/* Market events */}
              {events.map(evt => {
                if (!periodKeys.has(evt.event_date)) return null
                return (
                  <ReferenceLine
                    key={evt.id}
                    x={evt.event_date}
                    stroke={IMPACT_COLORS[evt.impact] || '#f97316'}
                    strokeDasharray="4 2"
                    strokeWidth={1.5}
                    label={{
                      value: evt.event_type === 'huelga' ? 'H' : evt.event_type === 'lluvia' ? 'L' : '●',
                      fill: IMPACT_COLORS[evt.impact] || '#f97316',
                      fontSize: 8, fontWeight: 'bold',
                    }}
                  />
                )
              })}

              {visibleComps.map(comp => renderSeries(comp))}

              {/* #15 — Brush for historic / zoom */}
              {viewMode === 'historic' && data.length > 8 && (
                <Brush
                  dataKey="period"
                  height={18}
                  travellerWidth={6}
                  stroke="var(--color-border)"
                  fill="#f8fafc"
                  tickFormatter={() => ''}
                />
              )}
            </ChartComponent>
          </ResponsiveContainer>

          {/* #16 — clickable legend */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6, justifyContent: 'center' }}>
            {competitors.map(comp => {
              const hidden = hiddenComps?.has(comp)
              const color  = COMPETITOR_COLORS[comp] || '#999'
              return (
                <button
                  key={comp}
                  type="button"
                  onClick={() => toggleHide(comp)}
                  title={hidden ? t('dashboard.chart.show_comp') : t('dashboard.chart.hide_comp')}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 4,
                    padding: '2px 8px', borderRadius: 99,
                    border: `1px solid ${hidden ? '#e2e8f0' : color}`,
                    background: hidden ? '#f8fafc' : `${color}18`,
                    color: hidden ? '#94a3b8' : color,
                    fontSize: 10, fontWeight: 600, cursor: 'pointer',
                    opacity: hidden ? 0.5 : 1,
                    transition: 'opacity 0.15s, background 0.15s',
                  }}
                >
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: hidden ? '#d1d5db' : color }} />
                  {comp}
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
