import { useState, useEffect } from 'react'
import { sb } from '../../lib/supabase'
import { useFilterContext } from '../../context/FilterContext'
import { useI18n } from '../../context/LanguageContext'

function getWeekDateRange(periodKey) {
  const [yearStr, weekStr] = periodKey.split('-W')
  const year = Number(yearStr)
  const week = Number(weekStr)
  // ISO week: Jan 4 is always in week 1
  const jan4 = new Date(year, 0, 4)
  const dow = jan4.getDay() || 7
  const monday = new Date(jan4)
  monday.setDate(jan4.getDate() - (dow - 1) + (week - 1) * 7)
  const sunday = new Date(monday)
  sunday.setDate(monday.getDate() + 6)
  return {
    start: monday.toISOString().slice(0, 10),
    end:   sunday.toISOString().slice(0, 10),
  }
}

export default function DrillDownModal({ open, onClose, comp, periodKey, bracket, currency, viewMode }) {
  const { filters } = useFilterContext()
  const { t } = useI18n()
  const [rows,    setRows]    = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) { setRows([]); return }
    let cancelled = false
    setLoading(true)

    async function load() {
      let query = sb.from('pricing_observations')
        .select('observed_date, avg_price, observation_count, surge, data_source, time_of_day')
        .eq('country', filters.country)
        .eq('city', filters.dbCity)
        .eq('category', filters.dbCategory)
        .eq('competition_name', comp)
        .order('observed_date')
        .order('time_of_day')

      if (bracket && bracket !== '_wa') {
        query = query.eq('distance_bracket', bracket)
      }

      if (viewMode === 'daily') {
        query = query.eq('observed_date', periodKey)
      } else {
        const { start, end } = getWeekDateRange(periodKey)
        query = query.gte('observed_date', start).lte('observed_date', end)
      }

      const { data } = await query
      if (!cancelled) { setRows(data || []); setLoading(false) }
    }
    load()
    return () => { cancelled = true }
  }, [open, comp, periodKey, bracket, viewMode, filters.country, filters.dbCity, filters.dbCategory])

  if (!open) return null

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--color-panel)',
          borderRadius: 12, padding: 24,
          maxWidth: 640, width: '100%', maxHeight: '80vh',
          overflow: 'auto',
          boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
          animation: 'confirmIn 0.15s ease',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-text)' }}>
              {t('dashboard.drill.title')}
            </div>
            <div style={{ fontSize: 11, color: 'var(--color-muted)', marginTop: 2 }}>
              {comp} · {bracket === '_wa' ? 'WA (todos los brackets)' : bracket} · {periodKey}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'none', border: 'none', fontSize: 20, lineHeight: 1,
              cursor: 'pointer', color: 'var(--color-muted)', padding: '0 4px',
              borderRadius: 4,
            }}
          >×</button>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: '28px 0', color: 'var(--color-muted)', fontSize: 13 }}>
            {t('app.loading')}
          </div>
        ) : rows.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '28px 0', color: 'var(--color-muted)', fontSize: 13 }}>
            {t('dashboard.drill.no_data')}
          </div>
        ) : (
          <>
            <div style={{ fontSize: 11, color: 'var(--color-muted)', marginBottom: 8 }}>
              {rows.length} {t('dataentry.rows')} · {filters.dbCity} · {filters.dbCategory}
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: '#f8fafc' }}>
                  {[
                    t('dashboard.drill.date'),
                    t('dashboard.drill.price'),
                    t('dashboard.drill.count'),
                    t('dashboard.drill.surge'),
                    t('dashboard.drill.source'),
                    t('dashboard.drill.time'),
                  ].map(h => (
                    <th key={h} style={{
                      padding: '6px 10px', textAlign: h === t('dashboard.drill.date') ? 'left' : 'right',
                      borderBottom: '2px solid var(--color-border)',
                      fontSize: 10, fontWeight: 700, color: 'var(--color-muted)',
                      textTransform: 'uppercase', letterSpacing: '0.4px',
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid var(--color-border-soft)' }}>
                    <td style={{ padding: '5px 10px', fontVariantNumeric: 'tabular-nums' }}>{r.observed_date}</td>
                    <td style={{ padding: '5px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                      {currency} {Number(r.avg_price).toFixed(2)}
                    </td>
                    <td style={{ padding: '5px 10px', textAlign: 'right' }}>{r.observation_count ?? '—'}</td>
                    <td style={{ padding: '5px 10px', textAlign: 'right' }}>{r.surge ? '⚡ Sí' : '—'}</td>
                    <td style={{ padding: '5px 10px', textAlign: 'right', fontSize: 10, color: 'var(--color-muted)' }}>
                      {r.data_source || '—'}
                    </td>
                    <td style={{ padding: '5px 10px', textAlign: 'right', fontSize: 10, color: 'var(--color-muted)' }}>
                      {r.time_of_day || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  )
}
