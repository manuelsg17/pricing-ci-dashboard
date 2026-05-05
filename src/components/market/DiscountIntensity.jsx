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

    sb.rpc('get_discount_stats', {
      p_country:    filters.country,
      p_city:       filters.dbCity,
      p_category:   filters.dbCategory,
      p_start_date: startDate,
      p_end_date:   endDate,
    }).then(({ data, error }) => {
      if (cancelled) return
      if (error) console.error('DiscountIntensity RPC error:', error)
      setRawRows(data || [])
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [filters.country, filters.dbCity, filters.dbCategory, filters.weekColumns])

  // RPC ya agregó: { competition_name, list_avg, final_avg, with_discount, n_total }
  const rows = useMemo(() => {
    const out = rawRows
      .filter(r => r.list_avg != null && r.final_avg != null)
      .map(r => {
        const listAvg  = Number(r.list_avg)
        const finalAvg = Number(r.final_avg)
        const obs      = Number(r.n_total || 0)
        const withDisc = Number(r.with_discount || 0)
        const discountPct = ((finalAvg - listAvg) / listAvg) * 100
        const pctWithDisc = obs > 0 ? (withDisc / obs) * 100 : 0
        return { comp: r.competition_name, listAvg, finalAvg, discountPct, obs, pctWithDisc }
      })
    return out.sort((a, b) => a.discountPct - b.discountPct)
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
