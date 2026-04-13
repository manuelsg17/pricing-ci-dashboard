import {
  LineChart, Line, XAxis, YAxis, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from 'recharts'
import { COMPETITOR_COLORS } from '../../lib/constants'
import { useI18n } from '../../context/LanguageContext'

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
  compareVs,
  chartData,
  deltaChartData,
  events = [],
}) {
}) {
  const key = bracket  // '_wa' o 'very_short' etc.
  const { t } = useI18n()

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
      <div className="bracket-section__title">{label}</div>

      <div className="bracket-section__tables">
        {/* Tabla 1: Precios absolutos */}
        <div className="bracket-section__table-wrap">
          <div className="bracket-section__table-title">{t('dashboard.table.price')} S/.</div>
          <div className="matrix-wrap">
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
          <div className="bracket-section__table-title">% Delta vs {compareVs}</div>
          <div className="matrix-wrap">
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
          <div className="bracket-section__table-title">{t('dashboard.table.diff')} S/</div>
          <div className="matrix-wrap">
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
        <MiniChart title="Precio S/." data={chartData} competitors={competitors} yFormatter={v => v.toFixed(1)} events={events} />
        <MiniChart title="% Delta" data={deltaChartData} competitors={competitors} yFormatter={v => `${v.toFixed(0)}%`} isPercent events={events} />
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
              formatter={(v) => v != null ? yFormatter(v) : 'N/A'}
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
