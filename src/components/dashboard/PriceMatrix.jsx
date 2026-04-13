import { BRACKETS, BRACKET_LABELS, YANGO_DISPLAY_NAME } from '../../lib/constants'
import MatrixCell from './MatrixCell'

export default function PriceMatrix({ filters, priceMatrix, periods, currency = 'S/' }) {
  const { competitors, city, category, compareVs } = filters

  if (!periods.length) return null

  return (
    <div className="matrix-section">
      <div className="matrix-section__title">Precios absolutos ({currency})</div>
      <div className="matrix-wrap">
        <table className="matrix-table">
          <thead>
            <tr>
              <th className="col-label">Competidor</th>
              {BRACKETS.map(b => (
                <th key={b}>{BRACKET_LABELS[b]}</th>
              ))}
              <th className="col-wa">W. Avg</th>
              {periods.map(p => (
                <th key={p.key}>{p.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {competitors.map(comp => {
              const isYango = comp === compareVs
              const rowClass = isYango ? 'row-yango' : ''
              const label = comp === 'Yango'
                ? (YANGO_DISPLAY_NAME[city]?.[category] || 'Yango')
                : comp

              return (
                <tr key={comp} className={rowClass}>
                  <td className="col-label">{label}</td>

                  {/* Columnas por bracket (promedio de todos los períodos) */}
                  {BRACKETS.map(b => {
                    // Promedio del bracket a través de todos los períodos
                    const vals = periods
                      .map(p => priceMatrix[comp]?.[p.key]?.[b])
                      .filter(v => v !== null && v !== undefined && v > 0)
                    const avg = vals.length ? vals.reduce((a, v) => a + v, 0) / vals.length : null
                    return <MatrixCell key={b} value={avg} format="price" />
                  })}

                  {/* Columna WA global (promedio de WAs) */}
                  <td className="col-wa">
                    {(() => {
                      const was = periods
                        .map(p => priceMatrix[comp]?.[p.key]?._wa)
                        .filter(v => v !== null && v !== undefined)
                      return was.length
                        ? was.reduce((a, v) => a + v, 0) / was.length
                        : '—'
                    })()}{' '}
                    {(() => {
                      const was = periods
                        .map(p => priceMatrix[comp]?.[p.key]?._wa)
                        .filter(v => v !== null && v !== undefined)
                      return was.length
                        ? (was.reduce((a, v) => a + v, 0) / was.length).toFixed(2)
                        : null
                    })() && null}
                  </td>

                  {/* Una columna por período */}
                  {periods.map(p => (
                    <MatrixCell
                      key={p.key}
                      value={priceMatrix[comp]?.[p.key]?._wa}
                      format="price"
                    />
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
