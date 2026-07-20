import { BRACKETS, BRACKET_LABELS } from '../../lib/constants'
import { cellInstant, hhmm, staleColors, pivotByCity } from '../../lib/botCoverage'

// Matriz presentacional ciudad × bracket con la última observación por celda,
// coloreada por atraso RELATIVO al bracket más fresco de su misma ciudad
// (comparación intra-ciudad → no depende de la zona horaria del país).
// Compartida entre el panel de Bot DB Sync y la tarjeta del dashboard.
// Los helpers viven en ../../lib/botCoverage (puros, testeables, sin romper
// react-refresh de este archivo).
export default function BotCoverageMatrix({ rows, t }) {
  const byCity = pivotByCity(rows)
  const cities = Object.keys(byCity).sort()
  if (cities.length === 0) return null

  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="config-table" style={{ fontSize: 11 }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left' }}>{t('botdbsync.coverage_col_city')}</th>
            {BRACKETS.map((b) => (
              <th key={b} style={{ textAlign: 'center' }}>
                {BRACKET_LABELS[b] || b}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cities.map((city) => {
            const cityRows = byCity[city]
            const instants = BRACKETS.map((b) => cellInstant(cityRows[b])).filter((x) => x != null)
            const cityRef = instants.length ? Math.max(...instants) : null
            return (
              <tr key={city}>
                <td style={{ fontWeight: 600 }}>{city}</td>
                {BRACKETS.map((b) => {
                  const row = cityRows[b]
                  const inst = cellInstant(row)
                  const gapMin =
                    inst != null && cityRef != null ? Math.round((cityRef - inst) / 60000) : null
                  const c = staleColors(row ? gapMin : null)
                  const title = row
                    ? t('botdbsync.coverage_cell_title', {
                        date: row.last_date,
                        time: hhmm(row.last_time),
                        n: row.n_recent ?? 0,
                        gap: gapMin ?? 0,
                      })
                    : t('botdbsync.coverage_cell_none')
                  return (
                    <td
                      key={b}
                      title={title}
                      style={{
                        textAlign: 'center',
                        background: c.bg,
                        color: c.fg,
                        fontWeight: 600,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {row ? hhmm(row.last_time) : '—'}
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
