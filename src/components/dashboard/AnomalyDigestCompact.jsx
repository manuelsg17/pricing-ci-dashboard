import { useMemo } from 'react'
import { COMPETITOR_COLORS, BRACKETS, BRACKET_LABELS } from '../../lib/constants'

// Versión compact: muestra los top 3 atípicos en una sola línea con
// link a la pestaña Mercado para ver el detalle completo.
export default function AnomalyDigestCompact({ priceMatrix, periods, competitors, compareVs = 'Yango' }) {
  const top = useMemo(() => {
    if (!periods?.length || periods.length < 4) return []
    const out = []
    const lastIdx = periods.length - 1
    const lastPeriod = periods[lastIdx]

    for (const comp of competitors) {
      for (const b of [...BRACKETS, '_wa']) {
        const series = periods.map(p => priceMatrix[comp]?.[p.key]?.[b]).filter(v => v != null)
        if (series.length < 4) continue
        const cur = priceMatrix[comp]?.[lastPeriod.key]?.[b]
        if (cur == null) continue
        const hist = series.slice(0, -1)
        const mean = hist.reduce((a, n) => a + n, 0) / hist.length
        const variance = hist.reduce((a, n) => a + (n - mean) ** 2, 0) / hist.length
        const sd = Math.sqrt(variance)
        if (sd < 0.05) continue
        const z = (cur - mean) / sd
        if (Math.abs(z) >= 2) {
          out.push({ comp, bracket: b, pct: ((cur - mean) / mean) * 100, z })
        }
      }
    }
    return out.sort((a, b) => Math.abs(b.z) - Math.abs(a.z)).slice(0, 3)
  }, [priceMatrix, periods, competitors, compareVs])

  if (!top.length) return null

  function goToMarket() {
    window.dispatchEvent(new CustomEvent('navigate-to-tab', { detail: { tab: 'market', section: 'anomalies' } }))
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '6px 12px', marginBottom: 8,
      background: '#fffbeb',
      border: '1px solid #fcd34d',
      borderRadius: 6,
      fontSize: 12,
      flexWrap: 'wrap',
    }}>
      <span style={{ fontWeight: 700, color: '#92400e', flexShrink: 0 }}>
        🔍 {top.length} atípico{top.length === 1 ? '' : 's'} esta semana:
      </span>
      <div style={{ display: 'flex', gap: 6, flex: 1, flexWrap: 'wrap' }}>
        {top.map((a, i) => (
          <span key={i} style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '1px 6px', borderRadius: 3,
            background: '#fff', border: '1px solid #fde68a', fontSize: 11,
          }}>
            <span style={{
              background: COMPETITOR_COLORS[a.comp] || '#64748b',
              color: '#fff', padding: '0 4px', borderRadius: 2,
              fontWeight: 700, fontSize: 10,
            }}>{a.comp}</span>
            {a.bracket === '_wa' ? 'WA' : (BRACKET_LABELS[a.bracket] || a.bracket)}
            <strong style={{ color: a.pct < 0 ? '#15803d' : '#b91c1c' }}>
              {a.pct >= 0 ? '+' : ''}{a.pct.toFixed(1)}%
            </strong>
          </span>
        ))}
      </div>
      <button
        onClick={goToMarket}
        style={{
          padding: '2px 10px', fontSize: 11, fontWeight: 600,
          background: '#fff', border: '1px solid #b45309',
          color: '#92400e', borderRadius: 4, cursor: 'pointer',
          whiteSpace: 'nowrap',
        }}
      >
        Ver detalle →
      </button>
    </div>
  )
}
