import { useMemo } from 'react'
import { COMPETITOR_COLORS, BRACKETS, BRACKET_LABELS } from '../../lib/constants'

const BRACKET_COLORS = {
  very_short: '#0ea5e9',
  short:      '#22c55e',
  median:     '#eab308',
  average:    '#f97316',
  long:       '#ef4444',
  very_long:  '#7c3aed',
}

export default function BracketMix({ sampleMatrix, periods, competitors }) {
  const rows = useMemo(() => {
    return competitors.map(comp => {
      const counts = {}
      let total = 0
      for (const b of BRACKETS) counts[b] = 0
      for (const p of periods) {
        for (const b of BRACKETS) {
          const n = sampleMatrix?.[comp]?.[p.key]?.[b] || 0
          counts[b] += n
          total += n
        }
      }
      const pcts = {}
      for (const b of BRACKETS) {
        pcts[b] = total > 0 ? (counts[b] / total) * 100 : 0
      }
      return { comp, counts, pcts, total }
    })
  }, [sampleMatrix, periods, competitors])

  if (!rows.length || !rows.some(r => r.total > 0)) {
    return <div style={{ fontSize: 12, color: 'var(--color-muted)', padding: 12 }}>Sin observaciones en el rango actual.</div>
  }

  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--color-muted)', marginBottom: 14 }}>
        Distribución de observaciones por bracket. Si dos competidores tienen distribuciones muy distintas,
        comparar su WA <em>directamente</em> puede engañar — confiá más en el delta por bracket.
      </div>

      {/* Stacked bars */}
      <div style={{ marginBottom: 16 }}>
        {rows.map(r => (
          <div key={r.comp} style={{ marginBottom: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
              <span style={{
                background: COMPETITOR_COLORS[r.comp] || '#64748b',
                color: '#fff', padding: '1px 6px', borderRadius: 3,
                fontWeight: 700, fontSize: 11,
              }}>{r.comp}</span>
              <span style={{ fontSize: 10, color: 'var(--color-muted)' }}>
                {r.total.toLocaleString()} observaciones
              </span>
            </div>
            <div style={{
              display: 'flex', height: 22, borderRadius: 4, overflow: 'hidden',
              border: '1px solid var(--color-border)',
              background: '#f1f5f9',
            }}>
              {BRACKETS.map(b => {
                const pct = r.pcts[b]
                if (pct === 0) return null
                return (
                  <div key={b}
                    title={`${BRACKET_LABELS[b]}: ${pct.toFixed(1)}% (${r.counts[b].toLocaleString()} obs)`}
                    style={{
                      width: `${pct}%`,
                      background: BRACKET_COLORS[b],
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 10, fontWeight: 700, color: '#fff',
                      borderRight: '1px solid rgba(255,255,255,0.3)',
                    }}>
                    {pct >= 8 ? `${pct.toFixed(0)}%` : ''}
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Tabla numérica */}
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 11 }}>
        <thead>
          <tr style={{ background: '#f8fafc' }}>
            <th style={th}>Competidor</th>
            {BRACKETS.map(b => (
              <th key={b} style={th}>
                <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: BRACKET_COLORS[b], marginRight: 4 }} />
                {BRACKET_LABELS[b]}
              </th>
            ))}
            <th style={th}>Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.comp} style={{ borderBottom: '1px solid var(--color-border-soft)' }}>
              <td style={{ ...td, textAlign: 'left' }}>
                <span style={{
                  background: COMPETITOR_COLORS[r.comp] || '#64748b',
                  color: '#fff', padding: '1px 6px', borderRadius: 3,
                  fontWeight: 700, fontSize: 10,
                }}>{r.comp}</span>
              </td>
              {BRACKETS.map(b => (
                <td key={b} style={td}>
                  {r.pcts[b] > 0 ? `${r.pcts[b].toFixed(1)}%` : '—'}
                  <div style={{ fontSize: 9, color: 'var(--color-muted)' }}>
                    {r.counts[b] > 0 ? r.counts[b].toLocaleString() : ''}
                  </div>
                </td>
              ))}
              <td style={{ ...td, fontWeight: 700 }}>{r.total.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const th = {
  padding: '6px 10px', textAlign: 'right',
  borderBottom: '2px solid var(--color-border)',
  fontSize: 10, fontWeight: 700, color: 'var(--color-muted)',
  textTransform: 'uppercase', letterSpacing: '0.4px',
}
const td = { padding: '6px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }
