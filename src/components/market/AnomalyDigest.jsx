import { useMemo } from 'react'
import { COMPETITOR_COLORS, BRACKETS, BRACKET_LABELS } from '../../lib/constants'

// z-score sobre rolling mean. Devuelve top N anomalías.
export default function AnomalyDigest({ priceMatrix, periods, competitors, compareVs = 'Yango', limit = 10 }) {
  const anomalies = useMemo(() => {
    if (!periods?.length || periods.length < 4) return []   // necesito histórico para rolling mean
    const out = []
    const lastIdx = periods.length - 1
    const lastPeriod = periods[lastIdx]

    for (const comp of competitors) {
      for (const b of [...BRACKETS, '_wa']) {
        const series = periods.map(p => priceMatrix[comp]?.[p.key]?.[b]).filter(v => v != null)
        if (series.length < 4) continue
        const cur = priceMatrix[comp]?.[lastPeriod.key]?.[b]
        if (cur == null) continue

        // rolling stats sobre todo menos el último período
        const hist = series.slice(0, -1)
        const mean = hist.reduce((a, n) => a + n, 0) / hist.length
        const variance = hist.reduce((a, n) => a + (n - mean) ** 2, 0) / hist.length
        const sd = Math.sqrt(variance)
        if (sd < 0.05) continue   // serie demasiado estable, ignorar

        const z = (cur - mean) / sd
        if (Math.abs(z) >= 2) {
          const pct = ((cur - mean) / mean) * 100
          out.push({
            comp,
            bracket: b,
            cur,
            mean,
            sd,
            z,
            pct,
            kind: 'price',
          })
        }
      }
    }

    // detectar pérdida/ganancia de rank (Yango)
    if (lastIdx >= 1) {
      const prevPeriod = periods[lastIdx - 1]
      const rankAt = (key) => {
        const arr = competitors
          .map(c => ({ comp: c, wa: priceMatrix[c]?.[key]?.['_wa'] }))
          .filter(x => x.wa != null)
          .sort((a, b) => a.wa - b.wa)
        const idx = arr.findIndex(x => x.comp === compareVs)
        return idx >= 0 ? idx + 1 : null
      }
      const curRank = rankAt(lastPeriod.key)
      const prevRank = rankAt(prevPeriod.key)
      if (curRank && prevRank && curRank !== prevRank) {
        out.push({
          comp: compareVs,
          kind: 'rank',
          curRank,
          prevRank,
          delta: curRank - prevRank,
        })
      }
    }

    // ordenar por severidad: rank changes primero, luego por |z|
    return out
      .sort((a, b) => {
        if (a.kind !== b.kind) return a.kind === 'rank' ? -1 : 1
        return Math.abs(b.z || 0) - Math.abs(a.z || 0)
      })
      .slice(0, limit)
  }, [priceMatrix, periods, competitors, compareVs, limit])

  if (!periods || periods.length < 4) {
    return (
      <div style={{ fontSize: 12, color: 'var(--color-muted)', padding: 12, textAlign: 'center' }}>
        Necesito al menos 4 períodos de histórico para detectar atípicos.
        Aumenta el rango de fechas en los filtros.
      </div>
    )
  }

  if (!anomalies.length) {
    return (
      <div style={{ fontSize: 12, color: 'var(--color-muted)', padding: 12, textAlign: 'center' }}>
        ✓ Sin movimientos atípicos en este rango (todos los precios dentro de ±2σ del promedio histórico).
      </div>
    )
  }

  const lastLabel = periods[periods.length - 1]?.label || ''

  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--color-muted)', marginBottom: 10 }}>
        Top {anomalies.length} movimientos atípicos · referencia: <strong>{lastLabel}</strong>
      </div>
      <ol style={{ paddingLeft: 0, listStyle: 'none', margin: 0 }}>
        {anomalies.map((a, i) => (
          <li key={i} style={{
            display: 'flex', alignItems: 'flex-start', gap: 10,
            padding: '10px 0',
            borderBottom: '1px solid var(--color-border-soft)',
          }}>
            <span style={{
              flexShrink: 0, width: 24, height: 24, borderRadius: 4,
              background: a.kind === 'rank' ? '#fee2e2' : (a.pct < 0 ? '#dbeafe' : '#fef3c7'),
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 13,
            }}>
              {a.kind === 'rank' ? (a.delta > 0 ? '🔻' : '🔺') : (a.pct < 0 ? '📉' : '📈')}
            </span>
            <div style={{ flex: 1, fontSize: 13 }}>
              {a.kind === 'rank' ? (
                <>
                  <strong>{a.comp}</strong> {a.delta > 0 ? 'cayó' : 'subió'} de
                  posición <strong>{a.prevRank}º</strong> a <strong>{a.curRank}º</strong>{' '}
                  <span style={{ color: 'var(--color-muted)', fontSize: 11 }}>
                    ({a.delta > 0 ? '-' : '+'}{Math.abs(a.delta)} puesto{Math.abs(a.delta) === 1 ? '' : 's'})
                  </span>
                </>
              ) : (
                <>
                  <span style={{
                    background: COMPETITOR_COLORS[a.comp] || '#64748b',
                    color: '#fff', padding: '1px 6px', borderRadius: 3,
                    fontWeight: 700, fontSize: 11, marginRight: 6,
                  }}>{a.comp}</span>
                  {a.bracket === '_wa' ? 'WA (todos los brackets)' : (BRACKET_LABELS[a.bracket] || a.bracket)}{' '}
                  <strong style={{ color: a.pct < 0 ? '#15803d' : '#b91c1c' }}>
                    {a.pct >= 0 ? '+' : ''}{a.pct.toFixed(1)}%
                  </strong>{' '}
                  <span style={{ color: 'var(--color-muted)', fontSize: 11 }}>
                    ({a.cur.toFixed(2)} vs avg histórico {a.mean.toFixed(2)} · z={a.z.toFixed(1)})
                  </span>
                </>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}
