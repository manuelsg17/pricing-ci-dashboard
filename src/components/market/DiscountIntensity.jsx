import { useEffect, useState, useMemo } from 'react'
import { sb } from '../../lib/supabase'
import { COMPETITOR_COLORS } from '../../lib/constants'

export default function DiscountIntensity({ filters, currency = 'S/' }) {
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
      .select('competition_name, price_without_discount, price_with_discount, recommended_price, minimal_bid')
      .eq('country', filters.country)
      .eq('city', filters.dbCity)
      .eq('category', filters.dbCategory)
      .gte('observed_date', startDate)
      .lte('observed_date', endDate)
      .limit(50000)
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) console.error('DiscountIntensity error:', error)
        setRawRows(data || [])
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [filters.country, filters.dbCity, filters.dbCategory, filters.weekColumns])

  const rows = useMemo(() => {
    const buckets = {}
    for (const r of rawRows) {
      const comp = r.competition_name
      // Para InDrive: comparamos minimal_bid vs recommended_price (descuento del bidder)
      // Para los demás: price_with_discount vs price_without_discount.
      const list  = comp === 'InDrive' ? r.recommended_price : r.price_without_discount
      const final = comp === 'InDrive' ? r.minimal_bid       : r.price_with_discount
      if (list == null || final == null || list <= 0) continue
      const fl = Number(final), li = Number(list)
      if (fl <= 0) continue
      if (!buckets[comp]) buckets[comp] = { lists: [], finals: [], obs: 0, withDiscount: 0 }
      buckets[comp].lists.push(li)
      buckets[comp].finals.push(fl)
      buckets[comp].obs++
      if (fl < li * 0.99) buckets[comp].withDiscount++
    }
    const out = []
    for (const [comp, b] of Object.entries(buckets)) {
      const listAvg  = b.lists.reduce((a, n) => a + n, 0) / b.lists.length
      const finalAvg = b.finals.reduce((a, n) => a + n, 0) / b.finals.length
      const discountPct = ((finalAvg - listAvg) / listAvg) * 100
      const pctWithDisc = (b.withDiscount / b.obs) * 100
      out.push({ comp, listAvg, finalAvg, discountPct, obs: b.obs, pctWithDisc })
    }
    return out.sort((a, b) => a.discountPct - b.discountPct)   // descuento más fuerte primero
  }, [rawRows])

  if (loading && !rawRows.length) {
    return <div style={{ fontSize: 12, color: 'var(--color-muted)', padding: 12 }}>Cargando…</div>
  }
  if (!rows.length) {
    return <div style={{ fontSize: 12, color: 'var(--color-muted)', padding: 12 }}>Ningún competidor en este rango tiene precios con/sin descuento comparables.</div>
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
        <thead>
          <tr style={{ background: '#f8fafc' }}>
            <th style={th}>Competidor</th>
            <th style={th}>Lista ({currency})</th>
            <th style={th}>Final ({currency})</th>
            <th style={th}>% descuento promedio</th>
            <th style={th}>% obs c/descuento</th>
            <th style={th}>n obs</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.comp} style={{ borderBottom: '1px solid var(--color-border-soft)' }}>
              <td style={{ ...td, textAlign: 'left' }}>
                <span style={{
                  background: COMPETITOR_COLORS[r.comp] || '#64748b',
                  color: '#fff', padding: '1px 6px', borderRadius: 3,
                  fontWeight: 700, fontSize: 11,
                }}>{r.comp}</span>
                {r.comp === 'InDrive' && (
                  <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--color-muted)' }}>
                    (recommended → minimal_bid)
                  </span>
                )}
              </td>
              <td style={td}>{r.listAvg.toFixed(2)}</td>
              <td style={td}>{r.finalAvg.toFixed(2)}</td>
              <td style={{ ...td, fontWeight: 700, color: r.discountPct < -5 ? '#15803d' : r.discountPct < 0 ? '#65a30d' : 'inherit' }}>
                {r.discountPct >= 0 ? '+' : ''}{r.discountPct.toFixed(1)}%
              </td>
              <td style={td}>{r.pctWithDisc.toFixed(0)}%</td>
              <td style={tdMuted}>{r.obs.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ fontSize: 11, color: 'var(--color-muted)', marginTop: 8 }}>
        Compara <code>price_with_discount</code> vs <code>price_without_discount</code>.
        Para InDrive comparamos <code>minimal_bid</code> vs <code>recommended_price</code> (el descuento del bidder).
      </div>
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
