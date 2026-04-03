import { BRACKETS, BRACKET_LABELS, YANGO_DISPLAY_NAME } from '../../lib/constants'
import MatrixCell from './MatrixCell'
import { computeDelta, getSemaforoClass } from '../../algorithms/semaforo'

export default function DeltaMatrix({ filters, priceMatrix, deltaMatrix, semaforoMatrix, periods }) {
  const { competitors, city, category, compareVs } = filters

  if (!periods.length) return null

  return (
    <div className="matrix-section">
      <div className="matrix-section__title">Variación % vs {compareVs} (base = 0%)</div>
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
              const isBase = comp === compareVs
              const rowClass = isBase ? 'row-yango' : ''
              const label = comp === 'Yango'
                ? (YANGO_DISPLAY_NAME[city]?.[category] || 'Yango')
                : comp

              return (
                <tr key={comp} className={rowClass}>
                  <td className="col-label">{label}</td>

                  {/* Delta por bracket (promedio global de períodos) */}
                  {BRACKETS.map(b => {
                    if (isBase) {
                      return <td key={b} className="sem-none" style={{color:'#888'}}>0%</td>
                    }
                    const compVals = periods
                      .map(p => priceMatrix[comp]?.[p.key]?.[b])
                      .filter(v => v !== null && v !== undefined && v > 0)
                    const baseVals = periods
                      .map(p => priceMatrix[compareVs]?.[p.key]?.[b])
                      .filter(v => v !== null && v !== undefined && v > 0)
                    const compAvg = compVals.length ? compVals.reduce((a,v)=>a+v,0)/compVals.length : null
                    const baseAvg = baseVals.length ? baseVals.reduce((a,v)=>a+v,0)/baseVals.length : null
                    const delta = computeDelta(compAvg, baseAvg)
                    const cls   = getSemaforoClass(delta)
                    return (
                      <MatrixCell key={b} value={delta} semaforoClass={cls} format="delta" />
                    )
                  })}

                  {/* WA delta global */}
                  {(() => {
                    if (isBase) return <td key="wa" className="col-wa sem-none" style={{color:'#888'}}>0%</td>
                    const compWas = periods.map(p => priceMatrix[comp]?.[p.key]?._wa).filter(v=>v!==null&&v!==undefined)
                    const baseWas = periods.map(p => priceMatrix[compareVs]?.[p.key]?._wa).filter(v=>v!==null&&v!==undefined)
                    const compWa = compWas.length ? compWas.reduce((a,v)=>a+v,0)/compWas.length : null
                    const baseWa = baseWas.length ? baseWas.reduce((a,v)=>a+v,0)/baseWas.length : null
                    const delta  = computeDelta(compWa, baseWa)
                    const cls    = getSemaforoClass(delta)
                    return <MatrixCell key="wa" value={delta} semaforoClass={cls + ' col-wa'} format="delta" />
                  })()}

                  {/* Delta por período */}
                  {periods.map(p => {
                    const delta = isBase ? 0 : deltaMatrix[comp]?.[p.key]
                    const cls   = isBase ? 'sem-none' : (semaforoMatrix[comp]?.[p.key] || 'sem-none')
                    return (
                      <MatrixCell
                        key={p.key}
                        value={delta}
                        semaforoClass={cls}
                        format="delta"
                        isBase={isBase}
                      />
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
