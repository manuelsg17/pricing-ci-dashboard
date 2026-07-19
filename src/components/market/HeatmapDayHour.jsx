import { useEffect, useState, useMemo } from 'react'
import { sb } from '../../lib/supabase'
import { COMPETITOR_COLORS } from '../../lib/constants'
import { normalizeCompetitorName } from '../../lib/normalize'
import { useI18n } from '../../context/LanguageContext'

const TIME_SLOT_KEYS = ['early_morning', 'morning', 'midday', 'afternoon', 'evening']
const DOW_KEYS = [1, 2, 3, 4, 5, 6, 7]

export default function HeatmapDayHour({ filters, competitors = [], focusComp = 'Yango' }) {
  const { t } = useI18n()
  const TIME_SLOTS = TIME_SLOT_KEYS.map((key) => ({
    key,
    label: t(`market.heatmap.time_slot_${key}`),
  }))
  const DOWS = DOW_KEYS.map((key) => ({ key, label: t(`market.heatmap.dow_${key}`) }))
  const [rawRows, setRawRows] = useState([])
  const [loading, setLoading] = useState(false)

  // Rango: SOLO la última semana del rango seleccionado en el filtro.
  // El heatmap responde "¿quién es el más barato AHORA en cada día×hora?",
  // así que promediar semanas viejas diluye la foto actual.
  const lastMonday = filters.weekColumns?.length
    ? filters.weekColumns[filters.weekColumns.length - 1]
    : null
  const startDate = lastMonday ? toISO(lastMonday) : toISO(new Date(Date.now() - 7 * 86400_000))
  const endDate = lastMonday ? toISO(addDays(lastMonday, 6)) : toISO(new Date())

  useEffect(() => {
    if (!filters.dbCity || !filters.dbCategory) return
    let cancelled = false
    setLoading(true)

    // Server-side aggregation vía RPC para evitar el cap de 1000 filas de PostgREST
    sb.rpc('get_heatmap_dow_tod', {
      p_country: filters.country,
      p_city: filters.dbCity,
      p_category: filters.dbCategory,
      p_start_date: startDate,
      p_end_date: endDate,
    }).then(({ data, error }) => {
      if (cancelled) return
      if (error) console.error('Heatmap RPC error:', error)
      setRawRows(data || [])
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [filters.country, filters.dbCity, filters.dbCategory, startDate, endDate])

  // El RPC ya devuelve agregado: { competition_name, dow, time_of_day, avg_price, n }
  const cells = useMemo(() => {
    const map = {}
    for (const r of rawRows) {
      const comp =
        normalizeCompetitorName(r.competition_name, { city: filters.dbCity }) || r.competition_name
      const dow = Number(r.dow)
      const tod = r.time_of_day
      if (!comp || !dow || !tod) continue
      if (!map[comp]) map[comp] = {}
      if (!map[comp][dow]) map[comp][dow] = {}
      map[comp][dow][tod] = { avg: Number(r.avg_price), n: Number(r.n) }
    }

    const grid = {}
    for (const dowKey of DOW_KEYS) {
      grid[dowKey] = {}
      for (const todKey of TIME_SLOT_KEYS) {
        const arr = competitors
          .map((c) => {
            // Con una sola semana de rango cada celda es un único día×franja,
            // así que basta n>=1 — el n exacto se ve en el tooltip.
            const cell = map[c]?.[dowKey]?.[todKey]
            if (!cell || cell.n < 1) return null
            return { comp: c, avg: cell.avg, n: cell.n }
          })
          .filter(Boolean)
          .sort((a, b) => a.avg - b.avg)

        const focusEntry = arr.find((x) => x.comp === focusComp)
        const focusRank = focusEntry ? arr.findIndex((x) => x.comp === focusComp) + 1 : null
        grid[dowKey][todKey] = {
          rank: focusRank,
          total: arr.length,
          avg: focusEntry?.avg ?? null,
          n: focusEntry?.n ?? 0,
        }
      }
    }
    return grid
  }, [rawRows, competitors, focusComp, filters.dbCity])

  if (loading && !rawRows.length) {
    return (
      <div style={{ fontSize: 12, color: 'var(--color-muted)', padding: 12 }}>
        {t('market.heatmap.loading')}
      </div>
    )
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <div style={{ fontSize: 11, color: 'var(--color-muted)', marginBottom: 10 }}>
        {t('market.heatmap.header_prefix')}{' '}
        <strong
          style={{
            background: COMPETITOR_COLORS[focusComp] || '#64748b',
            color: '#fff',
            padding: '1px 6px',
            borderRadius: 3,
          }}
        >
          {focusComp}
        </strong>{' '}
        {t('market.heatmap.header_suffix', {
          start: fmtShort(startDate),
          end: fmtShort(endDate),
          city: filters.dbCity,
          category: filters.dbCategory,
        })}
      </div>
      <table style={{ borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr>
            <th style={hth}></th>
            {TIME_SLOTS.map((slot) => (
              <th key={slot.key} style={hth}>
                {slot.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {DOWS.map((d) => (
            <tr key={d.key}>
              <td style={{ ...htd, fontWeight: 700, background: '#f8fafc' }}>{d.label}</td>
              {TIME_SLOTS.map((slot) => {
                const c = cells[d.key]?.[slot.key]
                return (
                  <td
                    key={slot.key}
                    style={{
                      ...htd,
                      background: getRankBg(c?.rank),
                      color: c?.rank ? '#0f172a' : '#cbd5e1',
                    }}
                    title={
                      c?.n
                        ? t('market.heatmap.tooltip_with_data', {
                            comp: focusComp,
                            avg: c.avg.toFixed(2),
                            n: c.n,
                            rank: c.rank,
                            total: c.total,
                          })
                        : t('market.heatmap.tooltip_no_data')
                    }
                  >
                    {c?.rank ? `${c.rank}º` : '—'}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div
        style={{
          fontSize: 10,
          color: 'var(--color-muted)',
          marginTop: 10,
          display: 'flex',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <span>
          <span style={swatch('#dcfce7')} /> {t('market.heatmap.legend_leader')}
        </span>
        <span>
          <span style={swatch('#fef9c3')} /> {t('market.heatmap.legend_2')}
        </span>
        <span>
          <span style={swatch('#ffedd5')} /> {t('market.heatmap.legend_3')}
        </span>
        <span>
          <span style={swatch('#fee2e2')} /> {t('market.heatmap.legend_4plus')}
        </span>
        <span>{t('market.heatmap.legend_hover_hint')}</span>
      </div>
    </div>
  )
}

function getRankBg(rank) {
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

function fmtShort(iso) {
  const [, m, d] = iso.split('-')
  const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
  return `${Number(d)} ${MESES[Number(m) - 1]}`
}

function addDays(d, n) {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}

const hth = {
  padding: '6px 12px',
  borderBottom: '2px solid var(--color-border)',
  fontSize: 10,
  fontWeight: 700,
  color: 'var(--color-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.4px',
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
    display: 'inline-block',
    width: 10,
    height: 10,
    borderRadius: 2,
    background: c,
    marginRight: 4,
    verticalAlign: 'middle',
    border: '1px solid rgba(0,0,0,0.1)',
  }
}
