import { useMemo, useState } from 'react'
import { COMPETITOR_COLORS } from '../../lib/constants'

const THRESHOLD = 5

export default function WowCallouts({ priceMatrix, competitors, periods }) {
  const [dismissed, setDismissed] = useState(false)

  const movers = useMemo(() => {
    if (!periods || periods.length < 2) return []
    const last = periods[periods.length - 1]?.key
    const prev = periods[periods.length - 2]?.key
    if (!last || !prev) return []

    const out = []
    for (const comp of (competitors || [])) {
      const cur = priceMatrix?.[comp]?.[last]?.['_wa']
      const before = priceMatrix?.[comp]?.[prev]?.['_wa']
      if (cur == null || before == null || before === 0) continue
      const pct = ((cur - before) / before) * 100
      if (Math.abs(pct) >= THRESHOLD) {
        out.push({ comp, pct, cur, prev: before })
      }
    }
    out.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct))
    return out
  }, [priceMatrix, competitors, periods])

  if (dismissed || !movers.length) return null

  const lastLabel = periods[periods.length - 1]?.label || '—'
  const prevLabel = periods[periods.length - 2]?.label || '—'

  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '8px 14px', marginBottom: 10,
        background: 'linear-gradient(90deg, #fff7ed 0%, #fefce8 100%)',
        border: '1px solid #fcd34d',
        borderRadius: 8,
        fontSize: 12,
        flexWrap: 'wrap',
      }}
      role="status"
    >
      <span style={{ fontWeight: 700, color: '#b45309', flexShrink: 0 }}>
        ⚠ Cambios WoW {prevLabel} → {lastLabel}
      </span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, flex: 1 }}>
        {movers.slice(0, 6).map(m => {
          const up = m.pct > 0
          return (
            <span
              key={m.comp}
              title={`${m.comp}: ${m.prev.toFixed(2)} → ${m.cur.toFixed(2)}`}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                padding: '2px 8px', borderRadius: 4,
                background: '#fff', border: '1px solid #e5e7eb',
                fontWeight: 600,
              }}
            >
              <span style={{
                width: 8, height: 8, borderRadius: '50%',
                background: COMPETITOR_COLORS[m.comp] || '#64748b',
              }} />
              {m.comp}
              <span style={{ color: up ? '#b91c1c' : '#15803d' }}>
                {up ? '↑' : '↓'} {up ? '+' : ''}{m.pct.toFixed(1)}%
              </span>
            </span>
          )
        })}
      </div>
      <button
        onClick={() => setDismissed(true)}
        style={{
          background: 'none', border: 'none',
          fontSize: 16, lineHeight: 1, cursor: 'pointer',
          color: '#92400e', padding: '0 4px',
        }}
        title="Ocultar"
      >×</button>
    </div>
  )
}
