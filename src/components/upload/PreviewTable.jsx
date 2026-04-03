// Columnas a mostrar en el preview (subconjunto de las 45 columnas)
const PREVIEW_COLS = [
  { key: 'observed_date',         label: 'Fecha' },
  { key: 'city',                  label: 'Ciudad' },
  { key: 'category',              label: 'Categoría' },
  { key: 'competition_name',      label: 'Competidor' },
  { key: 'distance_km',           label: 'Dist (km)' },
  { key: '_bracket_computed',     label: 'Bracket ★', computed: true },
  { key: 'timeslot',              label: 'Timeslot' },
  { key: 'surge',                 label: 'Surge' },
  { key: 'price_without_discount',label: 'P w/o disc' },
  { key: 'bid_1',                 label: 'Bid 1' },
  { key: 'bid_2',                 label: 'Bid 2' },
  { key: 'bid_3',                 label: 'Bid 3' },
  { key: '_effective_price',      label: 'Precio Efectivo ★', computed: true },
]

export default function PreviewTable({ rows }) {
  if (!rows || rows.length === 0) return null

  return (
    <div className="preview-section">
      <h2>Vista previa — primeras {rows.length} filas (★ = calculado)</h2>
      <div className="preview-wrap">
        <table className="preview-table">
          <thead>
            <tr>
              {PREVIEW_COLS.map(c => (
                <th key={c.key} className={c.computed ? 'col-computed' : ''}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                {PREVIEW_COLS.map(c => (
                  <td key={c.key} className={c.computed ? 'col-computed' : ''}>
                    {row[c.key] !== null && row[c.key] !== undefined
                      ? String(row[c.key])
                      : '—'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
