import { useFilters }      from '../hooks/useFilters'
import { usePricingData }  from '../hooks/usePricingData'
import FilterBar           from '../components/dashboard/FilterBar'
import BracketSection      from '../components/dashboard/BracketSection'
import { BRACKETS, BRACKET_LABELS } from '../lib/constants'
import '../styles/dashboard.css'

const SECTIONS = [
  { bracket: '_wa',        label: 'Weighted Average' },
  { bracket: 'very_short', label: BRACKET_LABELS.very_short },
  { bracket: 'short',      label: BRACKET_LABELS.short },
  { bracket: 'median',     label: BRACKET_LABELS.median },
  { bracket: 'average',    label: BRACKET_LABELS.average },
  { bracket: 'long',       label: BRACKET_LABELS.long },
  { bracket: 'very_long',  label: BRACKET_LABELS.very_long },
]

export default function Dashboard({ dbWeights }) {
  const filterState = useFilters()
  const { filters } = filterState

  const {
    loading, error,
    priceMatrix, deltaMatrix, semaforoMatrix, diffMatrix,
    chartData, deltaChartData, periods,
  } = usePricingData(filters, dbWeights)

  return (
    <div className="dashboard">
      <FilterBar {...filterState} />

      {loading && (
        <div className="state-box">Cargando datos…</div>
      )}

      {error && (
        <div className="state-box state-box--error">Error: {error}</div>
      )}

      {!loading && !error && periods.length === 0 && (
        <div className="state-box">
          Sin datos para los filtros seleccionados. Prueba con otra ciudad, categoría o rango de fechas.
        </div>
      )}

      {!loading && periods.length > 0 && SECTIONS.map(({ bracket, label }) => (
        <BracketSection
          key={bracket}
          bracket={bracket}
          label={label}
          competitors={filters.competitors}
          periods={periods}
          priceMatrix={priceMatrix}
          deltaMatrix={deltaMatrix}
          semaforoMatrix={semaforoMatrix}
          diffMatrix={diffMatrix}
          compareVs={filters.compareVs}
          chartData={chartData[bracket] || []}
          deltaChartData={deltaChartData[bracket] || []}
        />
      ))}
    </div>
  )
}
