import { useState, useMemo } from 'react'
import { Download } from 'lucide-react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import { Combobox } from '../ui/shadcn/combobox'
import { Button } from '../ui/shadcn/button'
import { usePriceVolatility } from '../../hooks/usePriceVolatility'
import { getCountryConfig, COMPETITOR_COLORS } from '../../lib/constants'
import { useCountry } from '../../context/CountryContext'
import { formatCurrency, formatCount } from '../../lib/format'
import { exportPriceVolatilityCsv } from '../../lib/competitiveBandsExport'
import { useI18n } from '../../context/LanguageContext'

const ALL_CITIES = '__all__'

function VolatilityTooltip({ active, payload, currency, t }) {
  if (!active || !payload || !payload.length) return null
  const row = payload[0]?.payload
  if (!row) return null
  return (
    <div
      style={{
        background: 'var(--color-panel)',
        border: '1px solid var(--color-border)',
        borderRadius: 6,
        padding: '8px 10px',
        fontSize: 11,
        boxShadow: 'var(--shadow-sm)',
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: 4 }}>{row.competitor_name}</div>
      <div>
        {t('competitiveBands.volatility.tooltip_min')}: {formatCurrency(row.min_price, currency)}
      </div>
      <div>P10: {formatCurrency(row.p10, currency)}</div>
      <div>
        {t('competitiveBands.p50_median')}: {formatCurrency(row.p50, currency)}
      </div>
      <div>P90: {formatCurrency(row.p90, currency)}</div>
      <div>
        {t('competitiveBands.volatility.tooltip_max')}: {formatCurrency(row.max_price, currency)}
      </div>
      <div style={{ marginTop: 4, color: 'var(--color-muted)' }}>
        {t('competitiveBands.volatility.tooltip_samples', { n: formatCount(row.n_buckets) })}
      </div>
    </div>
  )
}

