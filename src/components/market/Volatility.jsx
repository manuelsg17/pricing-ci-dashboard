import { useMemo } from 'react'
import { COMPETITOR_COLORS } from '../../lib/constants'

function stats(values) {
  const v = values.filter(x => x != null && !isNaN(x))
  if (v.length < 2) return null
  const mean = v.reduce((a, b) => a + b, 0) / v.length
  const variance = v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length
  const sd = Math.sqrt(variance)
  return { mean, sd, n: v.length, cv: mean > 0 ? sd / mean : null }
}

function Sparkline({ values, color }) {
  const v = values.filter(x => x != null)
  if (v.length < 2) return null
  const min = Math.min(...v)
  const max = Math.max(...v)
  const range = max - min || 1
  const W = 120, H = 24
  const pts = values.map((val, i) => {
    if (val == null) return null
    const x = (i / (values.length - 1)) * W
    const y = H - ((val - min) / range) * (H - 4) - 2
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).filter(Boolean).join(' ')
  return (
    <svg width={W} height={H}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export default function Volatility({ priceMatrix, periods, competitors, currency = 'S/' }) {
  const rows = useMemo(() => {
    return competitors.map(comp => {
      const series = periods.map(p => priceMatrix[comp]?.[p.key]?.['_wa'])
      const validSeries = series.filter(v => v != null)
      const s = stats(validSeries)
      return { comp, series, ...s }
    }).sort((a, b) => (b.sd || 0) - (a.sd || 0))   // más volátil primero
  }, [priceMatrix, periods, competitors])

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
        <thead>
          <tr style={{ background: '#f8fafc' }}>
            <th style={th}>Competidor</th>
            <th style={th}>Avg WA ({currency})</th>
            <th style={th}>σ (desv.)</th>
            <th style={th}>CV (%)</th>
            <th style={th}>n períodos</th>
            <th style={{ ...th, textAlign: 'left' }}>Tendencia</th>
            <th style={{ ...th, textAlign: 'left' }}>Interpretación</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const cvPct = r.cv != null ? r.cv * 100 : null
            const tag = cvPct == null
              ? { text: 'Datos insuficientes', color: '#94a3b8' }
              : cvPct < 3   ? { text: 'Muy estable',  color: '#15803d' }
              : cvPct < 8   ? { text: 'Estable',      color: '#65a30d' }
              : cvPct < 15  ? { text: 'Volátil',      color: '#a16207' }
              :               { text: 'Muy volátil',  color: '#b91c1c' }
            return (
              <tr key={r.comp} style={{ borderBottom: '1px solid var(--color-border-soft)' }}>
                <td style={{ ...td, textAlign: 'left' }}>
                  <span style={{
                    background: COMPETITOR_COLORS[r.comp] || '#64748b',
                    color: '#fff', padding: '1px 6px', borderRadius: 3,
                    fontWeight: 700, fontSize: 11,
                  }}>{r.comp}</span>
                </td>
                <td style={td}>{r.mean != null ? r.mean.toFixed(2) : '—'}</td>
                <td style={td}>{r.sd  != null ? r.sd.toFixed(2)   : '—'}</td>
                <td style={td}>{cvPct != null ? cvPct.toFixed(1) + '%' : '—'}</td>
                <td style={td}>{r.n ?? 0}</td>
                <td style={{ ...td, textAlign: 'left' }}>
                  <Sparkline values={r.series} color={COMPETITOR_COLORS[r.comp] || '#64748b'} />
                </td>
                <td style={{ ...td, textAlign: 'left', color: tag.color, fontWeight: 600 }}>
                  {tag.text}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <div style={{ fontSize: 11, color: 'var(--color-muted)', marginTop: 8 }}>
        CV = σ / promedio · &lt;3% muy estable, 3-8% estable, 8-15% volátil, ≥15% muy volátil.
      </div>
    </div>
  )
}

const th = {
  padding: '6px 10px', textAlign: 'right',
  borderBottom: '2px solid var(--color-border)',
  fontSize: 10, fontWeight: 700, color: 'var(--color-muted)',
  textTransform: 'uppercase', letterSpacing: '0.4px',
}
const td = {
  padding: '8px 10px', textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
}
