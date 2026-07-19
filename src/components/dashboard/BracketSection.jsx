import { memo, useRef, useEffect, useMemo, useState, useCallback } from 'react'
import {
  ComposedChart,
  Line,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
  ReferenceLine,
  ReferenceArea,
  Brush,
} from 'recharts'
import { COMPETITOR_COLORS, BRACKETS } from '../../lib/constants'
import { isSimpleAvgPeriod } from '../../algorithms/weightedAverage'
import { formatPrice } from '../../lib/format.js'
import { prettyCompetitor } from '../../lib/normalize'
import { useI18n } from '../../context/LanguageContext'
import DrillDownModal from './DrillDownModal'
import { Button } from '../ui/shadcn/button'
import {
  GripVertical,
  ChevronUp,
  ChevronDown,
  Copy,
  Check,
  Eye,
  EyeOff,
  LineChart as LineChartIcon,
  AreaChart as AreaChartIcon,
  BarChart3,
  Pin,
  Camera,
  Lock,
} from 'lucide-react'

const SAMPLE_LOW = 30
const SAMPLE_MED = 100

function sampleBg(n) {
  if (!n) return 'transparent'
  if (n < SAMPLE_LOW) return '#fee2e2'
  if (n < SAMPLE_MED) return '#fef9c3'
  return '#dcfce7'
}
function sampleColor(n) {
  if (!n) return '#94a3b8'
  if (n < SAMPLE_LOW) return '#991b1b'
  if (n < SAMPLE_MED) return '#854d0e'
  return '#166534'
}

const IMPACT_COLORS = { alto: '#dc2626', medio: '#d97706', bajo: '#94a3b8' }

