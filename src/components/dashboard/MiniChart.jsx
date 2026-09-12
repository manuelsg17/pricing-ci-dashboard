/**
 * MiniChart — los dos gráficos (precio y delta) de cada sección de bracket.
 *
 * VIVE EN SU PROPIO ARCHIVO A PROPÓSITO: es el único consumidor de `recharts`
 * en el camino del Dashboard, y recharts pesa ~97 KB gzip. Separado, el
 * Dashboard lo carga con `lazy()` y esos 97 KB dejan de estar en la primera
 * carga de CUALQUIER pantalla — se descargan recién cuando hay un gráfico
 * que dibujar. Si algún día se importa recharts desde BracketSection otra
 * vez, el ahorro se pierde en silencio: el chunk vuelve al camino crítico.
 */
import { useRef } from 'react'
import {
  ComposedChart,
  Line,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
  ReferenceArea,
  Brush,
} from 'recharts'
import { Camera } from 'lucide-react'
import { COMPETITOR_COLORS } from '../../lib/constants'
import { formatPrice } from '../../lib/format.js'
import { prettyCompetitor } from '../../lib/normalize'
import { useI18n } from '../../context/LanguageContext'
import { Button } from '../ui/shadcn/button'

function MiniChart({
  title,
  data,
  competitors,
  compareVs,
  currency = '',
  yFormatter,
  isPercent = false,
  chartType = 'line',
  hiddenComps,
  setHiddenComps,
  chartTypeToggle,
  greenBand,
  syncId,
  viewMode = 'weekly',
  exportName = 'chart',
}) {
  const { t } = useI18n()
  const chartCardRef = useRef(null)
  const hasData = data && data.length > 0 && competitors.some((c) => data.some((d) => d[c] != null))
  const visibleComps = competitors.filter((c) => !hiddenComps?.has(c))

  const toggleHide = (comp) => {
    setHiddenComps?.((prev) => {
      const next = new Set(prev)
      if (next.has(comp)) next.delete(comp)
      else next.add(comp)
      return next
    })
  }

  // #43 — per-chart PNG export
  async function handleExportChart() {
    try {
      const { default: html2canvas } = await import('html2canvas')
      const canvas = await html2canvas(chartCardRef.current, {
        scale: 2,
        useCORS: true,
        backgroundColor: '#ffffff',
      })
      const link = document.createElement('a')
      link.download = `${exportName}.png`
      link.href = canvas.toDataURL()
      link.click()
    } catch (e) {
      console.error('Chart export failed:', e)
    }
  }

  function renderSeries(comp) {
    const color = COMPETITOR_COLORS[comp] || '#999'
    const isBaseComp = comp === compareVs
    const sw = isBaseComp ? 2.5 : 1.5

    // `key` se pasa SIEMPRE como atributo directo (no por spread). React 19
    // warning "A props object containing a 'key' prop is being spread into
    // JSX" — la solución es nunca incluir key en un objeto spreado.
    const commonProps = {
      type: 'monotone',
      dataKey: comp,
      stroke: color,
      strokeWidth: sw,
      connectNulls: false,
      isAnimationActive: true,
      animationDuration: 600,
      animationEasing: 'ease-out',
    }

    if (chartType === 'bar') {
      return (
        <Bar
          key={comp}
          dataKey={comp}
          fill={color}
          radius={[2, 2, 0, 0]}
          maxBarSize={12}
          isAnimationActive
          animationDuration={400}
        />
      )
    }
    if (isBaseComp || chartType === 'area') {
      return (
        <Area
          key={comp}
          {...commonProps}
          fill={color}
          fillOpacity={isBaseComp ? 0.12 : 0.06}
          dot={isBaseComp ? { r: 2 } : false}
        />
      )
    }
    return <Line key={comp} {...commonProps} dot={{ r: 2 }} />
  }

  const ChartComponent = chartType === 'bar' ? BarChart : ComposedChart

  // Chart height: smaller in historic mode to leave room for Brush
  const chartHeight = viewMode === 'historic' ? 130 : 150

  return (
    <div className="chart-card" ref={chartCardRef}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 6,
          gap: 4,
        }}
      >
        <div className="chart-card__title" style={{ margin: 0 }}>
          {title}
        </div>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          {chartTypeToggle}
          {/* #43 — per-chart export */}
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={handleExportChart}
            title={t('dashboard.export_chart')}
            className="h-auto w-auto rounded-[5px] border-[var(--color-border)] bg-transparent p-1.5 text-[var(--color-muted)] hover:bg-transparent"
          >
            <Camera size={13} />
          </Button>
        </div>
      </div>

      {!hasData ? (
        <div style={{ fontSize: 11, color: '#aaa', textAlign: 'center', padding: '16px 0' }}>
          {t('app.no_data')}
        </div>
      ) : (
        <>
          <ResponsiveContainer width="100%" height={chartHeight}>
            <ChartComponent
              data={data}
              margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
              syncId={syncId}
            >
              <CartesianGrid vertical={false} stroke="#eef2f7" />
              <XAxis
                dataKey="period"
                tick={{ fontSize: 9, fill: 'var(--color-muted)' }}
                axisLine={false}
                tickLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fontSize: 9, fill: 'var(--color-muted)' }}
                axisLine={false}
                tickLine={false}
                width={isPercent ? 36 : 32}
                tickFormatter={(v) => (v != null ? yFormatter(v) : '')}
              />
              <Tooltip
                contentStyle={{
                  fontSize: 11,
                  borderRadius: 10,
                  border: '1px solid var(--color-border)',
                  boxShadow: 'var(--shadow-md)',
                }}
                formatter={(v, name) => {
                  // name viene como el raw competitor key (ej 'Yango', 'Cabify Lite').
                  // Mostramos el display name + contexto (vs base / moneda) para que
                  // se entienda el número sin tener que mirar la leyenda.
                  if (v == null) return ['N/A', prettyCompetitor(name)]
                  if (isPercent) {
                    const sign = v > 0 ? '+' : ''
                    const baseLabel = prettyCompetitor(compareVs)
                    return [`${sign}${v.toFixed(1)}% vs ${baseLabel}`, prettyCompetitor(name)]
                  }
                  return [`${currency} ${formatPrice(v)}`, prettyCompetitor(name)]
                }}
                labelFormatter={(label) => {
                  // viewMode: 'daily' | 'weekly' | 'historic'
                  const prefix =
                    viewMode === 'daily'
                      ? t('dataentry.col_date')
                      : viewMode === 'historic'
                        ? t('dashboard.chart.period') || 'Período'
                        : t('dashboard.chart.week') || 'Semana'
                  return `${prefix}: ${label}`
                }}
              />

              {/* #12 — tolerance band */}
              {isPercent && greenBand && (
                <ReferenceArea
                  y1={greenBand.min_pct ?? 0}
                  y2={greenBand.max_pct ?? 10}
                  fill="#dcfce7"
                  fillOpacity={0.35}
                  strokeOpacity={0}
                />
              )}

              {visibleComps.map((comp) => renderSeries(comp))}

              {/* #15 — Brush for historic / zoom */}
              {viewMode === 'historic' && data.length > 8 && (
                <Brush
                  dataKey="period"
                  height={18}
                  travellerWidth={6}
                  stroke="var(--color-border)"
                  fill="#f8fafc"
                  tickFormatter={() => ''}
                />
              )}
            </ChartComponent>
          </ResponsiveContainer>

          {/* #16 — clickable legend */}
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 6,
              marginTop: 6,
              justifyContent: 'center',
            }}
          >
            {competitors.map((comp) => {
              const hidden = hiddenComps?.has(comp)
              const color = COMPETITOR_COLORS[comp] || '#999'
              return (
                <Button
                  key={comp}
                  type="button"
                  variant="outline"
                  className="h-auto gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold transition-opacity"
                  style={{
                    border: `1px solid ${hidden ? '#e2e8f0' : color}`,
                    background: hidden ? '#f8fafc' : `${color}18`,
                    color: hidden ? '#94a3b8' : color,
                    opacity: hidden ? 0.5 : 1,
                  }}
                  onClick={() => toggleHide(comp)}
                  title={hidden ? t('dashboard.chart.show_comp') : t('dashboard.chart.hide_comp')}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: hidden ? '#d1d5db' : color,
                    }}
                  />
                  {comp}
                </Button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
export default MiniChart
