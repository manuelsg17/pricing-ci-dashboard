import { BRACKETS, BRACKET_LABELS, YANGO_DISPLAY_NAME } from '../../lib/constants'

export default function SampleMatrix({ filters, sampleMatrix, periods }) {
  const { competitors, city, category } = filters

  if (!periods.length) return null

  return (
    <div className="matrix-section">
      <div className="matrix-section__title"># Muestras por bracket</div>
      <div className="matrix-wrap">
        <table className="matrix-table">
          <thead>
            <tr>
              <th className="col-label">Competidor</th>
              {BRACKETS.map(b => (
                <th key={b}>{BRACKET_LABELS[b]}</th>
              ))}
              <th className="col-wa">Total</th>
              {periods.map(p => (
                <th key={p.key}>{p.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {competitors.map(comp => {
              const label = comp === 'Yango'
                ? (YANGO_DISPLAY_NAME[city]?.[category] || 'Yango')
                : comp

              return (
                <tr key={comp}>
                  <td className="col-label">{label}</td>

                  {/* Suma de muestras por bracket a través de todos los períodos */}
                  {BRACKETS.map(b => {
                    const total = periods.reduce((sum, p) => {
                      return sum + (Number(sampleMatrix[comp]?.[p.key]?.[b]) || 0)
                    }, 0)
                    return (
                      <td key={b} style={{ color: total === 0 ? '#bbb' : undefined }}>
                        {total === 0 ? '—' : total}
                      </td>
                    )
                  })}

                  {/* Total general */}
                  <td className="col-wa">
                    {periods.reduce((sum, p) => {
                      return sum + BRACKETS.reduce((s2, b) => s2 + (Number(sampleMatrix[comp]?.[p.key]?.[b]) || 0), 0)
                    }, 0) || '—'}
                  </td>

                  {/* Por período */}
                  {periods.map(p => {
                    const periodTotal = BRACKETS.reduce((s, b) =>
                      s + (Number(sampleMatrix[comp]?.[p.key]?.[b]) || 0), 0)
                    return (
                      <td key={p.key} style={{ color: periodTotal === 0 ? '#bbb' : undefined }}>
                        {periodTotal === 0 ? '—' : periodTotal}
                      </td>
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
