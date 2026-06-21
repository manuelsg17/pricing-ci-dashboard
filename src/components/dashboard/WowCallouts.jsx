import { useMemo, useState } from 'react'
import { COMPETITOR_COLORS } from '../../lib/constants'
import { prettyCompetitor } from '../../lib/normalize'
import { AlertTriangle, ArrowUp, ArrowDown, X } from 'lucide-react'

const THRESHOLD = 5

export default function WowCallouts({ priceMatrix, competitors, periods }) {
  const [dismissed, setDismissed] = useState(false)

  const movers = useMemo(() => {
    if (!periods || periods.length < 2) return []
    const last = periods[periods.length - 1]?.key
    const prev = periods[periods.length - 2]?.key
    if (!last || !prev) return []

    const out = []
    for (const comp of competitors || []) {
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
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '8px 14px',
        marginBottom: 10,
        background: '#fffdf5',
        border: '1px solid #fde9b8',
        borderLeft: '3px solid #f59e0b',
        borderRadius: 10,
        fontSize: 12,
        flexWrap: 'wrap',
      }}
      role="status"
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          fontWeight: 700,
          color: '#b45309',
          flexShrink: 0,
        }}
      >
        <AlertTriangle size={14} /> Cambios WoW {prevLabel} → {lastLabel}
      </span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, flex: 1 }}>
        {movers.slice(0, 6).map((m) => {
          const up = m.pct > 0
          return (
            <span
              key={m.comp}
              title={`${prettyCompetitor(m.comp)}: ${m.prev.toFixed(2)} → ${m.cur.toFixed(2)}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                padding: '2px 8px',
                borderRadius: 4,
                background: '#fff',
                border: '1px solid #e5e7eb',
                fontWeight: 600,
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: COMPETITOR_COLORS[m.comp] || '#64748b',
                }}
              />
              {prettyCompetitor(m.comp)}
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 2,
                  color: up ? '#b91c1c' : '#15803d',
                }}
              >
                {up ? <ArrowUp size={12} /> : <ArrowDown size={12} />}
                {up ? '+' : ''}
                {m.pct.toFixed(1)}%
              </span>
            </span>
          )
        })}
      </div>
      <button
        onClick={() => setDismissed(true)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          background: 'none',
          border: 'none',
          lineHeight: 1,
          cursor: 'pointer',
          color: '#92400e',
          padding: '0 4px',
        }}
        title="Ocultar"
      >
        <X size={15} />
      </button>
    </div>
  )
}