// Comparación de volatilidad de precio REAL (no Δ%) — Yango vs cada
// competidor, por categoría. "Volatilidad" = qué tan ancho es el rango
// P10-P90 de precio típico observado (across ciudades, distancias y
// semanas del período). Rango ancho = precio inconsistente para
// situaciones similares; rango angosto = precio predecible.
export default function PriceVolatilityChart({ country, yearStart, weekStart, yearEnd, weekEnd }) {
  const { t } = useI18n()
  const { dbConfigs } = useCountry()
  const config = getCountryConfig(country, dbConfigs)
  const currency = config.currency

  const categoryItems = useMemo(() => {
    const cats = new Set()
    Object.values(config.categoriesByCity || {}).forEach((list) => list.forEach((c) => cats.add(c)))
    cats.delete('Corp')
    return Array.from(cats)
      .sort()
      .map((c) => ({ value: c, label: c }))
  }, [config])

  // 'value' = nombre DB-facing (lo que filtra la RPC vía v.city), 'label' =
  // nombre UI-facing (puede llevar tilde, ej. Bogotá vs dbCities='Bogota').
  // Corp excluido — mezcla sub-marcas Yango, ya fuera de scope de esta vista.
  const cityItems = useMemo(() => {
    const dbCities = config.dbCities || config.cities || []
    const uiCities = config.cities || dbCities
    return dbCities
      .map((dbCity, i) => ({ value: dbCity, label: uiCities[i] || dbCity }))
      .filter((c) => c.value !== 'Corp')
  }, [config])

  // Cálculo síncrono (no useEffect corrector) — mismo criterio que
  // `activeBand` en Competitividad.jsx: si la categoría/ciudad elegida ya
  // no pertenece al país actual (ej. tras un cambio de país), cae a la
  // primera disponible (o a "todas las ciudades") EN EL MISMO render, sin
  // un frame de retraso que dispare la RPC con un país/valor que no
  // matchean entre sí.
  const [selectedCategory, setSelectedCategory] = useState(null)
  const category =
    (selectedCategory &&
      categoryItems.some((c) => c.value === selectedCategory) &&
      selectedCategory) ||
    categoryItems[0]?.value ||
    null

  // Ciudad: sin selección = todas las ciudades (comportamiento previo).
  const [selectedCity, setSelectedCity] = useState(ALL_CITIES)
  const city =
    selectedCity === ALL_CITIES || !cityItems.some((c) => c.value === selectedCity)
      ? null
      : selectedCity

  const { rows, loading, error } = usePriceVolatility({
    country,
    category,
    yearStart,
    weekStart,
    yearEnd,
    weekEnd,
    city,
  })

  // Orden para la tabla: Yango primero (fácil de ubicar), resto alfabético
  // (ya viene alfabético de la RPC, solo se antepone Yango).
  const tableRows = useMemo(() => {
    const yango = rows.find((r) => r.competitor_name === 'Yango')
    const rest = rows.filter((r) => r.competitor_name !== 'Yango')
    return yango ? [yango, ...rest] : rest
  }, [rows])

  // Orden para el gráfico: por ancho de rango P10-P90 descendente (el más
  // volátil arriba) — esta es la pregunta que responde el gráfico.
  const chartData = useMemo(
    () =>
      rows
        .map((r) => ({ ...r, spread: Number(r.p90) - Number(r.p10) }))
        .sort((a, b) => b.spread - a.spread),
    [rows]
  )

  // Lectura rápida, 100% factual (no asume que Yango es el más volátil —
  // compara lo que diga la data real).
  const insight = useMemo(() => {
    if (chartData.length < 2) return null
    const widest = chartData[0]
    const narrowest = chartData[chartData.length - 1]
    if (widest.spread <= 0 || narrowest.spread <= 0) return null
    return { widest, narrowest, factor: widest.spread / narrowest.spread }
  }, [chartData])

  if (!category) {
    return <div className="state-box">{t('competitiveBands.volatility.no_categories')}</div>
  }

  return (
    <div>
      <p style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 12 }}>
        {t('competitiveBands.volatility.description')}
      </p>

      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-end', marginBottom: 14 }}>
        <div>
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: 'var(--color-muted)',
              marginBottom: 4,
              textTransform: 'uppercase',
            }}
          >
            {t('competitiveBands.volatility.label_category')}
          </div>
          <Combobox
            items={categoryItems}
            value={category}
            onValueChange={setSelectedCategory}
            placeholder={t('competitiveBands.volatility.placeholder_category')}
            searchPlaceholder={t('competitiveBands.volatility.search_category')}
            emptyText={t('common.no_results')}
            triggerClassName="w-auto min-w-[220px]"
          />
        </div>
        <div>
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: 'var(--color-muted)',
              marginBottom: 4,
              textTransform: 'uppercase',
            }}
          >
            {t('competitiveBands.volatility.label_city')}
          </div>
          <Combobox
            items={[
              { value: ALL_CITIES, label: t('competitiveBands.volatility.all_cities') },
              ...cityItems,
            ]}
            value={selectedCity}
            onValueChange={setSelectedCity}
            placeholder={t('competitiveBands.volatility.all_cities')}
            searchPlaceholder={t('competitiveBands.volatility.search_city')}
            emptyText={t('common.no_results')}
            triggerClassName="w-auto min-w-[180px]"
          />
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="border-dashed border-border text-muted hover:border-yango hover:text-yango"
          onClick={() => exportPriceVolatilityCsv({ country, category, city, currency, rows })}
          disabled={!rows.length}
          style={{ marginLeft: 'auto' }}
        >
          <Download size={13} />
          {t('competitiveBands.volatility.export_csv')}
        </Button>
      </div>

      {error && (
        <div className="state-box state-box--error">
          {t('app.error_prefix')}
          {error}
        </div>
      )}

      {loading && !rows.length ? (
        <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--color-muted)' }}>
          {t('competitiveBands.volatility.calculating')}
        </div>
      ) : !rows.length ? (
        <div className="state-box">{t('competitiveBands.volatility.no_data_period')}</div>
      ) : (
        <>
          {insight && (
            <div
              style={{
                fontSize: 13,
                background: 'var(--color-secondary, #f8fafc)',
                border: '1px solid var(--color-border)',
                borderRadius: 6,
                padding: '10px 14px',
                marginBottom: 14,
              }}
            >
              <strong>{insight.widest.competitor_name}</strong>{' '}
              {t('competitiveBands.volatility.insight_most_variable')}{' '}
              {formatCurrency(insight.widest.spread, currency)}{' '}
              {t('competitiveBands.volatility.insight_between')}{' '}
              <strong>{insight.factor.toFixed(1)}x</strong>{' '}
              {t('competitiveBands.volatility.insight_more_than')}{' '}
              <strong>{insight.narrowest.competitor_name}</strong> (
              {formatCurrency(insight.narrowest.spread, currency)}),{' '}
              {t('competitiveBands.volatility.insight_most_stable')}.
            </div>
          )}

          <div style={{ overflowX: 'auto', marginBottom: 16 }}>
            <table className="config-table config-table--modern">
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>{t('dashboard.table.competitor')}</th>
                  <th scope="col">{t('competitiveBands.volatility.tooltip_min')}</th>
                  <th scope="col">P10</th>
                  <th scope="col">P25</th>
                  <th scope="col">P50</th>
                  <th scope="col">P75</th>
                  <th scope="col">P90</th>
                  <th scope="col">{t('competitiveBands.volatility.tooltip_max')}</th>
                </tr>
              </thead>
              <tbody>
                {tableRows.map((r) => {
                  const isYango = r.competitor_name === 'Yango'
                  const color = COMPETITOR_COLORS[r.competitor_name]
                  return (
                    <tr key={r.competitor_name} style={isYango ? { fontWeight: 700 } : undefined}>
                      <td style={{ textAlign: 'left', color: color || 'inherit' }}>
                        {r.competitor_name}
                      </td>
                      <td>{formatCurrency(r.min_price, currency)}</td>
                      <td>{formatCurrency(r.p10, currency)}</td>
                      <td>{formatCurrency(r.p25, currency)}</td>
                      <td>{formatCurrency(r.p50, currency)}</td>
                      <td>{formatCurrency(r.p75, currency)}</td>
                      <td>{formatCurrency(r.p90, currency)}</td>
                      <td>{formatCurrency(r.max_price, currency)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <h2 style={{ margin: 0, marginBottom: 4, fontSize: 15 }}>
            {t('competitiveBands.volatility.chart_title')}
          </h2>
          <ResponsiveContainer width="100%" height={Math.max(160, chartData.length * 48)}>
            <BarChart
              data={chartData}
              layout="vertical"
              margin={{ top: 8, right: 24, bottom: 8, left: 8 }}
            >
              <XAxis
                type="number"
                tickFormatter={(v) => formatCurrency(v, currency, { noDecimals: true })}
                tick={{ fontSize: 10 }}
              />
              <YAxis type="category" dataKey="competitor_name" width={90} tick={{ fontSize: 11 }} />
              <Tooltip content={<VolatilityTooltip currency={currency} t={t} />} />
              {/* Barra flotante: base invisible (0→P10) + barra visible (P10→P90) */}
              <Bar dataKey="p10" stackId="range" fill="transparent" />
              <Bar dataKey="spread" stackId="range" radius={[0, 4, 4, 0]} barSize={18}>
                {chartData.map((entry) => (
                  <Cell
                    key={entry.competitor_name}
                    fill={COMPETITOR_COLORS[entry.competitor_name] || '#94a3b8'}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
          <p style={{ fontSize: 11, color: 'var(--color-muted)', marginTop: 8 }}>
            {t('competitiveBands.volatility.chart_footer')}
          </p>
        </>
      )}
    </div>
  )
}
