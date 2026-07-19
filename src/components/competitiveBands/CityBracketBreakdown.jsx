import { useMemo, useState } from 'react'
import { BRACKETS, BRACKET_LABELS } from '../../lib/constants'
import { useI18n } from '../../context/LanguageContext'

function cellColor(withinPct) {
  if (withinPct == null) return { background: '#f8fafc', color: '#9ca3af' }
  if (withinPct >= 50) return { background: 'var(--sem-green-bg)', color: 'var(--sem-green-fg)' }
  if (withinPct >= 25) return { background: 'var(--sem-yellow-bg)', color: 'var(--sem-yellow-fg)' }
  return { background: 'var(--sem-red-bg)', color: 'var(--sem-red-fg)' }
}

// Grilla ciudad (filas) × distancia (columnas) — celda = % dentro de banda
// + observaciones. Click hace drill-down al detalle de esa celda puntual.
export default function CityBracketBreakdown({ breakdown, onCellClick }) {
  const { t } = useI18n()
  const [selected, setSelected] = useState(null)

  const cities = useMemo(
    () => Array.from(new Set(breakdown.map((r) => r.city))).sort(),
    [breakdown]
  )
  const byKey = useMemo(() => {
    const m = new Map()
    for (const r of breakdown) m.set(`${r.city}|${r.distance_bracket}`, r)
    return m
  }, [breakdown])

  if (!breakdown.length) return null

  function handleClick(city, bracket, cell) {
    setSelected(`${city}|${bracket}`)
    onCellClick?.(city, bracket, cell)
  }

  return (
    <div className="config-section">
      <h2 style={{ margin: 0, marginBottom: 4 }}>{t('competitiveBands.breakdown.title')}</h2>
      <p style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 10 }}>
        {t('competitiveBands.breakdown.description')}
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table className="config-table config-table--modern">
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>{t('competitiveBands.breakdown.col_city')}</th>
              {BRACKETS.map((b) => (
                <th key={b} scope="col">
                  {BRACKET_LABELS[b]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cities.map((city) => (
              <tr key={city}>
                <td style={{ textAlign: 'left', fontWeight: 600 }}>{city}</td>
                {BRACKETS.map((b) => {
                  const cell = byKey.get(`${city}|${b}`)
                  const key = `${city}|${b}`
                  const style = cellColor(cell ? Number(cell.within_pct) : null)
                  return (
                    <td
                      key={b}
                      onClick={cell ? () => handleClick(city, b, cell) : undefined}
                      style={{
                        ...style,
                        cursor: cell ? 'pointer' : 'default',
                        outline: selected === key ? '2px solid var(--color-yango)' : 'none',
                        outlineOffset: -2,
                      }}
                      title={
                        cell
                          ? t('competitiveBands.breakdown.tooltip_cell', {
                              n: cell.total_observations,
                              pct: cell.p50,
                            })
                          : t('competitiveBands.breakdown.tooltip_no_data')
                      }
                    >
                      {cell ? (
                        <span style={{ fontWeight: 700 }}>
                          {cell.within_pct}%<br />
                          <span style={{ fontWeight: 400, fontSize: 10 }}>
                            n={Number(cell.total_observations).toLocaleString()}
                          </span>
                        </span>
                      ) : (
                        '—'
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
  )
}
