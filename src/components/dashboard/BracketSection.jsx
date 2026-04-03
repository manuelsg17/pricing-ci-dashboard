import {
  LineChart, Line, XAxis, YAxis, Tooltip,
  ResponsiveContainer,
} from 'recharts'
import { COMPETITOR_COLORS } from '../../lib/constants'

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
}) {
  const key = bracket  // '_wa' o 'very_short' etc.

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

  return (
    <div className="bracket-section">
      <div className="bracket-section__title">{label}</div>

      <div className="bracket-section__tables">
        {/* Tabla 1: Precios absolutos */}
        <div className="bracket-section__table-wrap">
          <div className="bracket-section__table-title">Precio S/.</div>
          <div className="matrix-wrap">
            <table className="matrix-table">
              <thead>
                <tr>
                  <th className="col-label">Competidor</th>
                  {periods.map(p => <th key={p.key}>{p.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {competitors.map(comp => (
                  <tr key={comp} className={isBase(comp) ? 'row-yango' : ''}>
                    <td className="col-label">{comp}</td>
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
                  <th className="col-label">Competidor</th>
                  {periods.map(p => <th key={p.key}>{p.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {competitors.map(comp => (
                  <tr key={comp} className={isBase(comp) ? 'row-yango' : ''}>
                    <td className="col-label">{comp}</td>
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
          <div className="bracket-section__table-title">Dif. S/</div>
          <div className="matrix-wrap">
            <table className="matrix-table">
              <thead>
                <tr>
                  <th className="col-label">Competidor</th>
                  {periods.map(p => <th key={p.key}>{p.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {competitors.map(comp => (
                  <tr key={comp} className={isBase(comp) ? 'row-yango' : ''}>
                    <td className="col-label">{comp}</td>
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
        <MiniChart title="Precio S/." data={chartData} competitors={competitors} yFormatter={v => v.toFixed(1)} />
        <MiniChart title="% Delta" data={deltaChartData} competitors={competitors} yFormatter={v => `${v.toFixed(0)}%`} isPercent />
      </div>
    </div>
  )
}

function MiniChart({ title, data, competitors, yFormatter, isPercent = false }) {
  const hasData = data && data.length > 0 && competitors.some(c => data.some(d => d[c] != null))

  return (
    <div className="chart-card">
      <div className="chart-card__title">{title}</div>
      {!hasData ? (
        <div style={{ fontSize: 11, color: '#aaa', textAlign: 'center', padding: '16px 0' }}>Sin datos</div>
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
