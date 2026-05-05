import { useMemo } from 'react'
import { COMPETITOR_COLORS, BRACKETS, BRACKET_LABELS } from '../../lib/constants'

const SAMPLE_LOW = 30
const SAMPLE_MED = 100

function bg(n) {
  if (!n)              return '#f1f5f9'
  if (n < SAMPLE_LOW)  return '#fee2e2'
  if (n < SAMPLE_MED)  return '#fef9c3'
  return '#dcfce7'
}
function fg(n) {
  if (!n)              return '#94a3b8'
  if (n < SAMPLE_LOW)  return '#991b1b'
  if (n < SAMPLE_MED)  return '#854d0e'
  return '#166534'
}

export default function CoverageReport({ sampleMatrix, periods, competitors }) {
  const grid = useMemo(() => {
    if (!periods?.length) return []
    return competitors.map(comp => {
      const row = { comp }
      let totalCells = 0
      let lowCells   = 0
      for (const p of periods) {
        for (const b of BRACKETS) {
          const n = sampleMatrix?.[comp]?.[p.key]?.[b] || 0
          totalCells++
          if (n < SAMPLE_LOW) lowCells++
          row[`${p.key}__${b}`] = n
        }
      }
      row.totalCells = totalCells
      row.lowCells = lowCells
      row.healthPct = totalCells > 0 ? Math.round((1 - lowCells / totalCells) * 100) : 0
      return row
    })
  }, [sampleMatrix, periods, competitors])

  if (!grid.length) {
    return <div style={{ fontSize: 12, color: 'var(--color-muted)', padding: 12 }}>Sin datos en el rango actual.</div>
  }

  return (
    <div>
      {/* Resumen de salud por competidor */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
        {grid.map(r => (
          <div key={r.comp} style={{
            background: '#fff',
            border: '1px solid var(--color-border)',
            borderRadius: 6,
            padding: '8px 12px',
            minWidth: 140,
          }}>
            <div style={{ fontSize: 11, color: 'var(--color-muted)', marginBottom: 2 }}>
              <span style={{
                background: COMPETITOR_COLORS[r.comp] || '#64748b',
                color: '#fff', padding: '1px 6px', borderRadius: 3,
                fontWeight: 700, fontSize: 10,
              }}>{r.comp}</span>
            </div>
            <div style={{ fontSize: 18, fontWeight: 700, color: r.healthPct >= 80 ? '#15803d' : r.healthPct >= 50 ? '#a16207' : '#b91c1c' }}>
              {r.healthPct}%
            </div>
            <div style={{ fontSize: 10, color: 'var(--color-muted)' }}>
              celdas con n≥{SAMPLE_LOW} ({r.totalCells - r.lowCells}/{r.totalCells})
            </div>
          </div>
        ))}
      </div>

      {/* Matriz detallada */}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr>
              <th style={{ ...thFixed, position: 'sticky', left: 0, background: '#fff', zIndex: 1 }}>Competidor</th>
              <th style={thFixed}>Bracket</th>
              {periods.map(p => <th key={p.key} style={th}>{p.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {competitors.map(comp =>
              BRACKETS.map((b, bi) => (
                <tr key={`${comp}-${b}`} style={{ borderBottom: bi === BRACKETS.length - 1 ? '2px solid var(--color-border)' : '1px solid var(--color-border-soft)' }}>
                  {bi === 0 && (
                    <td rowSpan={BRACKETS.length} style={{ ...tdFixed, position: 'sticky', left: 0, background: '#f8fafc', zIndex: 1, verticalAlign: 'middle' }}>
                      <span style={{
                        background: COMPETITOR_COLORS[comp] || '#64748b',
                        color: '#fff', padding: '1px 6px', borderRadius: 3,
                        fontWeight: 700, fontSize: 10,
                      }}>{comp}</span>
                    </td>
                  )}
                  <td style={{ ...tdFixed, fontSize: 10, color: 'var(--color-muted)' }}>{BRACKET_LABELS[b]}</td>
                  {periods.map(p => {
                    const n = sampleMatrix?.[comp]?.[p.key]?.[b] || 0
                    return (
                      <td key={p.key} style={{
                        ...td,
                        background: bg(n),
                        color: fg(n),
                        fontWeight: 600,
                      }}>
                        {n || '—'}
                      </td>
                    )
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div style={{ fontSize: 11, color: 'var(--color-muted)', marginTop: 10, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <span><span style={swatch('#fee2e2')} /> &lt;{SAMPLE_LOW} obs (poco confiable)</span>
        <span><span style={swatch('#fef9c3')} /> {SAMPLE_LOW}–{SAMPLE_MED - 1}</span>
        <span><span style={swatch('#dcfce7')} /> ≥{SAMPLE_MED} (sólido)</span>
        <span><span style={swatch('#f1f5f9')} /> sin observaciones</span>
      </div>
    </div>
  )
}

const th = {
  padding: '6px 8px', textAlign: 'center',
  borderBottom: '2px solid var(--color-border)',
  fontSize: 9, fontWeight: 700, color: 'var(--color-muted)',
  textTransform: 'uppercase', letterSpacing: '0.4px',
  whiteSpace: 'nowrap',
}
const thFixed = { ...th, textAlign: 'left' }
const td = {
  padding: '4px 8px', textAlign: 'center',
  fontVariantNumeric: 'tabular-nums',
  minWidth: 50,
}
const tdFixed = { ...td, textAlign: 'left', fontSize: 11 }
function swatch(c) {
  return {
    display: 'inline-block', width: 10, height: 10, borderRadius: 2,
    background: c, marginRight: 4, verticalAlign: 'middle',
    border: '1px solid rgba(0,0,0,0.1)',
  }
}
