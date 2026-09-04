import { useState, useMemo } from 'react'
import { Download, AlertTriangle, ArrowUpDown } from 'lucide-react'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/shadcn/tabs'
import { Button } from '../components/ui/shadcn/button'
import { useFilterContext } from '../context/FilterContext'
import { useI18n } from '../context/LanguageContext'
import { useCountry } from '../context/CountryContext'
import { useRoutePriceGaps, useCategorySequenceInversions } from '../hooks/useRouteMonitor'
import { escapeCsvCell } from '../lib/csvSafety'
import { toISODate } from '../lib/dateUtils'
import '../styles/config.css'
import '../styles/dashboard.css'

const ALL = '__all__'

function daysAgoISO(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return toISODate(d)
}

// La RPC admite máx. 31 días; el filtro global en modo semanal cubre 8
// semanas. Se conservan los últimos 31 días del rango (sin rango: 7 días).
function clampTo31Days(range) {
  if (!range?.from || !range?.to) return { from: daysAgoISO(7), to: daysAgoISO(0) }
  const to = new Date(`${range.to}T00:00:00`)
  const from = new Date(`${range.from}T00:00:00`)
  const minFrom = new Date(to)
  minFrom.setDate(to.getDate() - 30)
  return { from: toISODate(from < minFrom ? minFrom : from), to: toISODate(to) }
}

// hh:mm — los segundos que devuelve la RPC son ruido para leer la tabla
// (lo que importa es a qué hora del día pasó, no el segundo exacto).
function fmtTime(t) {
  return typeof t === 'string' ? t.slice(0, 5) : '—'
}

