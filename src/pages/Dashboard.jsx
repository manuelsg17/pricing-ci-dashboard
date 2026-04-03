import { useFilters }      from '../hooks/useFilters'
import { usePricingData }  from '../hooks/usePricingData'
import FilterBar           from '../components/dashboard/FilterBar'
import PriceMatrix         from '../components/dashboard/PriceMatrix'
import DeltaMatrix         from '../components/dashboard/DeltaMatrix'
import SampleMatrix        from '../components/dashboard/SampleMatrix'
import BracketCharts       from '../components/dashboard/BracketCharts'
import '../styles/dashboard.css'

export default function Dashboard({ dbWeights }) {
  const filterState = useFilters()
  const { filters } = filterState

  const {
    loading, error,
    priceMatrix, deltaMatrix, semaforoMatrix, sampleMatrix,
    chartData, periods,
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

      {!loading && periods.length > 0 && (
        <>
          <PriceMatrix
            filters={filters}
            priceMatrix={priceMatrix}
            periods={periods}
          />

          <DeltaMatrix
            filters={filters}
            priceMatrix={priceMatrix}
            deltaMatrix={deltaMatrix}
            semaforoMatrix={semaforoMatrix}
            periods={periods}
          />

          <SampleMatrix
            filters={filters}
            sampleMatrix={sampleMatrix}
            periods={periods}
          />

          <BracketCharts
            chartData={chartData}
            competitors={filters.competitors}
          />
        </>
      )}
    </div>
  )
}
