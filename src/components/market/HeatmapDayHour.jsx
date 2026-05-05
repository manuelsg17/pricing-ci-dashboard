import { useEffect, useState, useMemo } from 'react'
import { sb } from '../../lib/supabase'
import { COMPETITOR_COLORS } from '../../lib/constants'

const TIME_SLOTS = [
  { key: 'early_morning', label: 'Madrugada' },
  { key: 'morning',       label: 'Mañana' },
  { key: 'midday',        label: 'Mediodía' },
  { key: 'afternoon',     label: 'Tarde' },
  { key: 'evening',       label: 'Noche' },
]

const DOWS = [
  { key: 1, label: 'Lun' },
  { key: 2, label: 'Mar' },
  { key: 3, label: 'Mié' },
  { key: 4, label: 'Jue' },
  { key: 5, label: 'Vie' },
  { key: 6, label: 'Sáb' },
  { key: 7, label: 'Dom' },
]

export default function HeatmapDayHour({ filters, competitors, focusComp = 'Yango' }) {
  const [rawRows, setRawRows] = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!filters.dbCity || !filters.dbCategory) return
    let cancelled = false
    setLoading(true)

    // Rango aprox: las últimas 8 semanas — usa weekColumns si los hay, si no caemos a 56 días.
    const startDate = filters.weekColumns?.[0]
      ? toISO(filters.weekColumns[0])
      : toISO(new Date(Date.now() - 56 * 86400_000))
    const endDate = filters.weekColumns?.length
      ? toISO(addDays(filters.weekColumns[filters.weekColumns.length - 1], 6))
      : toISO(new Date())

    const priceField = 'price_without_discount'
    sb.from('pricing_observations')
      .select('competition_name, observed_date, time_of_day, price_without_discount, recommended_price, surge')
      .eq('country', filters.country)
      .eq('city', filters.dbCity)
      .eq('category', filters.dbCategory)
      .gte('observed_date', startDate)
      .lte('observed_date', endDate)
      .limit(50000)
      .then(({ data, error }) => {
        if (cancelled) return
        if (error) console.error('Heatmap query error:', error)
        setRawRows(data || [])
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [filters.country, filters.dbCity, filters.dbCategory, filters.weekColumns])

  // Promedio (price, n) por (comp, dow, time_of_day). Luego para cada celda
  // calculamos rank de focusComp.
  const cells = useMemo(() => {
    const map = {}     // comp → dow → tod → { sum, n }
    for (const r of rawRows) {
      const date = new Date(r.observed_date + 'T00:00:00')
      const dow = ((date.getDay() + 6) % 7) + 1   // 1=lun ... 7=dom
      const tod = r.time_of_day
      if (!tod) continue
      const price = r.price_without_discount ?? r.recommended_price
      if (price == null || price <= 0) continue
      const comp = r.competition_name
      if (!map[comp]) map[comp] = {}
      if (!map[comp][dow]) map[comp][dow] = {}
      if (!map[comp][dow][tod]) map[comp][dow][tod] = { sum: 0, n: 0 }
      map[comp][dow][tod].sum += Number(price)
      map[comp][dow][tod].n += 1
    }

    // Por celda (dow, tod): ranking de competidores
    const grid = {}
    for (const dow of DOWS) {
      grid[dow.key] = {}
      for (const tod of TIME_SLOTS) {
        const arr = competitors
          .map(c => {
            const cell = map[c]?.[dow.key]?.[tod.key]
            if (!cell || cell.n < 3) return null   // mínimo 3 obs para rankear
            return { comp: c, avg: cell.sum / cell.n, n: cell.n }
          })
          .filter(Boolean)
          .sort((a, b) => a.avg - b.avg)

        const focusEntry = arr.find(x => x.comp === focusComp)
        const focusRank = focusEntry ? arr.findIndex(x => x.comp === focusComp) + 1 : null
        grid[dow.key][tod.key] = {
          rank: focusRank,
          total: arr.length,
          avg:   focusEntry?.avg ?? null,
          n:     focusEntry?.n ?? 0,
        }
      }
    }
    return grid
  }, [rawRows, competitors, focusComp])

  if (loading && !rawRows.length) {
    return <div style={{ fontSize: 12, color: 'var(--color-muted)', padding: 12 }}>Cargando heatmap…</div>
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <div style={{ fontSize: 11, color: 'var(--color-muted)', marginBottom: 10 }}>
        Posición de <strong style={{
          background: COMPETITOR_COLORS[focusComp] || '#64748b',
          color: '#fff', padding: '1px 6px', borderRadius: 3,
        }}>{focusComp}</strong> en cada combinación día×hora · datos de las últimas 8 semanas · {filters.dbCity} · {filters.dbCategory}
      </div>
      <table style={{ borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr>
            <th style={hth}></th>
            {TIME_SLOTS.map(t => <th key={t.key} style={hth}>{t.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {DOWS.map(d => (
            <tr key={d.key}>
              <td style={{ ...htd, fontWeight: 700, background: '#f8fafc' }}>{d.label}</td>
              {TIME_SLOTS.map(t => {
                const c = cells[d.key]?.[t.key]
                return (
                  <td key={t.key} style={{
                    ...htd,
                    background: getRankBg(c?.rank, c?.total),
                    color: c?.rank ? '#0f172a' : '#cbd5e1',
                  }}
                  title={c?.n ? `${focusComp}: ${c.avg.toFixed(2)} · n=${c.n} · ${c.rank}º de ${c.total}` : 'Sin datos suficientes'}
                  >
                    {c?.rank ? `${c.rank}º` : '—'}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ fontSize: 10, color: 'var(--color-muted)', marginTop: 10, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <span><span style={swatch('#dcfce7')} /> 1º (líder)</span>
        <span><span style={swatch('#fef9c3')} /> 2º</span>
        <span><span style={swatch('#ffedd5')} /> 3º</span>
        <span><span style={swatch('#fee2e2')} /> 4º+</span>
        <span>· hover una celda para ver promedio y n</span>
      </div>
    </div>
  )
}

function getRankBg(rank, total) {
  if (!rank) return '#f1f5f9'
  if (rank === 1) return '#dcfce7'
  if (rank === 2) return '#fef9c3'
  if (rank === 3) return '#ffedd5'
  return '#fee2e2'
}

function toISO(d) {
  const dt = new Date(d)
  const y = dt.getFullYear()
  const m = String(dt.getMonth() + 1).padStart(2, '0')
  const day = String(dt.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function addDays(d, n) {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}

const hth = {
  padding: '6px 12px',
  borderBottom: '2px solid var(--color-border)',
  fontSize: 10, fontWeight: 700, color: 'var(--color-muted)',
  textTransform: 'uppercase', letterSpacing: '0.4px',
  textAlign: 'center',
}
const htd = {
  padding: '10px 16px',
  textAlign: 'center',
  fontVariantNumeric: 'tabular-nums',
  fontWeight: 600,
  border: '1px solid var(--color-border-soft)',
  minWidth: 64,
}
function swatch(c) {
  return {
    display: 'inline-block', width: 10, height: 10, borderRadius: 2,
    background: c, marginRight: 4, verticalAlign: 'middle',
    border: '1px solid rgba(0,0,0,0.1)',
  }
}