// #4 — trend arrow: only in last column
function TrendArrow({ curr, prev }) {
  if (curr == null || prev == null) return null
  const diff = curr - prev
  if (Math.abs(diff / (prev || 1)) < 0.005)
    return <span style={{ color: '#94a3b8', fontSize: 9, marginLeft: 2 }}>→</span>
  return diff > 0 ? (
    <span style={{ color: '#dc2626', fontSize: 9, marginLeft: 2 }}>↑</span>
  ) : (
    <span style={{ color: '#16a34a', fontSize: 9, marginLeft: 2 }}>↓</span>
  )
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
  const valid = values.filter((v) => v != null)
  if (valid.length < 2) return null
  const min = Math.min(...valid)
  const max = Math.max(...valid)
  const range = max - min || 1
  const W = 48,
    H = 14
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
      width={W}
      height={H}
      style={{ marginLeft: 5, verticalAlign: 'middle', flexShrink: 0, overflow: 'visible' }}
    >
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function BracketSection({
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
  currency = '',
  semaforoBands = [],
  frozenWeeks,
  loading = false,
  viewMode = 'weekly',
  categoryLabel = '',
  defaultCollapsed = false,
}) {
  const key = bracket
  const { t } = useI18n()

  // Divisor del corte Ponderado→Simple (solo fila WA): true en la 1ª columna de
  // la época simple cuando la columna previa VISIBLE es ponderada. Weekly/historic
  // traen year/week; en daily (p.year null) no aplica.
  const isWaCutoffCol = useCallback(
    (p, i) =>
      key === '_wa' &&
      i > 0 &&
      p?.year != null &&
      periods[i - 1]?.year != null &&
      isSimpleAvgPeriod(p.year, p.week) &&
      !isSimpleAvgPeriod(periods[i - 1].year, periods[i - 1].week),
    [key, periods]
  )

  const sectionRef = useRef(null)
  const priceWrapRef = useRef(null)
  const deltaWrapRef = useRef(null)
  const diffWrapRef = useRef(null)
  const tableRef = useRef(null)

  const [showSamples, setShowSamples] = useState(false)
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  const [chartType, setChartType] = useState('line')
  const [hiddenComps, setHiddenComps] = useState(new Set())
  const [sortConfig, setSortConfig] = useState(null)
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
      const total = competitors.reduce((sum, comp) => sum + getSampleCount(comp, periods[i].key), 0)
      if (total > 0) return periods[i]
    }
    return periods[periods.length - 1] || null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periods, competitors, sampleMatrix, key])

  const summaryPeriodKey = summaryPeriod?.key
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
      ;[priceWrapRef, deltaWrapRef, diffWrapRef].forEach((ref) => {
        if (ref.current) ref.current.scrollLeft = ref.current.scrollWidth
      })
    }
    const raf1 = requestAnimationFrame(() => requestAnimationFrame(scrollToEnd))
    window.addEventListener('resize', scrollToEnd)
    return () => {
      cancelAnimationFrame(raf1)
      window.removeEventListener('resize', scrollToEnd)
    }
  }, [periods, collapsed])

  // #2 — column hover via direct DOM class toggle
  const handleColEnter = useCallback((idx) => {
    const tables = tableRef.current?.querySelectorAll('.matrix-table')
    tables?.forEach((tbl) => {
      tbl.querySelectorAll(`th:nth-child(${idx + 2}), td:nth-child(${idx + 2})`).forEach((el) => {
        el.classList.add('col-highlighted')
      })
    })
  }, [])
  const handleColLeave = useCallback(() => {
    tableRef.current?.querySelectorAll('.col-highlighted').forEach((el) => {
      el.classList.remove('col-highlighted')
    })
  }, [])

  function getPrice(comp, periodKey) {
    return priceMatrix[comp]?.[periodKey]?.[key] ?? null
  }
  function getDelta(comp, periodKey) {
    return deltaMatrix[comp]?.[periodKey]?.[key] ?? null
  }
  function getSemaforo(comp, periodKey) {
    return semaforoMatrix[comp]?.[periodKey]?.[key] ?? 'sem-none'
  }
  function getDiff(comp, periodKey) {
    return diffMatrix[comp]?.[periodKey]?.[key] ?? null
  }
  const isBase = (comp) => comp === compareVs

  // #12 — green tolerance band from semaforo config
  const greenBand = useMemo(() => semaforoBands?.find((b) => b.band === 'green'), [semaforoBands])

  function compBadge(comp) {
    const color = COMPETITOR_COLORS[comp]
    if (!color) return comp
    return (
      <span
        style={{
          background: color,
          color: '#fff',
          borderRadius: 4,
          padding: '2px 8px',
          fontWeight: 700,
          fontSize: 11,
          whiteSpace: 'nowrap',
          letterSpacing: 0.2,
        }}
      >
        {prettyCompetitor(comp)}
      </span>
    )
  }

  // #41 — toggle pin on a period
  function togglePin(periodKey) {
    setPinnedPeriods((prev) => {
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
      canvas.toBlob(async (blob) => {
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
      { key: 'line', Icon: LineChartIcon },
      { key: 'area', Icon: AreaChartIcon },
      { key: 'bar', Icon: BarChart3 },
    ]
    return (
      <div style={{ display: 'flex', gap: 2 }}>
        {types.map(({ key: k, Icon }) => (
          <Button
            key={k}
            type="button"
            variant="outline"
            size="icon"
            className={
              'h-auto w-auto rounded-[5px] p-[3px_7px]' +
              (chartType === k
                ? ' border-yango bg-[var(--color-yango-light)] text-yango hover:bg-[var(--color-yango-light)]'
                : ' text-muted')
            }
            onClick={() => setChartType(k)}
            title={t(`dashboard.chart.type_${k}`)}
          >
            <Icon size={13} />
          </Button>
        ))}
      </div>
    )
  }

  const lastPeriodIdx = periods.length - 1

  // #5 — sparkline data for each competitor (last N price values)
  function getSparkValues(comp) {
    return periods.map((p) => getPrice(comp, p.key))
  }

  return (
    <div
      className={key === '_wa' ? 'bracket-section bracket-section--summary' : 'bracket-section'}
      ref={sectionRef}
    >
      {/* Header */}
      <div className="bracket-section__title" style={{ flexWrap: 'wrap' }}>
        {/* #26 drag handle indicator */}
        <span
          title={t('dashboard.drag_reorder')}
          style={{
            display: 'inline-flex',
            cursor: 'grab',
            color: 'var(--color-subtle)',
            marginRight: 2,
            flexShrink: 0,
          }}
        >
          <GripVertical size={14} />
        </span>

        {/* #27 collapse toggle */}
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-auto w-auto shrink-0 rounded-[5px] bg-[var(--color-bg)] px-[5px] py-[2px] text-muted"
          onClick={() => setCollapsed((c) => !c)}
          title={t(collapsed ? 'dashboard.section.expand' : 'dashboard.section.collapse')}
        >
          {collapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
        </Button>

        <span>{label}</span>
        {key === '_wa' && (
          <span className="bracket-section__summary-badge">{t('bracket.summary_badge')}</span>
        )}

        {/* Section actions */}
        {!collapsed && (
          <div
            style={{
              marginLeft: 'auto',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              flexWrap: 'wrap',
            }}
          >
            {/* #45 — copy section as image */}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleCopySection}
              title={t('dashboard.copy_image')}
              className="h-auto gap-1 rounded-[5px] border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-0.5 text-[10px] font-semibold text-[var(--color-muted)] hover:bg-[var(--color-bg)]"
            >
              {copyDone ? (
                <>
                  <Check size={12} /> {t('dashboard.kpi.copy_done')}
                </>
              ) : (
                <Copy size={12} />
              )}
            </Button>

            {/* Sample counts */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 10,
                textTransform: 'none',
                letterSpacing: 0,
                flexWrap: 'wrap',
              }}
              title={t('samples.summary_title_attr', { label: summaryPeriodLabel })}
            >
              <span style={{ color: 'var(--color-muted)', marginRight: 2 }}>
                n {summaryPeriodLabel}
                {categoryLabel ? ` · ${categoryLabel}` : ''}
                {key === '_wa' ? ` · ${t('samples.all_brackets_suffix')}` : ''}:
              </span>
              {competitors.map((comp) => {
                const n = getSampleCount(comp, summaryPeriodKey)
                return (
                  <span
                    key={`title-${comp}`}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      background: 'var(--color-bg)',
                      border: '1px solid var(--color-border)',
                      color: '#1f2937',
                      padding: '1px 6px',
                      borderRadius: 5,
                      fontWeight: 600,
                      fontSize: 10,
                    }}
                  >
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        background: COMPETITOR_COLORS[comp] || '#64748b',
                      }}
                    />
                    {prettyCompetitor(comp)}: <strong style={{ color: sampleColor(n) }}>{n}</strong>
                  </span>
                )
              })}
              <Button
                type="button"
                variant="outline"
                className="ml-1 h-auto gap-1 rounded-[5px] bg-[var(--color-bg)] px-2 py-0.5 text-[10px] font-semibold text-muted"
                onClick={() => setShowSamples((s) => !s)}
                title={t('samples.toggle_title')}
              >
                {showSamples ? <EyeOff size={12} /> : <Eye size={12} />}
                {showSamples ? t('samples.toggle_hide') : t('samples.toggle_show')}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Collapsible body */}
      {!collapsed && (
        <>
          {/* Samples panel */}
          {showSamples && (
            <div
              style={{
                padding: '10px 14px',
                background: '#f8fafc',
                borderBottom: '1px solid #e2e8f0',
                overflowX: 'auto',
              }}
            >
              <div style={{ fontSize: 10, color: '#475569', marginBottom: 6 }}>
                <strong>{t('samples.legend_title')}</strong> {t('samples.legend_per')}
                {key === '_wa' ? ` (${t('samples.all_brackets_suffix')})` : ''} —{' '}
                <span style={{ background: '#fee2e2', padding: '0 4px', borderRadius: 3 }}>
                  &lt;{SAMPLE_LOW}
                </span>{' '}
                {t('samples.legend_low')} ·{' '}
                <span style={{ background: '#fef9c3', padding: '0 4px', borderRadius: 3 }}>
                  {SAMPLE_LOW}–{SAMPLE_MED - 1}
                </span>{' '}
                {t('samples.legend_med')} ·{' '}
                <span style={{ background: '#dcfce7', padding: '0 4px', borderRadius: 3 }}>
                  ≥{SAMPLE_MED}
                </span>{' '}
                {t('samples.legend_high')}
              </div>
              <table className="matrix-table" style={{ fontSize: 11 }}>
                <thead>
                  <tr>
                    <th className="col-label">{t('dashboard.table.competitor')}</th>
                    {periods.map((p) => (
                      <th
                        key={p.key}
                        style={
                          frozenWeeks?.has(p.key)
                            ? { background: '#eef2ff', color: '#4338ca' }
                            : undefined
                        }
                      >
                        {frozenWeeks?.has(p.key) ? (
                          <Lock
                            size={10}
                            style={{ display: 'inline', verticalAlign: '-1px', marginRight: 2 }}
                          />
                        ) : null}
                        {p.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {competitors.map((comp) => (
                    <tr key={`samples-${comp}`}>
                      <td className="col-label">{compBadge(comp)}</td>
                      {periods.map((p) => {
                        const n = getSampleCount(comp, p.key)
                        return (
                          <td
                            key={p.key}
                            style={{
                              background: sampleBg(n),
                              color: sampleColor(n),
                              fontWeight: 600,
                              textAlign: 'center',
                            }}
                          >
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
              <div className="bracket-section__table-title">
                {t('dashboard.table.price')} {currency}
              </div>
              <div className="matrix-wrap" ref={priceWrapRef}>
                <table className="matrix-table">
                  <thead>
                    <tr>
                      <th className="col-label">{t('dashboard.table.competitor')}</th>
                      {periods.map((p, i) => {
                        const isPinned = pinnedPeriods.has(p.key)
                        const isFrozen = frozenWeeks?.has(p.key)
                        const isSort = sortConfig?.periodKey === p.key
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
                              ...(isSort ? { background: '#fef3c7' } : {}),
                              ...(isPinned ? { borderBottom: '2px solid #E53935' } : {}),
                              ...(isWaCutoffCol(p, i) ? { borderLeft: '2px solid #f59e0b' } : {}),
                            }}
                            title={
                              isWaCutoffCol(p, i)
                                ? `Desde esta semana: Promedio Simple (antes, Ponderado)`
                                : isFrozen
                                  ? t('dashboard.frozen_period')
                                  : undefined
                            }
                          >
                            <span
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: 3,
                              }}
                            >
                              {isFrozen ? (
                                <Lock
                                  size={10}
                                  style={{
                                    display: 'inline',
                                    verticalAlign: '-1px',
                                    marginRight: 2,
                                  }}
                                />
                              ) : null}
                              {p.label}
                              {isSort ? (sortConfig.dir === 'asc' ? ' ↑' : ' ↓') : ''}
                              {/* #41 pin button */}
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-auto w-auto p-0 leading-none hover:bg-transparent"
                                style={{
                                  opacity: isPinned ? 1 : 0.3,
                                  color: isPinned ? 'var(--color-yango)' : 'inherit',
                                }}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  togglePin(p.key)
                                }}
                                title={
                                  isPinned ? t('dashboard.unpin_period') : t('dashboard.pin_period')
                                }
                              >
                                <Pin size={11} />
                              </Button>
                            </span>
                          </th>
                        )
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedCompetitors.map((comp) => (
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
                          const v = getPrice(comp, p.key)
                          const prev = i > 0 ? getPrice(comp, periods[i - 1].key) : null
                          const isLast = i === lastPeriodIdx
                          return (
                            <td
                              key={p.key}
                              onClick={() => v != null && setDrillDown({ comp, periodKey: p.key })}
                              style={{
                                cursor: v != null ? 'pointer' : 'default',
                                ...(isWaCutoffCol(p, i) ? { borderLeft: '2px solid #f59e0b' } : {}),
                              }}
                              title={v != null ? t('dashboard.drill.title') : undefined}
                            >
                              {v != null ? (
                                <>
                                  {formatPrice(v)}
                                  {isLast && <TrendArrow curr={v} prev={prev} />}
                                </>
                              ) : loading ? (
                                <span className="skel-cell" />
                              ) : (
                                <span className="cell-empty">—</span>
                              )}
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
              <div className="bracket-section__table-title">
                {t('dashboard.table.delta_vs')} {compareVs}
              </div>
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
                          style={
                            frozenWeeks?.has(p.key)
                              ? { background: '#eef2ff', color: '#4338ca' }
                              : undefined
                          }
                        >
                          {frozenWeeks?.has(p.key) ? (
                            <Lock
                              size={10}
                              style={{ display: 'inline', verticalAlign: '-1px', marginRight: 2 }}
                            />
                          ) : null}
                          {p.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedCompetitors.map((comp) => (
                      <tr key={comp} className={isBase(comp) ? 'row-yango' : ''}>
                        <td className="col-label">{compBadge(comp)}</td>
                        {periods.map((p) => {
                          const d = getDelta(comp, p.key)
                          const sem = getSemaforo(comp, p.key)
                          if (isBase(comp))
                            return (
                              <td key={p.key} className="sem-none bs-base-cell">
                                0%
                              </td>
                            )
                          if (d == null)
                            return (
                              <td key={p.key} className="sem-none">
                                {loading ? (
                                  <span className="skel-cell" />
                                ) : (
                                  <span className="cell-empty">—</span>
                                )}
                              </td>
                            )
                          const intensityStyle = getSemaforoIntensityStyle(sem, d)
                          const sign = d >= 0 ? '+' : ''
                          return (
                            <td
                              key={p.key}
                              className={intensityStyle ? undefined : sem}
                              style={intensityStyle}
                            >
                              {sign}
                              {d.toFixed(0)}%
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
              <div className="bracket-section__table-title">
                {t('dashboard.table.diff')} {currency}
              </div>
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
                          style={
                            frozenWeeks?.has(p.key)
                              ? { background: '#eef2ff', color: '#4338ca' }
                              : undefined
                          }
                        >
                          {frozenWeeks?.has(p.key) ? (
                            <Lock
                              size={10}
                              style={{ display: 'inline', verticalAlign: '-1px', marginRight: 2 }}
                            />
                          ) : null}
                          {p.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedCompetitors.map((comp) => (
                      <tr key={comp} className={isBase(comp) ? 'row-yango' : ''}>
                        <td className="col-label">{compBadge(comp)}</td>
                        {periods.map((p) => {
                          const d = getDiff(comp, p.key)
                          if (isBase(comp))
                            return (
                              <td key={p.key} className="bs-base-cell">
                                0.00
                              </td>
                            )
                          if (d == null)
                            return (
                              <td key={p.key}>
                                {loading ? (
                                  <span className="skel-cell" />
                                ) : (
                                  <span className="cell-empty">—</span>
                                )}
                              </td>
                            )
                          const sign = d > 0 ? '+' : ''
                          const cls = d > 0 ? 'diff-pos' : d < 0 ? 'diff-neg' : ''
                          // formatPrice ya incluye el '-' para negativos; el sign solo añade '+' para positivos
                          return (
                            <td key={p.key} className={cls}>
                              {sign}
                              {formatPrice(d)}
                            </td>
                          )
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
              currency={currency}
              yFormatter={(v) => v.toFixed(1)}
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
              currency={currency}
              yFormatter={(v) => `${v.toFixed(0)}%`}
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
  title,
  data,
  competitors,
  compareVs,
  currency = '',
  yFormatter,
  isPercent = false,
  events = [],
  chartType = 'line',
  hiddenComps,
  setHiddenComps,
  chartTypeToggle,
  greenBand,
  syncId,
  viewMode = 'weekly',
  exportName = 'chart',
}) {
  const { t } = useI18n()
  const chartCardRef = useRef(null)
  const hasData = data && data.length > 0 && competitors.some((c) => data.some((d) => d[c] != null))
  const periodKeys = new Set((data || []).map((d) => d.period))
  const visibleComps = competitors.filter((c) => !hiddenComps?.has(c))

  const toggleHide = (comp) => {
    setHiddenComps?.((prev) => {
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
      const canvas = await html2canvas(chartCardRef.current, {
        scale: 2,
        useCORS: true,
        backgroundColor: '#ffffff',
      })
      const link = document.createElement('a')
      link.download = `${exportName}.png`
      link.href = canvas.toDataURL()
      link.click()
    } catch (e) {
      console.error('Chart export failed:', e)
    }
  }

  function renderSeries(comp) {
    const color = COMPETITOR_COLORS[comp] || '#999'
    const isBaseComp = comp === compareVs
    const sw = isBaseComp ? 2.5 : 1.5

    // `key` se pasa SIEMPRE como atributo directo (no por spread). React 19
    // warning "A props object containing a 'key' prop is being spread into
    // JSX" — la solución es nunca incluir key en un objeto spreado.
    const commonProps = {
      type: 'monotone',
      dataKey: comp,
      stroke: color,
      strokeWidth: sw,
      connectNulls: false,
      isAnimationActive: true,
      animationDuration: 600,
      animationEasing: 'ease-out',
    }

    if (chartType === 'bar') {
      return (
        <Bar
          key={comp}
          dataKey={comp}
          fill={color}
          radius={[2, 2, 0, 0]}
          maxBarSize={12}
          isAnimationActive
          animationDuration={400}
        />
      )
    }
    if (isBaseComp || chartType === 'area') {
      return (
        <Area
          key={comp}
          {...commonProps}
          fill={color}
          fillOpacity={isBaseComp ? 0.12 : 0.06}
          dot={isBaseComp ? { r: 2 } : false}
        />
      )
    }
    return <Line key={comp} {...commonProps} dot={{ r: 2 }} />
  }

  const ChartComponent = chartType === 'bar' ? BarChart : ComposedChart

  // Chart height: smaller in historic mode to leave room for Brush
  const chartHeight = viewMode === 'historic' ? 130 : 150

  return (
    <div className="chart-card" ref={chartCardRef}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 6,
          gap: 4,
        }}
      >
        <div className="chart-card__title" style={{ margin: 0 }}>
          {title}
        </div>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          {chartTypeToggle}
          {/* #43 — per-chart export */}
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={handleExportChart}
            title={t('dashboard.export_chart')}
            className="h-auto w-auto rounded-[5px] border-[var(--color-border)] bg-transparent p-1.5 text-[var(--color-muted)] hover:bg-transparent"
          >
            <Camera size={13} />
          </Button>
        </div>
      </div>

      {!hasData ? (
        <div style={{ fontSize: 11, color: '#aaa', textAlign: 'center', padding: '16px 0' }}>
          {t('app.no_data')}
        </div>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={chartHeight}>
            <ChartComponent
              data={data}
              margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
              syncId={syncId}
            >
              <CartesianGrid vertical={false} stroke="#eef2f7" />
              <XAxis
                dataKey="period"
                tick={{ fontSize: 9, fill: 'var(--color-muted)' }}
                axisLine={false}
                tickLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fontSize: 9, fill: 'var(--color-muted)' }}
                axisLine={false}
                tickLine={false}
                width={isPercent ? 36 : 32}
                tickFormatter={(v) => (v != null ? yFormatter(v) : '')}
              />
              <Tooltip
                contentStyle={{
                  fontSize: 11,
                  borderRadius: 10,
                  border: '1px solid var(--color-border)',
                  boxShadow: 'var(--shadow-md)',
                }}
                formatter={(v, name) => {
                  // name viene como el raw competitor key (ej 'Yango', 'Cabify Lite').
                  // Mostramos el display name + contexto (vs base / moneda) para que
                  // se entienda el número sin tener que mirar la leyenda.
                  if (v == null) return ['N/A', prettyCompetitor(name)]
                  if (isPercent) {
                    const sign = v > 0 ? '+' : ''
                    const baseLabel = prettyCompetitor(compareVs)
                    return [`${sign}${v.toFixed(1)}% vs ${baseLabel}`, prettyCompetitor(name)]
                  }
                  return [`${currency} ${formatPrice(v)}`, prettyCompetitor(name)]
                }}
                labelFormatter={(label) => {
                  // viewMode: 'daily' | 'weekly' | 'historic'
                  const prefix =
                    viewMode === 'daily'
                      ? t('dataentry.col_date')
                      : viewMode === 'historic'
                        ? t('dashboard.chart.period') || 'Período'
                        : t('dashboard.chart.week') || 'Semana'
                  return `${prefix}: ${label}`
                }}
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

              {/* Market events — filtramos antes de mapear para no inyectar
                  `null` como child de ChartComponent (recharts puede crashear
                  haciendo introspección de children con null en algunos paths). */}
              {events
                .filter((evt) => evt && evt.event_date && periodKeys.has(evt.event_date))
                .map((evt) => (
                  <ReferenceLine
                    key={evt.id}
                    x={evt.event_date}
                    stroke={IMPACT_COLORS[evt.impact] || '#f97316'}
                    strokeDasharray="4 2"
                    strokeWidth={1.5}
                    label={{
                      value:
                        evt.event_type === 'huelga' ? 'H' : evt.event_type === 'lluvia' ? 'L' : '●',
                      position: 'top',
                      fill: IMPACT_COLORS[evt.impact] || '#f97316',
                      fontSize: 8,
                      fontWeight: 'bold',
                    }}
                  />
                ))}

              {visibleComps.map((comp) => renderSeries(comp))}

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
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 6,
              marginTop: 6,
              justifyContent: 'center',
            }}
          >
            {competitors.map((comp) => {
              const hidden = hiddenComps?.has(comp)
              const color = COMPETITOR_COLORS[comp] || '#999'
              return (
                <Button
                  key={comp}
                  type="button"
                  variant="outline"
                  className="h-auto gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold transition-opacity"
                  style={{
                    border: `1px solid ${hidden ? '#e2e8f0' : color}`,
                    background: hidden ? '#f8fafc' : `${color}18`,
                    color: hidden ? '#94a3b8' : color,
                    opacity: hidden ? 0.5 : 1,
                  }}
                  onClick={() => toggleHide(comp)}
                  title={hidden ? t('dashboard.chart.show_comp') : t('dashboard.chart.hide_comp')}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: hidden ? '#d1d5db' : color,
                    }}
                  />
                  {comp}
                </Button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

// React.memo con shallow compare default. BracketSection recibe 17 props y se
// renderiza una vez por bracket (~6 instancias). Sin memo, cada cambio de
// filtro re-renderea las 6 instancias aunque sus props específicas no hayan
// cambiado. La estabilidad de props depende de que el padre (Dashboard) use
// useMemo para arrays/objetos — ver chartData[bracket] que pasa por un dict
// estable producido en usePricingData.
export default memo(BracketSection)
