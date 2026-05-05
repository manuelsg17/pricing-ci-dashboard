import { useMemo } from 'react'
import { BRACKETS, BRACKET_LABELS } from '../../lib/constants'

export default function WinLossByBracket({ priceMatrix, periods, competitors, compareVs = 'Yango' }) {
  const grid = useMemo(() => {
    if (!periods?.length) return []
    return periods.map(p => {
      const wins = {}
      let totalChecked = 0
      let totalWon = 0
      for (const b of BRACKETS) {
        const arr = competitors
          .map(c => ({ comp: c, price: priceMatrix[c]?.[p.key]?.[b] }))
          .filter(x => x.price != null)
        if (arr.length < 2) {
          wins[b] = null   // sin comparables, no se puede determinar líder
          continue
        }
        totalChecked++
        const cheapest = arr.reduce((m, x) => (x.price < m.price ? x : m), arr[0])
        const isYangoLeader = cheapest.comp === compareVs
        wins[b] = isYangoLeader ? 'win' : 'loss'
        if (isYangoLeader) totalWon++
      }
      return { period: p, wins, totalChecked, totalWon }
    })
  }, [priceMatrix, periods, competitors, compareVs])

  // Resumen por bracket: % de períodos donde Yango ganó
  const byBracketPct = useMemo(() => {
    const result = {}
    for (const b of BRACKETS) {
      let total = 0
      let won  = 0
      for (const row of grid) {
        if (row.wins[b] === null) continue
        total++
        if (row.wins[b] === 'win') won++
      }
      result[b] = total > 0 ? Math.round((won / total) * 100) : null
    }
    return result
  }, [grid])

  if (!grid.length) {
    return <div style={{ fontSize: 12, color: 'var(--color-muted)', textAlign: 'center', padding: 12 }}>Sin datos.</div>
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
        <thead>
          <tr style={{ background: '#f8fafc' }}>
            <th style={th}>Período</th>
            {BRACKETS.map(b => <th key={b} style={th}>{BRACKET_LABELS[b]}</th>)}
            <th style={th}>Total</th>
          </tr>
        </thead>
        <tbody>
          {grid.map((row, i) => (
            <tr key={i} style={{ borderBottom: '1px solid var(--color-border-soft)' }}>
              <td style={{ ...td, fontWeight: 600, textAlign: 'left' }}>{row.period.label}</td>
              {BRACKETS.map(b => {
                const v = row.wins[b]
                return (
                  <td key={b} style={{
                    ...td,
                    background: v === 'win' ? '#dcfce7' : v === 'loss' ? '#fee2e2' : '#f1f5f9',
                    color:      v === 'win' ? '#166534' : v === 'loss' ? '#991b1b' : '#94a3b8',
                    fontSize: 14,
                  }}>
                    {v === 'win' ? '✓' : v === 'loss' ? '✗' : '—'}
                  </td>
                )
              })}
              <td style={{ ...td, fontWeight: 700 }}>
                {row.totalChecked ? `${row.totalWon}/${row.totalChecked}` : '—'}
              </td>
            </tr>
          ))}
          <tr style={{ background: '#fffbe5', fontWeight: 700 }}>
            <td style={{ ...td, textAlign: 'left' }}>% líder</td>
            {BRACKETS.map(b => {
              const pct = byBracketPct[b]
              return (
                <td key={b} style={{
                  ...td,
                  color: pct == null ? '#94a3b8' : pct >= 67 ? '#15803d' : pct >= 33 ? '#a16207' : '#b91c1c',
                }}>
                  {pct == null ? '—' : `${pct}%`}
                </td>
              )
            })}
            <td style={td}>—</td>
          </tr>
        </tbody>
      </table>
      <div style={{ fontSize: 11, color: 'var(--color-muted)', marginTop: 8 }}>
        ✓ {compareVs} fue el más barato del bracket · ✗ otro competidor lideró · — sin comparables.
      </div>
    </div>
  )
}

const th = {
  padding: '6px 10px',
  textAlign: 'center',
  borderBottom: '2px solid var(--color-border)',
  fontSize: 10,
  fontWeight: 700,
  color: 'var(--color-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.4px',
}

const td = {
  padding: '6px 10px',
  textAlign: 'center',
  fontVariantNumeric: 'tabular-nums',
}
