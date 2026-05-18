import { useState } from 'react'
import { FilterProvider, useFilterContext } from '../context/FilterContext'
import { useI18n } from '../context/LanguageContext'
import { usePricingData } from '../hooks/usePricingData'
import FilterBar from '../components/dashboard/FilterBar'
import CollapsibleSection from '../components/market/CollapsibleSection'
import CoverageReport from '../components/market/CoverageReport'
import BracketMix from '../components/market/BracketMix'
import SectionErrorBoundary from '../components/ui/SectionErrorBoundary'

function CoverageContent({ dbWeights, dbSemaforo }) {
  const { filters } = useFilterContext()
  const { t, locale } = useI18n()
  const [filterBarVisible, setFilterBarVisible] = useState(true)

  // dbWeights/dbSemaforo vienen como props desde App.jsx, que ya los
  // mantiene cacheados via useStaleWhileRevalidate (mismo cache que
  // comparten Dashboard y Market). Antes Coverage los re-fetcheaba en
  // mount; eso fue eliminado para evitar 2 round-trips redundantes a
  // Supabase en cada navegación al tab.
  const {
    loading, error,
    sampleMatrix, periods,
  } = usePricingData(filters, dbWeights, locale, dbSemaforo)

  return (
    <div style={{ padding: '16px 20px', maxWidth: '100%', overflowX: 'auto' }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>{t('coverage.page_title')}</h1>
      <p style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 14 }}>
        {t('coverage.page_subtitle')}
      </p>

      <div className="filter-bar-wrapper" style={{ marginBottom: 12 }}>
        <div className="filter-bar-toggle">
          <button
            className="filter-bar-toggle__btn"
            onClick={() => setFilterBarVisible(v => !v)}
          >
            {filterBarVisible ? t('filter.collapse_long') : t('filter.expand_long')}
          </button>
        </div>
        <FilterBar className={filterBarVisible ? '' : 'filter-bar--collapsed'} />
      </div>

      {error && (
        <div className="state-box state-box--error">{t('app.error_prefix')}{error}</div>
      )}

      {loading && (!periods || periods.length === 0) ? (
        <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--color-muted)' }}>
          {t('app.loading')}
        </div>
      ) : (!periods || periods.length === 0) ? (
        <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--color-muted)' }}>
          {t('market.empty_state')}
        </div>
      ) : (
        <>
          <SectionErrorBoundary label={t('coverage.section.coverage_label')}>
            <CollapsibleSection
              id="coverage"
              title={t('coverage.section.coverage_title')}
              subtitle={t('coverage.section.coverage_subtitle')}
              defaultOpen
            >
              <CoverageReport
                sampleMatrix={sampleMatrix}
                periods={periods}
                competitors={filters.competitors || []}
              />
            </CollapsibleSection>
          </SectionErrorBoundary>

          <SectionErrorBoundary label={t('coverage.section.mix_label')}>
            <CollapsibleSection
              id="mix"
              title={t('coverage.section.mix_title')}
              subtitle={t('coverage.section.mix_subtitle')}
              defaultOpen={false}
            >
              <BracketMix
                sampleMatrix={sampleMatrix}
                periods={periods}
                competitors={filters.competitors || []}
              />
            </CollapsibleSection>
          </SectionErrorBoundary>
        </>
      )}
    </div>
  )
}

export default function Coverage({ dbWeights = [], dbSemaforo = [] }) {
  // Sin key={country} — ver Dashboard.jsx.
  return (
    <FilterProvider>
      <CoverageContent dbWeights={dbWeights} dbSemaforo={dbSemaforo} />
    </FilterProvider>
  )
}
