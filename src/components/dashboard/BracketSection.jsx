import { useRef, useEffect, useMemo, useState } from 'react'
import {
  LineChart, Line, XAxis, YAxis, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from 'recharts'
import { COMPETITOR_COLORS, BRACKETS } from '../../lib/constants'
import { useI18n } from '../../context/LanguageContext'

// Umbrales de confianza por celda — usados para colorear el grid de muestras.
// Los valores son intencionalmente conservadores; el head de pricing puede
// pedirnos ajustarlos sin tocar más código.
const SAMPLE_LOW  = 30   // < 30 → rojo (data poco confiable)
const SAMPLE_MED  = 100  // 30..99 → amarillo (data medianamente confiable)

function sampleBg(n) {
  if (!n)              return 'transparent'
  if (n < SAMPLE_LOW)  return '#fee2e2'   // rojo claro
  if (n < SAMPLE_MED)  return '#fef9c3'   // amarillo claro
  return '#dcfce7'                         // verde claro (≥ 100)
}
function sampleColor(n) {
  if (!n)              return '#94a3b8'
  if (n < SAMPLE_LOW)  return '#991b1b'
  if (n < SAMPLE_MED)  return '#854d0e'
  return '#166534'
}

const IMPACT_COLORS = { alto: '#dc2626', medio: '#d97706', bajo: '#94a3b8' }

/**
 * Una sección del dashboard por bracket (o Weighted Average).
 * Muestra 3 tablas lado a lado: precios absolutos | % delta | diferencia S/
 * y 2 gráficos debajo: precio absoluto | % delta
 */
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
}) {
  const key = bracket  // '_wa' o 'very_short' etc.
  const { t } = useI18n()

  const priceWrapRef = useRef(null)
  const deltaWrapRef = useRef(null)
  const diffWrapRef  = useRef(null)

  const [showSamples, setShowSamples] = useState(false)

  // Para `_wa` el conteo es la suma de todos los brackets de ese período.
  // Para un bracket específico, el conteo es directo.
  const getSampleCount = (comp, periodKey) => {
    const periodSamples = sampleMatrix?.[comp]?.[periodKey]
    if (!periodSamples) return 0
    if (key === '_wa') {
      return BRACKETS.reduce((sum, b) => sum + (periodSamples[b] || 0), 0)
    }
    return periodSamples[key] || 0
  }

  const lastPeriod = periods[periods.length - 1]
  const lastPeriodKey   = lastPeriod?.key
  const lastPeriodLabel = lastPeriod?.label || ''

  // Auto-scroll de las 3 tablas al extremo derecho cada vez que cambian
  // los períodos o el tamaño del contenedor. Doble rAF porque el primer
  // frame puede correr antes de que el navegador calcule scrollWidth.
  useEffect(() => {
    const scrollToEnd = () => {
      [priceWrapRef, deltaWrapRef, diffWrapRef].forEach(ref => {
        if (ref.current) ref.current.scrollLeft = ref.current.scrollWidth
      })
    }

    const raf1 = requestAnimationFrame(() => {
      requestAnimationFrame(scrollToEnd)
    })

    window.addEventListener('resize', scrollToEnd)
    return () => {
      cancelAnimationFrame(raf1)
      window.removeEventListener('resize', scrollToEnd)
    }
  }, [periods])

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

  function compBadge(comp) {
    const color = COMPETITOR_COLORS[comp]
    if (!color) return comp
    return (
      <span style={{
        background: color,
        color: '#fff',
        borderRadius: 4,
        padding: '2px 8px',
        fontWeight: 700,
        fontSize: 11,
        whiteSpace: 'nowrap',
        letterSpacing: 0.2,
      }}>
        {comp}
      </span>
    )
  }

  return (
    <div className="bracket-section">
      <div className="bracket-section__title" style={{ flexWrap: 'wrap' }}>
        <span>{label}</span>

        {/* Conteo de muestras de la ÚLTIMA semana, siempre visible */}
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            marginLeft: 'auto', fontSize: 10,
            textTransform: 'none', letterSpacing: 0,
            flexWrap: 'wrap',
          }}
          title={`Muestras observadas (${lastPeriodLabel})`}
        >
          <span style={{ color: 'rgba(255,255,255,0.75)', marginRight: 2 }}>
            n {lastPeriodLabel}:
          </span>
          {competitors.map(comp => {
            const n = getSampleCount(comp, lastPeriodKey)
            return (
              <span
                key={`title-${comp}`}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  background: 'rgba(255,255,255,0.92)',
                  color: '#1f2937',
                  padding: '1px 6px', borderRadius: 4,
                  fontWeight: 600, fontSize: 10,
                }}
              >
                <span style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: COMPETITOR_COLORS[comp] || '#64748b',
                }}/>
                {comp}: <strong style={{ color: sampleColor(n) }}>{n}</strong>
              </span>
            )
          })}
          <button
            type="button"
            onClick={() => setShowSamples(s => !s)}
            style={{
              marginLeft: 4, padding: '2px 8px',
              border: '1px solid rgba(255,255,255,0.4)',
              background: 'rgba(255,255,255,0.15)',
              color: '#fff', borderRadius: 4, cursor: 'pointer',
              fontSize: 10, fontWeight: 600,
            }}
            title="Ver muestras por semana"
          >
            {showSamples ? '▲ ocultar muestras' : '📊 todas las semanas'}
          </button>
        </div>
      </div>

      {/* Panel expandible: muestras por (competidor × semana) */}
      {showSamples && (
        <div style={{
          padding: '10px 14px', background: '#f8fafc',
          borderBottom: '1px solid #e2e8f0', overflowX: 'auto',
        }}>
          <div style={{ fontSize: 10, color: '#475569', marginBottom: 6 }}>
            <strong>Muestras observadas</strong> por competidor y semana —
            {' '}
            <span style={{ background: '#fee2e2', padding: '0 4px', borderRadius: 3 }}>&lt;{SAMPLE_LOW}</span>
            {' '}poca data ·{' '}
            <span style={{ background: '#fef9c3', padding: '0 4px', borderRadius: 3 }}>{SAMPLE_LOW}–{SAMPLE_MED - 1}</span>
            {' '}aceptable ·{' '}
            <span style={{ background: '#dcfce7', padding: '0 4px', borderRadius: 3 }}>≥{SAMPLE_MED}</span>
            {' '}buena
          </div>
          <table className="matrix-table" style={{ fontSize: 11 }}>
            <thead>
              <tr>
                <th className="col-label">{t('dashboard.table.competitor')}</th>
                {periods.map(p => <th key={p.key}>{p.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {competitors.map(comp => (
                <tr key={`samples-${comp}`}>
                  <td className="col-label">{compBadge(comp)}</td>
                  {periods.map(p => {
                    const n = getSampleCount(comp, p.key)
                    return (
                      <td key={p.key} style={{
                        background: sampleBg(n),
                        color: sampleColor(n),
                        fontWeight: 600, textAlign: 'center',
                      }}>
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

      <div className="bracket-section__tables">
        {/* Tabla 1: Precios absolutos */}
        <div className="bracket-section__table-wrap">
          <div className="bracket-section__table-title">{t('dashboard.table.price')} {currency}</div>
          <div className="matrix-wrap" ref={priceWrapRef}>
            <table className="matrix-table">
              <thead>
                <tr>
                  <th className="col-label">{t('dashboard.table.competitor')}</th>
                  {periods.map(p => <th key={p.key}>{p.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {competitors.map(comp => (
                  <tr key={comp} className={isBase(comp) ? 'row-yango' : ''}>
                    <td className="col-label">{compBadge(comp)}</td>
                    {periods.map(p => {
                      const v = getPrice(comp, p.key)
                      return (
                        <td key={p.key}>
                          {v != null ? v.toFixed(2) : <span className="cell-empty">—</span>}
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
                  {periods.map(p => <th key={p.key}>{p.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {competitors.map(comp => (
                  <tr key={comp} className={isBase(comp) ? 'row-yango' : ''}>
                    <td className="col-label">{compBadge(comp)}</td>
                    {periods.map(p => {
                      const d = getDelta(comp, p.key)
                      const sem = getSemaforo(comp, p.key)
                      if (isBase(comp)) {
                        return <td key={p.key} className="sem-none bs-base-cell">0%</td>
                      }
                      if (d == null) {
                        return <td key={p.key} className="sem-none"><span className="cell-empty">—</span></td>
                      }
                      const sign = d >= 0 ? '+' : ''
                      return (
                        <td key={p.key} className={sem}>
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
                  {periods.map(p => <th key={p.key}>{p.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {competitors.map(comp => (
                  <tr key={comp} className={isBase(comp) ? 'row-yango' : ''}>
                    <td className="col-label">{compBadge(comp)}</td>
                    {periods.map(p => {
                      const d = getDiff(comp, p.key)
                      if (isBase(comp)) {
                        return <td key={p.key} className="bs-base-cell">0.00</td>
                      }
                      if (d == null) {
                        return <td key={p.key}><span className="cell-empty">—</span></td>
                      }
                      const sign = d >= 0 ? '+' : ''
                      const cls  = d > 0 ? 'diff-pos' : d < 0 ? 'diff-neg' : ''
                      return (
                        <td key={p.key} className={cls}>
                          {sign}{d.toFixed(2)}
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

      {/* Gráficos */}
      <div className="bracket-section__charts">
        <MiniChart title={`${t('dashboard.chart.price')} ${currency}`} data={chartData} competitors={competitors} yFormatter={v => v.toFixed(1)} events={events} />
        <MiniChart title={t('dashboard.chart.delta')} data={deltaChartData} competitors={competitors} yFormatter={v => `${v.toFixed(0)}%`} isPercent events={events} />
      </div>
    </div>
  )
}

function MiniChart({ title, data, competitors, yFormatter, isPercent = false, events = [] }) {
  const { t } = useI18n()
  const hasData = data && data.length > 0 && competitors.some(c => data.some(d => d[c] != null))
  const periodKeys = new Set((data || []).map(d => d.period))

  return (
    <div className="chart-card">
      <div className="chart-card__title">{title}</div>
      {!hasData ? (
        <div style={{ fontSize: 11, color: '#aaa', textAlign: 'center', padding: '16px 0' }}>{t('app.no_data')}</div>
      ) : (
        <ResponsiveContainer width="100%" height={150}>
          <LineChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
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
                const displayValue = isPercent ? `${v.toFixed(0)}%` : v.toFixed(2)
                return [displayValue, name]
              }}
              labelFormatter={(label) => `${t('dataentry.col_date')}: ${label}`}
            />
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
                    fontSize: 8,
                    fontWeight: 'bold',
                  }}
                />
              )
            })}
            {competitors.map(comp => (
              <Line
                key={comp}
                type="monotone"
                dataKey={comp}
                stroke={COMPETITOR_COLORS[comp] || '#999'}
                strokeWidth={comp.startsWith('Yango') ? 2.5 : 1.5}
                dot={{ r: 2 }}
                connectNulls={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}
