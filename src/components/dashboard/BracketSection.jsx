import { useRef, useEffect, useMemo, useState } from 'react'
import {
  ComposedChart, LineChart, Line, Area, BarChart, Bar,
  XAxis, YAxis, Tooltip, Legend,
  ResponsiveContainer, ReferenceLine, ReferenceArea,
} from 'recharts'
import { COMPETITOR_COLORS, BRACKETS } from '../../lib/constants'
import { useI18n } from '../../context/LanguageContext'

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

// #4 — trend arrow: compares last value to second-last
function TrendArrow({ curr, prev }) {
  if (curr == null || prev == null) return null
  const diff = curr - prev
  if (Math.abs(diff / (prev || 1)) < 0.005) return <span style={{ color: '#94a3b8', fontSize: 9, marginLeft: 2 }}>→</span>
  return diff > 0
    ? <span style={{ color: '#dc2626', fontSize: 9, marginLeft: 2 }}>↑</span>
    : <span style={{ color: '#16a34a', fontSize: 9, marginLeft: 2 }}>↓</span>
}

// #6 — semaforo intensity: scales opacity by magnitude within band
function getSemaforoIntensityStyle(semClass, delta) {
  if (!delta || semClass === 'sem-none') return undefined
  const abs = Math.abs(Number(delta))
  // intensity 0–1 capped at 20%
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
}) {
  const key = bracket
  const { t } = useI18n()

  const priceWrapRef = useRef(null)
  const deltaWrapRef = useRef(null)
  const diffWrapRef  = useRef(null)
  const tableRef     = useRef(null)

  const [showSamples,  setShowSamples]  = useState(false)
  // #25 — section collapse
  const [collapsed,    setCollapsed]    = useState(false)
  // #14 — chart type toggle
  const [chartType,    setChartType]    = useState('line')
  // #16 — hidden competitors in chart
  const [hiddenComps,  setHiddenComps]  = useState(new Set())
  // #40 — sort config
  const [sortConfig,   setSortConfig]   = useState(null) // { periodKey, dir: 'asc'|'desc' }

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

  // #2 — column hover: direct DOM class toggle, zero React re-renders
  const handleColEnter = (idx) => {
    const tables = tableRef.current?.querySelectorAll('.matrix-table')
    tables?.forEach(tbl => {
      tbl.querySelectorAll(`th:nth-child(${idx + 2}), td:nth-child(${idx + 2})`).forEach(el => {
        el.classList.add('col-highlighted')
      })
    })
  }
  const handleColLeave = () => {
    tableRef.current?.querySelectorAll('.col-highlighted').forEach(el => {
      el.classList.remove('col-highlighted')
    })
  }

  function getPrice(comp, periodKey) { return priceMatrix[comp]?.[periodKey]?.[key] ?? null }
  function getDelta(comp, periodKey) { return deltaMatrix[comp]?.[periodKey]?.[key] ?? null }
  function getSemaforo(comp, periodKey) { return semaforoMatrix[comp]?.[periodKey]?.[key] ?? 'sem-none' }
  function getDiff(comp, periodKey) { return diffMatrix[comp]?.[periodKey]?.[key] ?? null }
  const isBase = (comp) => comp === compareVs

  // #12 — green band boundaries from semaforo config
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

  return (
    <div className="bracket-section">
      {/* Header */}
      <div className="bracket-section__title" style={{ flexWrap: 'wrap' }}>
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

        {/* Sample counts */}
        {!collapsed && (
          <div
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              marginLeft: 'auto', fontSize: 10,
              textTransform: 'none', letterSpacing: 0, flexWrap: 'wrap',
            }}
            title={t('samples.summary_title_attr').replace('{label}', summaryPeriodLabel)}
          >
            <span style={{ color: 'rgba(255,255,255,0.75)', marginRight: 2 }}>n {summaryPeriodLabel}:</span>
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
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: COMPETITOR_COLORS[comp] || '#64748b' }}/>
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
        )}
      </div>

      {/* Collapsible body #25 */}
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
                      {periods.map((p, i) => (
                        <th
                          key={p.key}
                          onMouseEnter={() => handleColEnter(i)}
                          onMouseLeave={handleColLeave}
                          onClick={() => {
                            if (sortConfig?.periodKey === p.key) {
                              setSortConfig(s => ({ ...s, dir: s.dir === 'asc' ? 'desc' : 'asc' }))
                            } else {
                              setSortConfig({ periodKey: p.key, dir: 'asc' })
                            }
                          }}
                          style={{
                            cursor: 'pointer',
                            ...(frozenWeeks?.has(p.key) ? { background: '#eef2ff', color: '#4338ca' } : {}),
                            ...(sortConfig?.periodKey === p.key ? { background: '#fef3c7' } : {}),
                          }}
                          title={frozenWeeks?.has(p.key) ? t('dashboard.frozen_period') : undefined}
                        >
                          {frozenWeeks?.has(p.key) ? '🔒 ' : ''}{p.label}
                          {sortConfig?.periodKey === p.key ? (sortConfig.dir === 'asc' ? ' ↑' : ' ↓') : ''}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedCompetitors.map(comp => (
                      <tr key={comp} className={isBase(comp) ? 'row-yango' : ''}>
                        <td className="col-label">{compBadge(comp)}</td>
                        {periods.map((p, i) => {
                          const v    = getPrice(comp, p.key)
                          const prev = i > 0 ? getPrice(comp, periods[i - 1].key) : null
                          const isLast = i === lastPeriodIdx
                          return (
                            <td key={p.key}>
                              {v != null ? (
                                <>
                                  {v.toFixed(2)}
                                  {/* #4 — trend arrow only in last column */}
                                  {isLast && <TrendArrow curr={v} prev={prev} />}
                                </>
                              ) : <span className="cell-empty">—</span>}
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
                          if (d == null)    return <td key={p.key} className="sem-none"><span className="cell-empty">—</span></td>
                          // #6 — intensity-scaled semaforo
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
                          if (d == null)    return <td key={p.key}><span className="cell-empty">—</span></td>
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
            />
          </div>
        </>
      )}
    </div>
  )
}

function MiniChart({
  title, data, competitors, compareVs,
  yFormatter, isPercent = false, events = [],
  chartType = 'line', hiddenComps, setHiddenComps,
  chartTypeToggle, greenBand, syncId,
}) {
  const { t } = useI18n()
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

  function renderSeries(comp) {
    const color  = COMPETITOR_COLORS[comp] || '#999'
    const isBase = comp === compareVs
    const sw     = isBase ? 2.5 : 1.5

    const commonProps = {
      key: comp, type: 'monotone', dataKey: comp,
      stroke: color, strokeWidth: sw,
      connectNulls: false,
      isAnimationActive: true, animationDuration: 600, animationEasing: 'ease-out',
    }

    // #10 — compareVs gets area fill; others stay as lines
    if (chartType === 'bar') {
      return <Bar key={comp} dataKey={comp} fill={color} radius={[2,2,0,0]} maxBarSize={12} isAnimationActive animationDuration={400} />
    }
    if (isBase || chartType === 'area') {
      return (
        <Area
          {...commonProps}
          fill={color}
          fillOpacity={isBase ? 0.12 : 0.06}
          dot={isBase ? { r: 2 } : false}
        />
      )
    }
    return <Line {...commonProps} dot={{ r: 2 }} />
  }

  const ChartComponent = chartType === 'bar' ? BarChart : ComposedChart

  return (
    <div className="chart-card">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <div className="chart-card__title" style={{ margin: 0 }}>{title}</div>
        {chartTypeToggle}
      </div>

      {!hasData ? (
        <div style={{ fontSize: 11, color: '#aaa', textAlign: 'center', padding: '16px 0' }}>{t('app.no_data')}</div>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={150}>
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

              {/* #12 — tolerance band from semaforo config */}
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