function downloadCsv(filename, header, rows) {
  const body = [header, ...rows].map((r) => r.map(escapeCsvCell).join(',')).join('\n')
  const url = URL.createObjectURL(new Blob(['﻿' + body], { type: 'text/csv;charset=utf-8;' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export default function RouteMonitor() {
  const { filters } = useFilterContext()
  const { countryConfig } = useCountry()
  const { t } = useI18n()
  const country = filters.country
  const currency = countryConfig?.currency || ''

  const [tab, setTab] = useState('gaps')
  // Fase C: el período sale del filtro global del dashboard (filters.dateRange),
  // acotado a los 31 días que admite la RPC (se toman los ÚLTIMOS 31). Los
  // inputs siguen editables: al tocarlos, la vista deja de seguir al filtro
  // global hasta que se aprieta "usar filtro global".
  const sharedRange = useMemo(() => clampTo31Days(filters.dateRange), [filters.dateRange])
  const [localDates, setLocalDates] = useState(null) // null = sigue al filtro global
  const dateFrom = localDates?.from ?? sharedRange.from
  const dateTo = localDates?.to ?? sharedRange.to
  const setDateFrom = (v) => setLocalDates({ from: v, to: dateTo })
  const setDateTo = (v) => setLocalDates({ from: dateFrom, to: v })
  const [minGapPct, setMinGapPct] = useState(0)
  const [cityFilter, setCityFilter] = useState(ALL)

  const gaps = useRoutePriceGaps({
    country,
    dateFrom,
    dateTo,
    minGapPct,
    enabled: tab === 'gaps',
  })
  const inversions = useCategorySequenceInversions({
    country,
    dateFrom,
    dateTo,
    enabled: tab === 'sequence',
  })

  const active = tab === 'gaps' ? gaps : inversions

  // El filtro de ciudad se arma con lo que VOLVIÓ, no con la config del país:
  // así se evita traducir entre uiCity y dbCity (namespaces que no son 1:1 —
  // Aeropuerto/TukTuk — y cuya mezcla ya causó pérdida de datos, CLAUDE.md §1).
  const cities = useMemo(() => {
    const set = new Set(active.rows.map((r) => r.city).filter(Boolean))
    return [...set].sort()
  }, [active.rows])

  const rows = useMemo(
    () => (cityFilter === ALL ? active.rows : active.rows.filter((r) => r.city === cityFilter)),
    [active.rows, cityFilter]
  )

  function exportCurrent() {
    if (tab === 'gaps') {
      downloadCsv(
        `rutas_yango_mas_caro_${dateFrom}_${dateTo}.csv`,
        [
          t('routemon.col.date'),
          t('routemon.col.time'),
          t('routemon.col.city'),
          t('routemon.col.route'),
          t('routemon.col.bracket'),
          t('routemon.col.category'),
          `Yango ${currency}`,
          t('routemon.col.rival'),
          `${t('routemon.col.rival')} ${currency}`,
          t('routemon.col.gap'),
          '%',
        ],
        rows.map((r) => [
          r.observed_date,
          fmtTime(r.observed_time),
          r.city,
          `${r.point_a} → ${r.point_b}`,
          r.distance_bracket,
          r.category,
          r.yango_price,
          r.rival_name,
          r.rival_price,
          r.gap_abs,
          r.gap_pct,
        ])
      )
    } else {
      downloadCsv(
        `secuencia_rota_${dateFrom}_${dateTo}.csv`,
        [
          t('routemon.col.date'),
          t('routemon.col.time'),
          t('routemon.col.city'),
          t('routemon.col.route'),
          t('routemon.col.bracket'),
          t('routemon.col.lower_cat'),
          `${t('routemon.col.lower_cat')} ${currency}`,
          t('routemon.col.higher_cat'),
          `${t('routemon.col.higher_cat')} ${currency}`,
          t('routemon.col.gap'),
          '%',
        ],
        rows.map((r) => [
          r.observed_date,
          fmtTime(r.observed_time),
          r.city,
          `${r.point_a} → ${r.point_b}`,
          r.distance_bracket,
          r.lower_category,
          r.lower_price,
          r.higher_category,
          r.higher_price,
          r.gap_abs,
          r.gap_pct,
        ])
      )
    }
  }

  return (
    <div className="dashboard">
      <div className="config-header">
        <h2>{t('routemon.title')}</h2>
        <p className="config-header__sub">{t('routemon.subtitle')}</p>
      </div>

      <div className="filter-bar" style={{ marginBottom: 12 }}>
        <div className="filter-bar__group">
          <span className="filter-bar__label">{t('routemon.date_from')}</span>
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
        </div>
        <div className="filter-bar__group">
          <span className="filter-bar__label">{t('routemon.date_to')}</span>
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
        </div>
        <div className="filter-bar__group" style={{ fontSize: 11, color: 'var(--color-muted)' }}>
          {localDates ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setLocalDates(null)}
              title={`${sharedRange.from} → ${sharedRange.to}`}
            >
              {t('routemon.use_shared_range')}
            </Button>
          ) : (
            <span title={t('routemon.shared_range_note')}>
              {t('routemon.shared_range_hint', { from: sharedRange.from, to: sharedRange.to })}
            </span>
          )}
        </div>
        {tab === 'gaps' && (
          <div className="filter-bar__group">
            <span className="filter-bar__label">{t('routemon.min_gap')}</span>
            <select value={minGapPct} onChange={(e) => setMinGapPct(Number(e.target.value))}>
              <option value={0}>{t('routemon.min_gap_any')}</option>
              <option value={5}>≥ 5%</option>
              <option value={10}>≥ 10%</option>
              <option value={20}>≥ 20%</option>
            </select>
          </div>
        )}
        {cities.length > 1 && (
          <div className="filter-bar__group">
            <span className="filter-bar__label">{t('routemon.city')}</span>
            <select value={cityFilter} onChange={(e) => setCityFilter(e.target.value)}>
              <option value={ALL}>{t('routemon.all_cities')}</option>
              {cities.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="filter-bar__group">
          <Button variant="outline" size="sm" onClick={exportCurrent} disabled={!rows.length}>
            <Download size={14} /> CSV
          </Button>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="gaps">
            <AlertTriangle size={14} style={{ marginRight: 5 }} />
            {t('routemon.tab_gaps')}
          </TabsTrigger>
          <TabsTrigger value="sequence">
            <ArrowUpDown size={14} style={{ marginRight: 5 }} />
            {t('routemon.tab_sequence')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="gaps">
          <p className="routemon__hint">{t('routemon.gaps_hint')}</p>
          <ResultsTable
            loading={gaps.loading}
            error={gaps.error}
            rows={rows}
            emptyText={t('routemon.gaps_empty')}
            currency={currency}
            t={t}
            columns={[
              { key: 'when', label: t('routemon.col.when') },
              { key: 'city', label: t('routemon.col.city') },
              { key: 'route', label: t('routemon.col.route') },
              { key: 'category', label: t('routemon.col.category') },
              { key: 'yango', label: `Yango` },
              { key: 'rival', label: t('routemon.col.rival') },
              { key: 'gap', label: t('routemon.col.gap') },
            ]}
            renderRow={(r, i) => (
              <tr key={i}>
                <td>
                  {r.observed_date}
                  <span className="routemon__time"> {fmtTime(r.observed_time)}</span>
                </td>
                <td>{r.city}</td>
                <td className="routemon__route">
                  {r.point_a} → {r.point_b}
                  <span className="routemon__bracket"> · {r.distance_bracket}</span>
                </td>
                <td>{r.category}</td>
                <td className="routemon__price routemon__price--bad">
                  {currency} {r.yango_price}
                </td>
                <td>
                  <strong>{r.rival_name}</strong>
                  <span className="routemon__price">
                    {' '}
                    {currency} {r.rival_price}
                  </span>
                </td>
                <td className="routemon__gap">+{r.gap_pct}%</td>
              </tr>
            )}
          />
        </TabsContent>

        <TabsContent value="sequence">
          <p className="routemon__hint">{t('routemon.sequence_hint')}</p>
          <ResultsTable
            loading={inversions.loading}
            error={inversions.error}
            rows={rows}
            emptyText={t('routemon.sequence_empty')}
            currency={currency}
            t={t}
            columns={[
              { key: 'when', label: t('routemon.col.when') },
              { key: 'city', label: t('routemon.col.city') },
              { key: 'route', label: t('routemon.col.route') },
              { key: 'lower', label: t('routemon.col.lower_cat') },
              { key: 'higher', label: t('routemon.col.higher_cat') },
              { key: 'gap', label: t('routemon.col.gap') },
            ]}
            renderRow={(r, i) => (
              <tr key={i}>
                <td>
                  {r.observed_date}
                  <span className="routemon__time"> {fmtTime(r.observed_time)}</span>
                </td>
                <td>{r.city}</td>
                <td className="routemon__route">
                  {r.point_a} → {r.point_b}
                  <span className="routemon__bracket"> · {r.distance_bracket}</span>
                </td>
                <td>
                  {r.lower_category}
                  <span className="routemon__price routemon__price--bad">
                    {' '}
                    {currency} {r.lower_price}
                  </span>
                </td>
                <td>
                  {r.higher_category}
                  <span className="routemon__price">
                    {' '}
                    {currency} {r.higher_price}
                  </span>
                </td>
                <td className="routemon__gap">+{r.gap_pct}%</td>
              </tr>
            )}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function ResultsTable({ loading, error, rows, emptyText, columns, renderRow, t }) {
  if (error) return <div className="routemon__error">{error}</div>
  if (loading) return <div className="routemon__empty">{t('app.loading')}</div>
  if (!rows.length) return <div className="routemon__empty">{emptyText}</div>
  return (
    <>
      <div className="routemon__count">
        {t('routemon.count', { n: rows.length, count: rows.length })}
      </div>
      <div className="matrix-wrap">
        <table className="matrix-table routemon__table">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>{rows.map(renderRow)}</tbody>
        </table>
      </div>
    </>
  )
}
