import { useState, useMemo } from 'react'
import { Download } from 'lucide-react'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../components/ui/shadcn/tabs'
import { Button } from '../components/ui/shadcn/button'
import { useFilterContext } from '../context/FilterContext'
import { useConfigContext } from '../context/ConfigProvider'
import { useCompetitiveBandAnalysis } from '../hooks/useCompetitiveBandAnalysis'
import { getISOYearWeek, getMondayWeeksAgo } from '../lib/dateUtils'
import { exportCompetitiveBandCsv } from '../lib/competitiveBandsExport'
import BandSelector from '../components/competitiveBands/BandSelector'
import ComplianceKpis from '../components/competitiveBands/ComplianceKpis'
import PercentileTable from '../components/competitiveBands/PercentileTable'
import CityBracketBreakdown from '../components/competitiveBands/CityBracketBreakdown'
import PriceVolatilityChart from '../components/competitiveBands/PriceVolatilityChart'
import '../styles/config.css'

const WEEK_RANGE_OPTIONS = [
  { value: 1, label: 'Última semana' },
  { value: 4, label: 'Últimas 4 semanas' },
  { value: 8, label: 'Últimas 8 semanas' },
  { value: 12, label: 'Últimas 12 semanas' },
  { value: 26, label: 'Últimas 26 semanas' },
]

// Lectura instantánea del cumplimiento, antes de los números detallados —
// el pedido del usuario fue "que sea muy fácil de entender".
function verdictFor(withinPct) {
  const v = Number(withinPct)
  if (!Number.isFinite(v)) return null
  if (v >= 60) return { emoji: '🟢', label: 'Mayormente competitivo', color: 'var(--sem-green-fg)' }
  if (v >= 30) return { emoji: '🟡', label: 'Resultados mixtos', color: 'var(--sem-yellow-fg)' }
  return { emoji: '🔴', label: 'Mayormente fuera de rango', color: 'var(--sem-red-fg)' }
}

