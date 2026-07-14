// Tabla de percentiles P10-P90 del Δ% (Yango vs rival) + promedio.
export default function PercentileTable({ summary }) {
  if (!summary || !summary.total_observations) return null
  const cols = [
    ['P10', summary.p10],
    ['P25', summary.p25],
    ['P50 (mediana)', summary.p50],
    ['P75', summary.p75],
    ['P90', summary.p90],
  ]

  return (
    <div className="config-section" style={{ marginBottom: 16 }}>
      <h2 style={{ margin: 0, marginBottom: 10 }}>Distribución de Δ% (Yango vs rival)</h2>
      <table className="config-table config-table--modern">
        <thead>
          <tr>
            {cols.map(([label]) => (
              <th key={label} scope="col">
                {label}
              </th>
            ))}
            <th scope="col">Promedio</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            {cols.map(([label, val]) => (
              <td key={label} style={{ fontWeight: 700 }}>
                {val != null ? `${val}%` : '—'}
              </td>
            ))}
            <td style={{ fontWeight: 700 }}>
              {summary.avg_pct_diff != null ? `${summary.avg_pct_diff}%` : '—'}
            </td>
          </tr>
        </tbody>
      </table>
      <p style={{ fontSize: 11, color: 'var(--color-muted)', marginTop: 8, marginBottom: 0 }}>
        Negativo = Yango más barato que el rival. Ej: P90 positivo indica que el 10% más caro de las
        cotizaciones de Yango queda por encima del rival.
      </p>
    </div>
  )
}
