import { useEffect, useState, useMemo } from 'react'
import { sb } from '../../lib/supabase'
import { COMPETITOR_COLORS } from '../../lib/constants'

export default function RushVsValley({ filters, currency = 'S/' }) {
  const [rawRows, setRawRows] = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!filters.dbCity || !filters.dbCategory) return
    let cancelled = false
    setLoading(true)
    const startDate = filters.weekColumns?.[0]
      ? toISO(filters.weekColumns[0])
      : toISO(new Date(Date.now() - 56 * 86400_000))
    const endDate = filters.weekColumns?.length
      ? toISO(addDays(filters.weekColumns[filters.weekColumns.length - 1], 6))
      : toISO(new Date())

    sb.from('pricing_observations')
      .select('competition_name, rush_hour, price_without_discount, recommended_price')
      .eq('country', filters.country)
      .eq('city', filters.dbCity)
      .eq('category', filters.dbCategory)
      .gte('observed_date', startDate)
      .lte('observed_date', endDate)
      .not('rush_hour', 'is', null)
      .limit(50000)
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) console.error('RushVsValley error:', error)
        setRawRows(data || [])
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [filters.country, filters.dbCity, filters.dbCategory, filters.weekColumns])

  const rows = useMemo(() => {
    const buckets = {}
    for (const r of rawRows) {
      const price = r.price_without_discount ?? r.recommended_price
      if (price == null || price <= 0) continue
      const comp = r.competition_name
      if (!buckets[comp]) buckets[comp] = { rush: [], valley: [] }
      ;(r.rush_hour ? buckets[comp].rush : buckets[comp].valley).push(Number(price))
    }
    const out = []
    for (const [comp, b] of Object.entries(buckets)) {
      const valleyAvg = b.valley.length ? b.valley.reduce((a, n) => a + n, 0) / b.valley.length : null
      const rushAvg   = b.rush.length   ? b.rush.reduce((a, n) => a + n, 0)   / b.rush.length   : null
      const diffPct = (valleyAvg && rushAvg) ? ((rushAvg - valleyAvg) / valleyAvg) * 100 : null
      out.push({
        comp,
        valleyAvg, rushAvg, diffPct,
        valleyN: b.valley.length, rushN: b.rush.length,
      })
    }
    return out.sort((a, b) => (b.diffPct || 0) - (a.diffPct || 0))
  }, [rawRows])

  if (loading && !rawRows.length) {
    return <div style={{ fontSize: 12, color: 'var(--color-muted)', padding: 12 }}>Cargando…</div>
  }
  if (!rows.length) {
    return <div style={{ fontSize: 12, color: 'var(--color-muted)', padding: 12 }}>Sin observaciones con rush_hour clasificado en este rango.</div>
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
        <thead>
          <tr style={{ background: '#f8fafc' }}>
            <th style={th}>Competidor</th>
            <th style={th}>Valley ({currency})</th>
            <th style={th}>n valley</th>
            <th style={th}>Rush ({currency})</th>
            <th style={th}>n rush</th>
            <th style={th}>Diff %</th>
            <th style={{ ...th, textAlign: 'left' }}>Surge</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const tag = r.diffPct == null ? null
              : r.diffPct < 5   ? { text: 'Suave',     color: '#15803d' }
              : r.diffPct < 12  ? { text: 'Moderado',  color: '#65a30d' }
              : r.diffPct < 20  ? { text: 'Fuerte',    color: '#a16207' }
              :                   { text: 'Agresivo',  color: '#b91c1c' }
            return (
              <tr key={r.comp} style={{ borderBottom: '1px solid var(--color-border-soft)' }}>
                <td style={{ ...td, textAlign: 'left' }}>
                  <span style={{
                    background: COMPETITOR_COLORS[r.comp] || '#64748b',
                    color: '#fff', padding: '1px 6px', borderRadius: 3,
                    fontWeight: 700, fontSize: 11,
                  }}>{r.comp}</span>
                </td>
                <td style={td}>{r.valleyAvg != null ? r.valleyAvg.toFixed(2) : '—'}</td>
                <td style={tdMuted}>{r.valleyN.toLocaleString()}</td>
                <td style={td}>{r.rushAvg != null ? r.rushAvg.toFixed(2) : '—'}</td>
                <td style={tdMuted}>{r.rushN.toLocaleString()}</td>
                <td style={{ ...td, fontWeight: 700, color: r.diffPct > 0 ? '#b91c1c' : r.diffPct < 0 ? '#15803d' : 'inherit' }}>
                  {r.diffPct == null ? '—' : `${r.diffPct >= 0 ? '+' : ''}${r.diffPct.toFixed(1)}%`}
                </td>
                <td style={{ ...td, textAlign: 'left', color: tag?.color, fontWeight: 600 }}>
                  {tag?.text || '—'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function toISO(d) {
  const dt = new Date(d)
  return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`
}
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r }

const th = {
  padding: '6px 10px', textAlign: 'right',
  borderBottom: '2px solid var(--color-border)',
  fontSize: 10, fontWeight: 700, color: 'var(--color-muted)',
  textTransform: 'uppercase', letterSpacing: '0.4px',
}
const td = { padding: '6px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }
const tdMuted = { ...td, color: 'var(--color-muted)', fontSize: 11 }
