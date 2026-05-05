import { useState } from 'react'
import { FilterProvider, useFilterContext } from '../context/FilterContext'
import { useCountry } from '../context/CountryContext'
import { useI18n } from '../context/LanguageContext'
import { usePricingData } from '../hooks/usePricingData'
import FilterBar from '../components/dashboard/FilterBar'
import CollapsibleSection from '../components/market/CollapsibleSection'
import AnomalyDigest from '../components/market/AnomalyDigest'
import WinLossByBracket from '../components/market/WinLossByBracket'
import HeatmapDayHour from '../components/market/HeatmapDayHour'
import Volatility from '../components/market/Volatility'
import RushVsValley from '../components/market/RushVsValley'
import DiscountIntensity from '../components/market/DiscountIntensity'

function MarketContent({ dbWeights, dbSemaforo }) {
  const { countryConfig } = useCountry()
  const { filters } = useFilterContext()
  const { locale } = useI18n()
  const { currency } = countryConfig
  const [filterBarVisible, setFilterBarVisible] = useState(true)

  const {
    loading, error,
    priceMatrix, periods,
  } = usePricingData(filters, dbWeights, locale, dbSemaforo)

  // Heatmap necesita un competidor focal — por defecto Yango (compareVs)
  const [focusComp, setFocusComp] = useState(null)
  const effectiveFocus = focusComp || filters.compareVs || filters.competitors[0] || 'Yango'

  return (
    <div style={{ padding: '16px 20px', maxWidth: '100%', overflowX: 'auto' }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>🎯 Mercado</h1>
      <p style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 14 }}>
        Análisis competitivo profundo — todas las secciones usan los mismos filtros de la barra de arriba.
      </p>

      {/* Reusable filter bar */}
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
          Cargando análisis…
        </div>
      ) : periods.length === 0 ? (
        <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--color-muted)' }}>
          Sin datos para los filtros actuales.
        </div>
      ) : (
        <>
          <CollapsibleSection
            id="anomalies"
            title="📋 Resumen ejecutivo · Movimientos atípicos"
            subtitle="Top movimientos del último período fuera de ±2σ del promedio histórico"
            defaultOpen
          >
            <AnomalyDigest
              priceMatrix={priceMatrix}
              periods={periods}
              competitors={filters.competitors}
              compareVs={filters.compareVs}
              limit={10}
            />
          </CollapsibleSection>

          <CollapsibleSection
            id="winloss"
            title="🏆 Win/Loss por bracket"
            subtitle={`En cuántos brackets ${filters.compareVs} fue el más barato cada período`}
            defaultOpen
          >
            <WinLossByBracket
              priceMatrix={priceMatrix}
              periods={periods}
              competitors={filters.competitors}
              compareVs={filters.compareVs}
            />
          </CollapsibleSection>

          <CollapsibleSection
            id="heatmap"
            title="🗓️ Heatmap día × hora"
            subtitle="Posición de cada competidor según día de la semana y franja horaria"
            defaultOpen
            action={
              <select
                value={effectiveFocus}
                onChange={e => setFocusComp(e.target.value)}
                style={{
                  fontSize: 12, padding: '4px 8px',
                  border: '1px solid var(--color-border)',
                  borderRadius: 4,
                }}
              >
                {filters.competitors.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            }
          >
            <HeatmapDayHour
              filters={filters}
              competitors={filters.competitors}
              focusComp={effectiveFocus}
            />
          </CollapsibleSection>

          <CollapsibleSection
            id="volatility"
            title="📊 Volatilidad por competidor"
            subtitle="Desviación estándar del WA — quién mueve precio agresivamente"
            defaultOpen={false}
          >
            <Volatility
              priceMatrix={priceMatrix}
              periods={periods}
              competitors={filters.competitors}
              currency={currency}
            />
          </CollapsibleSection>

          <CollapsibleSection
            id="rush"
            title="⚡ Rush vs Valley"
            subtitle="Diferencial de precio en hora pico vs valle por competidor"
            defaultOpen={false}
          >
            <RushVsValley filters={filters} currency={currency} />
          </CollapsibleSection>

          <CollapsibleSection
            id="discount"
            title="💸 Intensidad de descuentos"
            subtitle="Quién compite con descuentos sobre lista vs precio fijo"
            defaultOpen={false}
          >
            <DiscountIntensity filters={filters} currency={currency} />
          </CollapsibleSection>
        </>
      )}
    </div>
  )
}

export default function Market({ dbWeights, dbSemaforo }) {
  return (
    <FilterProvider>
      <MarketContent dbWeights={dbWeights} dbSemaforo={dbSemaforo} />
    </FilterProvider>
  )
}
