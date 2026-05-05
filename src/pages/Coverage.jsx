import { useState, useEffect } from 'react'
import { sb } from '../lib/supabase'
import { FilterProvider, useFilterContext } from '../context/FilterContext'
import { useCountry } from '../context/CountryContext'
import { useI18n } from '../context/LanguageContext'
import { usePricingData } from '../hooks/usePricingData'
import FilterBar from '../components/dashboard/FilterBar'
import CollapsibleSection from '../components/market/CollapsibleSection'
import CoverageReport from '../components/market/CoverageReport'
import BracketMix from '../components/market/BracketMix'

function CoverageContent() {
  const { country } = useCountry()
  const { filters } = useFilterContext()
  const { locale } = useI18n()
  const [filterBarVisible, setFilterBarVisible] = useState(true)

  // Cargar pesos/semáforo solo para que usePricingData funcione
  const [dbWeights,  setDbWeights]  = useState([])
  const [dbSemaforo, setDbSemaforo] = useState([])
  useEffect(() => {
    sb.from('bracket_weights').select('*').then(({ data }) => setDbWeights(data || []))
    sb.from('semaforo_config').select('*').order('band').order('min_pct').then(({ data }) => setDbSemaforo(data || []))
  }, [])

  const {
    loading, error,
    sampleMatrix, periods,
  } = usePricingData(filters, dbWeights, locale, dbSemaforo)

  return (
    <div style={{ padding: '16px 20px', maxWidth: '100%', overflowX: 'auto' }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>🛡️ Cobertura</h1>
      <p style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 14 }}>
        Calidad e integridad de la data antes de tomar decisiones — chequea esto si dudas de un número.
      </p>

      <div className="filter-bar-wrapper" style={{ marginBottom: 12 }}>
        <div className="filter-bar-toggle">
          <button
            className="filter-bar-toggle__btn"
            onClick={() => setFilterBarVisible(v => !v)}
          >
            {filterBarVisible ? '▲ Colapsar filtros' : '▼ Mostrar filtros'}
          </button>
        </div>
        <FilterBar className={filterBarVisible ? '' : 'filter-bar--collapsed'} />
      </div>

      {error && (
        <div className="state-box state-box--error">Error: {error}</div>
      )}

      {loading && periods.length === 0 ? (
        <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--color-muted)' }}>
          Cargando…
        </div>
      ) : periods.length === 0 ? (
        <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--color-muted)' }}>
          Sin datos para los filtros actuales.
        </div>
      ) : (
        <>
          <CollapsibleSection
            id="coverage"
            title="📊 Cobertura por celda"
            subtitle="Cantidad de observaciones por (competidor × bracket × período). Rojo = poco confiable."
            defaultOpen
          >
            <CoverageReport
              sampleMatrix={sampleMatrix}
              periods={periods}
              competitors={filters.competitors}
            />
          </CollapsibleSection>

          <CollapsibleSection
            id="mix"
            title="🥧 Mix de brackets por competidor"
            subtitle="Distribución relativa — desigualdades aquí desvirtúan comparaciones de WA"
            defaultOpen={false}
          >
            <BracketMix
              sampleMatrix={sampleMatrix}
              periods={periods}
              competitors={filters.competitors}
            />
          </CollapsibleSection>
        </>
      )}
    </div>
  )
}

export default function Coverage() {
  return (
    <FilterProvider>
      <CoverageContent />
    </FilterProvider>
  )
}