export default function Competitividad() {
  const { filters } = useFilterContext()
  const { competitiveBands, loading: configLoading } = useConfigContext()
  const country = filters.country

  const [selectedBand, setSelectedBand] = useState(null)
  const [weeksBack, setWeeksBack] = useState(8)
  const [useCustomRange, setUseCustomRange] = useState(false)
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [drillDown, setDrillDown] = useState(null) // { city, bracket, summary } | null
  const [activeTab, setActiveTab] = useState('cumplimiento')

  const countryBands = useMemo(
    () => competitiveBands.filter((b) => b.country === country && b.is_active !== false),
    [competitiveBands, country]
  )

  // Auto-select la primera banda disponible del país si no hay ninguna elegida
  // (o si la elegida ya no pertenece a este país tras un cambio de país).
  // .find() (no .some()+objeto viejo): si otra sesión edita min_pct/max_pct/
  // note de la banda actualmente seleccionada, esto trae el objeto FRESCO de
  // countryBands en vez de servir los valores obsoletos que quedaron en el
  // useState selectedBand tras el live-sync.
  const activeBand =
    (selectedBand && countryBands.find((b) => b.id === selectedBand.id)) || countryBands[0] || null

  // Rango personalizado (fechas exactas) tiene prioridad sobre el preset de
  // semanas cuando está activo y ambas fechas están completas — la data
  // igual vive en buckets semanales (ISO year/week), así que cada fecha
  // elegida solo determina a qué semana pertenece.
  const { yearStart, weekStart, yearEnd, weekEnd } = useMemo(() => {
    if (useCustomRange && customFrom && customTo) {
      const start = getISOYearWeek(new Date(`${customFrom}T00:00:00`))
      const end = getISOYearWeek(new Date(`${customTo}T00:00:00`))
      return { yearStart: start.year, weekStart: start.week, yearEnd: end.year, weekEnd: end.week }
    }
    const end = getISOYearWeek(new Date())
    const start = getISOYearWeek(getMondayWeeksAgo(weeksBack))
    return { yearStart: start.year, weekStart: start.week, yearEnd: end.year, weekEnd: end.week }
  }, [weeksBack, useCustomRange, customFrom, customTo])

  const { summary, breakdown, loading, error, drillInto } = useCompetitiveBandAnalysis({
    country,
    competitorName: activeBand?.competitor_name,
    category: activeBand?.category,
    minPct: activeBand ? Number(activeBand.min_pct) : null,
    maxPct: activeBand ? Number(activeBand.max_pct) : null,
    yearStart,
    weekStart,
    yearEnd,
    weekEnd,
  })

  const verdict = summary?.total_observations ? verdictFor(summary.within_pct) : null

  async function handleCellClick(city, bracket, cell) {
    const detail = await drillInto(city, bracket)
    setDrillDown({ city, bracket, cell, detail })
  }

  function handleExport() {
    if (!activeBand || !summary) return
    exportCompetitiveBandCsv({
      country,
      competitorName: activeBand.competitor_name,
      category: activeBand.category,
      minPct: activeBand.min_pct,
      maxPct: activeBand.max_pct,
      summary,
      breakdown,
    })
  }

  return (
    <div style={{ padding: '16px 20px', maxWidth: '100%', overflowX: 'auto' }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Competitividad</h1>
      <p style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 14 }}>
        Comparación de precios de Yango vs la competencia: cumplimiento de tu meta y qué tan estable
        es cada uno.
      </p>

      <div
        style={{
          display: 'flex',
          gap: 16,
          alignItems: 'flex-end',
          flexWrap: 'wrap',
          marginBottom: 16,
        }}
      >
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
            Período
          </div>
          <select
            value={weeksBack}
            onChange={(e) => setWeeksBack(Number(e.target.value))}
            disabled={useCustomRange}
            style={{
              padding: '6px 10px',
              border: '1.5px solid var(--color-border)',
              borderRadius: 6,
              fontSize: 13,
              opacity: useCustomRange ? 0.5 : 1,
            }}
          >
            {WEEK_RANGE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        <label
          style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, paddingBottom: 7 }}
        >
          <input
            type="checkbox"
            checked={useCustomRange}
            onChange={(e) => setUseCustomRange(e.target.checked)}
          />
          Rango de fechas personalizado
        </label>

        {useCustomRange && (
          <>
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
                Desde
              </div>
              <input
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                style={{
                  padding: '6px 10px',
                  border: '1.5px solid var(--color-border)',
                  borderRadius: 6,
                  fontSize: 13,
                }}
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
                Hasta
              </div>
              <input
                type="date"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                style={{
                  padding: '6px 10px',
                  border: '1.5px solid var(--color-border)',
                  borderRadius: 6,
                  fontSize: 13,
                }}
              />
            </div>
          </>
        )}
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="grid w-full max-w-md grid-cols-2">
          <TabsTrigger value="cumplimiento">Cumplimiento de banda</TabsTrigger>
          <TabsTrigger value="volatilidad">Volatilidad de precios</TabsTrigger>
        </TabsList>

        <TabsContent value="cumplimiento" className="mt-4">
          <details
            style={{
              fontSize: 12,
              color: '#1e3a8a',
              marginBottom: 16,
              padding: '8px 14px',
              background: '#dbeafe',
              border: '1px solid #93c5fd',
              borderRadius: 6,
            }}
          >
            <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
              ℹ️ ¿Cómo se calcula esto?
            </summary>
            <p style={{ marginTop: 8, marginBottom: 0 }}>
              No existe forma de emparejar una cotización de Yango con la del competidor para el{' '}
              <strong>mismo viaje exacto</strong> (los datos no traen un identificador de
              ruta/momento compartido). Por eso, cada cotización real de Yango se compara contra el{' '}
              <strong>precio promedio del competidor</strong> en la misma ciudad, categoría,
              distancia y semana — esto sí muestra la volatilidad real de Yango, aunque no sea un
              pareo exacto viaje-por-viaje.
            </p>
          </details>

          {configLoading ? (
            <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--color-muted)' }}>
              Cargando…
            </div>
          ) : countryBands.length === 0 ? (
            <div className="config-section">
              <BandSelector
                bands={countryBands}
                selectedId={activeBand?.id}
                onSelect={setSelectedBand}
              />
            </div>
          ) : (
            <>
              <div
                className="config-section"
                style={{
                  display: 'flex',
                  gap: 16,
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  marginBottom: 16,
                }}
              >
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
                    Banda
                  </div>
                  <BandSelector
                    bands={countryBands}
                    selectedId={activeBand?.id}
                    onSelect={setSelectedBand}
                  />
                </div>
                {activeBand && (
                  <div style={{ fontSize: 13 }}>
                    <strong>
                      {activeBand.note || `${activeBand.competitor_name} — ${activeBand.category}`}
                    </strong>
                    <span
                      style={{ fontSize: 11, color: 'var(--color-muted)', marginLeft: 6 }}
                      title="Banda configurada, en Δ% (Yango vs rival)"
                    >
                      ({activeBand.min_pct}% a {activeBand.max_pct}%)
                    </span>
                  </div>
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="ml-auto gap-1.5 border-dashed border-border text-muted hover:border-yango hover:text-yango"
                  onClick={handleExport}
                  disabled={!summary}
                >
                  <Download size={13} />
                  Exportar CSV
                </Button>
              </div>

              {error && <div className="state-box state-box--error">Error: {error}</div>}

              {loading && !summary ? (
                <div
                  style={{ padding: '40px 0', textAlign: 'center', color: 'var(--color-muted)' }}
                >
                  Calculando…
                </div>
              ) : !summary || !summary.total_observations ? (
                <div className="state-box">
                  Sin observaciones para esta banda en el período elegido.
                </div>
              ) : (
                <>
                  {verdict && (
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        fontSize: 16,
                        fontWeight: 700,
                        marginBottom: 14,
                        color: verdict.color,
                      }}
                    >
                      <span style={{ fontSize: 22 }}>{verdict.emoji}</span>
                      {verdict.label}
                    </div>
                  )}
                  <ComplianceKpis summary={summary} />
                  <PercentileTable summary={summary} />
                  <CityBracketBreakdown breakdown={breakdown} onCellClick={handleCellClick} />

                  {drillDown && (
                    <div className="config-section" style={{ marginTop: 16 }}>
                      <h2 style={{ margin: 0, marginBottom: 10 }}>
                        Detalle — {drillDown.city} / {drillDown.bracket}
                      </h2>
                      {drillDown.detail ? (
                        <>
                          <ComplianceKpis summary={drillDown.detail} />
                          <PercentileTable summary={drillDown.detail} />
                        </>
                      ) : (
                        <div style={{ color: 'var(--color-muted)', fontSize: 13 }}>Sin datos.</div>
                      )}
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </TabsContent>

        <TabsContent value="volatilidad" className="mt-4">
          {/* Lazy: solo dispara su RPC si esta tab está activa (mismo criterio que Config.jsx) */}
          {activeTab === 'volatilidad' && (
            <PriceVolatilityChart
              country={country}
              yearStart={yearStart}
              weekStart={weekStart}
              yearEnd={yearEnd}
              weekEnd={weekEnd}
            />
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
