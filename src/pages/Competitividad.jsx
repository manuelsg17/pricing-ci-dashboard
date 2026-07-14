import { useState, useMemo } from 'react'
import { Info, Download } from 'lucide-react'
import { useFilterContext } from '../context/FilterContext'
import { useConfigContext } from '../context/ConfigProvider'
import { useCompetitiveBandAnalysis } from '../hooks/useCompetitiveBandAnalysis'
import { getISOYearWeek, getMondayWeeksAgo } from '../lib/dateUtils'
import { exportCompetitiveBandCsv } from '../lib/competitiveBandsExport'
import BandSelector from '../components/competitiveBands/BandSelector'
import ComplianceKpis from '../components/competitiveBands/ComplianceKpis'
import PercentileTable from '../components/competitiveBands/PercentileTable'
import CityBracketBreakdown from '../components/competitiveBands/CityBracketBreakdown'
import '../styles/config.css'

const WEEK_RANGE_OPTIONS = [
  { value: 4, label: 'Últimas 4 semanas' },
  { value: 8, label: 'Últimas 8 semanas' },
  { value: 12, label: 'Últimas 12 semanas' },
  { value: 26, label: 'Últimas 26 semanas' },
]

export default function Competitividad() {
  const { filters } = useFilterContext()
  const { competitiveBands, loading: configLoading } = useConfigContext()
  const country = filters.country

  const [selectedBand, setSelectedBand] = useState(null)
  const [weeksBack, setWeeksBack] = useState(8)
  const [drillDown, setDrillDown] = useState(null) // { city, bracket, summary } | null

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

  const { yearStart, weekStart, yearEnd, weekEnd } = useMemo(() => {
    const end = getISOYearWeek(new Date())
    const start = getISOYearWeek(getMondayWeeksAgo(weeksBack))
    return { yearStart: start.year, weekStart: start.week, yearEnd: end.year, weekEnd: end.week }
  }, [weeksBack])

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
        Qué % de las cotizaciones reales de Yango cae dentro de la banda competitiva configurada.
      </p>

      <div
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'flex-start',
          fontSize: 12,
          color: '#1e3a8a',
          marginBottom: 16,
          padding: '10px 14px',
          background: '#dbeafe',
          border: '1px solid #93c5fd',
          borderRadius: 6,
        }}
      >
        <Info size={15} style={{ flexShrink: 0, marginTop: 1 }} />
        <span>
          No existe forma de emparejar una cotización de Yango con la del competidor para el{' '}
          <strong>mismo viaje exacto</strong> (los datos no traen un identificador de ruta/momento
          compartido). Por eso, cada cotización real de Yango se compara contra el{' '}
          <strong>precio promedio del competidor</strong> en la misma ciudad, categoría, distancia y
          semana — esto sí muestra la volatilidad real de Yango, aunque no sea un pareo exacto
          viaje-por-viaje.
        </span>
      </div>

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
                style={{
                  padding: '6px 10px',
                  border: '1.5px solid var(--color-border)',
                  borderRadius: 6,
                  fontSize: 13,
                }}
              >
                {WEEK_RANGE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            {activeBand && (
              <div style={{ fontSize: 12, color: 'var(--color-muted)' }}>
                Banda configurada: <strong>{activeBand.min_pct}%</strong> a{' '}
                <strong>{activeBand.max_pct}%</strong>
                {activeBand.note && <> — {activeBand.note}</>}
              </div>
            )}
            <button
              onClick={handleExport}
              disabled={!summary}
              className="btn-add-row"
              style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              <Download size={13} />
              Exportar CSV
            </button>
          </div>

          {error && <div className="state-box state-box--error">Error: {error}</div>}

          {loading && !summary ? (
            <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--color-muted)' }}>
              Calculando…
            </div>
          ) : !summary || !summary.total_observations ? (
            <div className="state-box">
              Sin observaciones para esta banda en el período elegido.
            </div>
          ) : (
            <>
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
    </div>
  )
}
