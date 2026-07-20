import { useState, useEffect, useCallback } from 'react'
import { sb } from '../../lib/supabase'
import { BRACKETS, BRACKET_LABELS } from '../../lib/constants'

// Panel de frescura de la data del bot por ciudad × bracket.
//
// POR QUÉ: el badge "Bot hace X min" refleja cuándo corrió el SYNC, no qué
// tan fresca es la DATA. Cuando el scraper externo deja de producir para una
// ciudad/bracket, el sync sigue verde pero esos brackets quedan stale sin
// aviso. Este panel muestra la última observación por celda para que un
// stall salte a la vista.
//
// Lee de la RPC bot_coverage_recent (mig 134). Si la RPC todavía no está
// aplicada en el proyecto, la llamada falla → el panel NO renderiza nada
// (queda inerte, cero ruido visual) hasta que la función exista.

// Umbral de "atraso" de un bracket RELATIVO al bracket más fresco de su misma
// ciudad — comparación relativa dentro de la ciudad, así no depende de la
// zona horaria del país (todas las celdas de una ciudad comparten tz real).
const STALE_WARN_MIN = 60 // amarillo si un bracket va >1h detrás del más fresco de su ciudad
const STALE_BAD_MIN = 180 // rojo si va >3h detrás

function cellInstant(row) {
  if (!row?.last_date || !row?.last_time) return null
  const ms = Date.parse(`${row.last_date}T${row.last_time}`)
  return Number.isNaN(ms) ? null : ms
}

function hhmm(t) {
  if (!t) return '—'
  return String(t).slice(0, 5)
}

function staleColors(gapMin) {
  if (gapMin == null) return { bg: '#f1f5f9', fg: '#94a3b8' } // sin data
  if (gapMin > STALE_BAD_MIN) return { bg: '#fee2e2', fg: '#991b1b' }
  if (gapMin > STALE_WARN_MIN) return { bg: '#fef9c3', fg: '#854d0e' }
  return { bg: '#dcfce7', fg: '#166534' }
}

export default function BotCoveragePanel({ country, t }) {
  const [rows, setRows] = useState(null) // null = aún no cargó / RPC ausente
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    try {
      const { data, error } = await sb.rpc('bot_coverage_recent', { p_country: country })
      if (error) {
        setFailed(true)
        setRows(null)
        return
      }
      setFailed(false)
      setRows(Array.isArray(data) ? data : [])
    } catch {
      setFailed(true)
      setRows(null)
    }
  }, [country])

  useEffect(() => {
    load()
  }, [load])

  // RPC ausente/fallida o sin data → no renderizar nada (inerte).
  if (failed || !rows || rows.length === 0) return null

  // Pivot: ciudad → { bracket → row }
  const byCity = {}
  for (const r of rows) {
    if (!r?.city || !r?.distance_bracket) continue
    ;(byCity[r.city] ||= {})[r.distance_bracket] = r
  }
  const cities = Object.keys(byCity).sort()
  if (cities.length === 0) return null

  return (
    <div style={{ marginTop: 20 }}>
      <h3 style={{ fontSize: 14, marginBottom: 2 }}>{t('botdbsync.coverage_title')}</h3>
      <div style={{ fontSize: 11, color: '#64748b', marginBottom: 8 }}>
        {t('botdbsync.coverage_subtitle')}
      </div>

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
              const instants = BRACKETS.map((b) => cellInstant(cityRows[b])).filter(
                (x) => x != null
              )
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

      <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 6, fontStyle: 'italic' }}>
        {t('botdbsync.coverage_legend')}
      </div>
    </div>
  )
}
