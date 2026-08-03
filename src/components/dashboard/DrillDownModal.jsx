import { useState, useEffect } from 'react'
import { sb } from '../../lib/supabase'
import { useFilterContext } from '../../context/FilterContext'
import { useI18n } from '../../context/LanguageContext'
import { formatCurrency } from '../../lib/format.js'
import { prettyCompetitor } from '../../lib/normalize'
import { computeEffectivePrice } from '../../algorithms/indrive'
import { toISODate } from '../../lib/dateUtils'
import { Button } from '../ui/shadcn/button'

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
  // `toISODate` y no `toISOString()`: las dos Date se construyen en hora local
  // (`new Date(year, 0, 4)` + setDate), así que en cualquier huso al este de
  // Greenwich el UTC de esa medianoche cae el día ANTERIOR. La ventana de la
  // semana se corría un día y el modal dejaba de explicar la celda que lo abrió.
  return { start: toISODate(monday), end: toISODate(sunday) }
}

export default function DrillDownModal({
  open,
  onClose,
  comp,
  periodKey,
  bracket,
  currency,
  viewMode,
}) {
  const { filters, ALL_TIME_SLOTS } = useFilterContext()
  const { t } = useI18n()
  const [rows, setRows] = useState([])
  const [totalCount, setTotalCount] = useState(0)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) {
      setRows([])
      setTotalCount(0)
      return
    }
    let cancelled = false
    setLoading(true)

    async function load() {
      // ── QUÉ FILAS ENTRAN ────────────────────────────────────────────────
      // La celda del dashboard sale de v_bracket_weekly_avg_mv, que agrega
      // `v_effective_price` con un solo predicado:
      //
      //     WHERE effective_price IS NOT NULL AND effective_price > 0
      //
      // Este modal filtraba por otra cosa: `recommended_price NOT NULL` para
      // InDrive y `price_without_discount NOT NULL` para el resto. Las dos
      // divergen y en direcciones opuestas:
      //
      //   · InDrive con bids cargados y recommended_price nulo → la celda la
      //     cuenta (el efectivo es el promedio de bids), el modal la escondía.
      //   · Cualquier competidor con solo recommended_price → idem: la celda la
      //     cuenta por el COALESCE, el modal la escondía.
      //
      // Acá se replica el predicado de la vista con PostgREST. `computeEffectivePrice`
      // (algorithms/indrive.js) es el espejo en JS de la misma vista y decide qué
      // precio se MUESTRA, así que la fila y el número que la explica salen de la
      // misma regla.
      const coalescePositivo =
        'price_without_discount.gt.0,and(price_without_discount.is.null,recommended_price.gt.0)'
      const predicado =
        comp === 'InDrive'
          ? `bid_1.gt.0,bid_2.gt.0,bid_3.gt.0,bid_4.gt.0,bid_5.gt.0,${coalescePositivo}`
          : coalescePositivo
      let query = sb
        .from('pricing_observations')
        .select(
          'competition_name, observed_date, observed_time, distance_bracket, price_without_discount, price_with_discount, recommended_price, minimal_bid, bid_1, bid_2, bid_3, bid_4, bid_5, surge, data_source, time_of_day',
          { count: 'exact' }
        )
        .eq('country', filters.country)
        .eq('city', filters.dbCity)
        .eq('category', filters.dbCategory)
        .eq('competition_name', comp)
        .or(predicado)
        .order('observed_date')
        .order('observed_time')
        .limit(500)

      if (bracket && bracket !== '_wa') {
        query = query.eq('distance_bracket', bracket)
      }

      // Los MISMOS filtros que el dashboard le pasa a get_dashboard_data_*_fast
      // (usePricingData.js). Sin esto el modal contaba sobre un universo más
      // grande que la celda que lo abrió: con Zona=Comas el resumen mostraba 28
      // muestras y el modal 252 — las de los 7 distritos juntos. El detalle
      // tiene que explicar EXACTAMENTE el número en el que se hizo click.
      if (filters.zone && filters.zone !== 'All') {
        query = query.eq('zone', filters.zone)
      }
      if (filters.dataSource) {
        query = query.eq('data_source', filters.dataSource)
      }
      // surge = ventana de Rush Hour → columna rush_hour (mig 114), no la
      // columna `surge` del scraper. Mismo criterio que rushHourParam.
      if (filters.surge !== null && filters.surge !== undefined) {
        query = query.eq('rush_hour', filters.surge)
      }
      // null/completo = todas las franjas (incluye las que no tienen franja),
      // igual que timeOfDayParam — solo se filtra si es un subconjunto.
      if (
        Array.isArray(filters.timeOfDay) &&
        filters.timeOfDay.length > 0 &&
        filters.timeOfDay.length < ALL_TIME_SLOTS.length
      ) {
        query = query.in('time_of_day', filters.timeOfDay)
      }

      if (viewMode === 'daily') {
        query = query.eq('observed_date', periodKey)
      } else {
        const { start, end } = getWeekDateRange(periodKey)
        query = query.gte('observed_date', start).lte('observed_date', end)
      }

      const { data, error, count } = await query
      if (!cancelled) {
        if (error) console.error('Drill-down query error:', error)
        setRows(data || [])
        setTotalCount(count ?? (data ? data.length : 0))
        setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [
    open,
    comp,
    periodKey,
    bracket,
    viewMode,
    filters.country,
    filters.dbCity,
    filters.dbCategory,
    filters.zone,
    filters.dataSource,
    filters.surge,
    filters.timeOfDay,
    ALL_TIME_SLOTS,
  ])

  if (!open) return null

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--color-panel)',
          borderRadius: 12,
          padding: 24,
          maxWidth: 640,
          width: '100%',
          maxHeight: '80vh',
          overflow: 'auto',
          boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
          animation: 'confirmIn 0.15s ease',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            marginBottom: 14,
          }}
        >
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-text)' }}>
              {t('dashboard.drill.title')}
            </div>
            <div style={{ fontSize: 11, color: 'var(--color-muted)', marginTop: 2 }}>
              {prettyCompetitor(comp)} ·{' '}
              {bracket === '_wa' ? `WA (${t('dashboard.drill.all_brackets')})` : bracket} ·{' '}
              {periodKey}
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="h-auto w-auto rounded p-1 text-[20px] leading-none text-[var(--color-muted)] hover:bg-transparent"
          >
            ×
          </Button>
        </div>

        {loading ? (
          <div
            style={{
              textAlign: 'center',
              padding: '28px 0',
              color: 'var(--color-muted)',
              fontSize: 13,
            }}
          >
            {t('app.loading')}
          </div>
        ) : rows.length === 0 ? (
          <div
            style={{
              textAlign: 'center',
              padding: '28px 0',
              color: 'var(--color-muted)',
              fontSize: 13,
            }}
          >
            {t('dashboard.drill.no_data')}
          </div>
        ) : (
          <>
            <div
              style={{
                fontSize: 11,
                color: 'var(--color-muted)',
                marginBottom: 8,
                display: 'flex',
                justifyContent: 'space-between',
                gap: 12,
              }}
            >
              <span>
                <strong>{totalCount.toLocaleString()}</strong> {t('dataentry.rows')}
                {totalCount > rows.length ? ` · mostrando ${rows.length}` : ''} · {filters.dbCity} ·{' '}
                {filters.dbCategory}
                {filters.zone && filters.zone !== 'All' ? ` · ${filters.zone}` : ''}
                {bracket === '_wa' ? ` · ${t('samples.all_brackets_suffix')}` : ''}
              </span>
              <span>
                {(() => {
                  // El mismo precio efectivo que agregó la celda — no el campo
                  // crudo, que para InDrive no es el que se promedió.
                  const prices = rows
                    .map((r) => Number(computeEffectivePrice(r)))
                    .filter((p) => !isNaN(p) && p > 0)
                  if (!prices.length) return null
                  const avg = prices.reduce((a, b) => a + b, 0) / prices.length
                  const min = Math.min(...prices)
                  const max = Math.max(...prices)
                  const suffix = totalCount > rows.length ? ' · muestra' : ''
                  return `Avg ${formatCurrency(avg, currency)} · min ${formatCurrency(min, currency)} · max ${formatCurrency(max, currency)}${suffix}`
                })()}
              </span>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: '#f8fafc' }}>
                  {[
                    t('dashboard.drill.date'),
                    t('dashboard.drill.time') + ' obs',
                    'Bracket',
                    t('dashboard.drill.price'),
                    t('dashboard.drill.surge'),
                    t('dashboard.drill.source'),
                    t('dashboard.drill.time'),
                  ].map((h, i) => (
                    <th
                      key={i}
                      style={{
                        padding: '6px 10px',
                        textAlign: i === 0 ? 'left' : 'right',
                        borderBottom: '2px solid var(--color-border)',
                        fontSize: 10,
                        fontWeight: 700,
                        color: 'var(--color-muted)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.4px',
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid var(--color-border-soft)' }}>
                    <td style={{ padding: '5px 10px', fontVariantNumeric: 'tabular-nums' }}>
                      {r.observed_date}
                    </td>
                    <td
                      style={{
                        padding: '5px 10px',
                        textAlign: 'right',
                        fontVariantNumeric: 'tabular-nums',
                        fontSize: 11,
                      }}
                    >
                      {r.observed_time ? String(r.observed_time).slice(0, 5) : '—'}
                    </td>
                    <td
                      style={{
                        padding: '5px 10px',
                        textAlign: 'right',
                        fontSize: 10,
                        color: 'var(--color-muted)',
                      }}
                    >
                      {r.distance_bracket || '—'}
                    </td>
                    <td
                      style={{
                        padding: '5px 10px',
                        textAlign: 'right',
                        fontVariantNumeric: 'tabular-nums',
                        fontWeight: 600,
                      }}
                    >
                      {(() => {
                        const p = computeEffectivePrice(r)
                        return p != null ? formatCurrency(p, currency) : '—'
                      })()}
                    </td>
                    <td style={{ padding: '5px 10px', textAlign: 'right' }}>
                      {r.surge ? '⚡ Sí' : '—'}
                    </td>
                    <td
                      style={{
                        padding: '5px 10px',
                        textAlign: 'right',
                        fontSize: 10,
                        color: 'var(--color-muted)',
                      }}
                    >
                      {r.data_source || '—'}
                    </td>
                    <td
                      style={{
                        padding: '5px 10px',
                        textAlign: 'right',
                        fontSize: 10,
                        color: 'var(--color-muted)',
                      }}
                    >
                      {r.time_of_day || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {totalCount > rows.length && (
              <div
                style={{
                  fontSize: 10,
                  color: 'var(--color-muted)',
                  marginTop: 8,
                  fontStyle: 'italic',
                }}
              >
                Mostrando las primeras {rows.length.toLocaleString()} de{' '}
                {totalCount.toLocaleString()} observaciones · afina los filtros (zona, franja,
                fuente) para acotar.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
