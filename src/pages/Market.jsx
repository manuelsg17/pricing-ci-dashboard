import { useState } from 'react'
import { useFilterContext } from '../context/FilterContext'
import { useCountry } from '../context/CountryContext'
import { useI18n } from '../context/LanguageContext'
import { useConfigContext } from '../context/ConfigProvider'
import { usePricingData } from '../hooks/usePricingData'
import FilterBar from '../components/dashboard/FilterBar'
import CollapsibleSection from '../components/market/CollapsibleSection'
import AnomalyDigest from '../components/market/AnomalyDigest'
import WinLossByBracket from '../components/market/WinLossByBracket'
import HeatmapDayHour from '../components/market/HeatmapDayHour'
import Volatility from '../components/market/Volatility'
import RushVsValley from '../components/market/RushVsValley'
import DiscountIntensity from '../components/market/DiscountIntensity'
import SectionErrorBoundary from '../components/ui/SectionErrorBoundary'
import { humanizeError } from '../lib/humanizeError'

function MarketContent() {
  const { countryConfig } = useCountry()
  const { filters } = useFilterContext()
  const { t, locale } = useI18n()
  const { currency } = countryConfig
  const [filterBarVisible, setFilterBarVisible] = useState(true)
  // Sprint 2.4: weights/semaforo desde ConfigProvider en lugar de props.
  const { weights: dbWeights, semaforo: dbSemaforo } = useConfigContext()

  const { loading, error, priceMatrix, periods } = usePricingData(
    filters,
    dbWeights,
    locale,
    dbSemaforo
  )

  // Heatmap necesita un competidor focal — por defecto Yango (compareVs)
  const [focusComp, setFocusComp] = useState(null)
  const effectiveFocus = focusComp || filters.compareVs || filters.competitors[0] || 'Yango'

  return (
    <div style={{ padding: '16px 20px', maxWidth: '100%', overflowX: 'auto' }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>{t('market.page_title')}</h1>
      <p style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 14 }}>
        {t('market.page_subtitle')}
      </p>

      {/* Reusable filter bar */}
      <div className="filter-bar-wrapper" style={{ marginBottom: 12 }}>
        <div className="filter-bar-toggle">
          <button className="filter-bar-toggle__btn" onClick={() => setFilterBarVisible((v) => !v)}>
            {filterBarVisible ? t('filter.collapse_long') : t('filter.expand_long')}
          </button>
        </div>
        <FilterBar className={filterBarVisible ? '' : 'filter-bar--collapsed'} />
      </div>

      {error && (
        <div className="state-box state-box--error">
          {t('app.error_prefix')}
          {humanizeError(error)}
        </div>
      )}

      {loading && (!periods || periods.length === 0) ? (
        <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--color-muted)' }}>
          {t('market.loading')}
        </div>
      ) : !periods || periods.length === 0 ? (
        <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--color-muted)' }}>
          {t('market.empty_state')}
        </div>
      ) : (
        <>
          <SectionErrorBoundary label={t('market.section.summary_label')}>
            <CollapsibleSection
              id="anomalies"
              title={t('market.section.anomalies_title')}
              subtitle={t('market.section.anomalies_subtitle')}
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
          </SectionErrorBoundary>

          <SectionErrorBoundary label={t('market.section.winloss_label')}>
            <CollapsibleSection
              id="winloss"
              title={t('market.section.winloss_title')}
              subtitle={t('market.section.winloss_subtitle', { comp: filters.compareVs })}
              defaultOpen
            >
              <WinLossByBracket
                priceMatrix={priceMatrix}
                periods={periods}
                competitors={filters.competitors}
                compareVs={filters.compareVs}
              />
            </CollapsibleSection>
          </SectionErrorBoundary>

          <SectionErrorBoundary label={t('market.section.heatmap_label')}>
            <CollapsibleSection
              id="heatmap"
              title={t('market.section.heatmap_title')}
              subtitle={t('market.section.heatmap_subtitle')}
              defaultOpen
              action={
                <select
                  value={effectiveFocus}
                  onChange={(e) => setFocusComp(e.target.value)}
                  style={{
                    fontSize: 12,
                    padding: '4px 8px',
                    border: '1px solid var(--color-border)',
                    borderRadius: 4,
                  }}
                >
                  {(filters.competitors || []).map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              }
            >
              <HeatmapDayHour
                filters={filters}
                competitors={filters.competitors || []}
                focusComp={effectiveFocus}
              />
            </CollapsibleSection>
          </SectionErrorBoundary>

          <SectionErrorBoundary label={t('market.section.volatility_label')}>
            <CollapsibleSection
              id="volatility"
              title={t('market.section.volatility_title')}
              subtitle={t('market.section.volatility_subtitle')}
              defaultOpen={false}
            >
              <Volatility
                priceMatrix={priceMatrix}
                periods={periods}
                competitors={filters.competitors}
                currency={currency}
              />
            </CollapsibleSection>
          </SectionErrorBoundary>

          <SectionErrorBoundary label={t('market.section.rush_label')}>
            <CollapsibleSection
              id="rush"
              title={t('market.section.rush_title')}
              subtitle={t('market.section.rush_subtitle')}
              defaultOpen={false}
            >
              <RushVsValley filters={filters} currency={currency} />
            </CollapsibleSection>
          </SectionErrorBoundary>

          <SectionErrorBoundary label={t('market.section.discount_label')}>
            <CollapsibleSection
              id="discount"
              title={t('market.section.discount_title')}
              subtitle={t('market.section.discount_subtitle')}
              defaultOpen={false}
            >
              <DiscountIntensity filters={filters} currency={currency} />
            </CollapsibleSection>
          </SectionErrorBoundary>
        </>
      )}
    </div>
  )
}

// FilterProvider ahora vive en App.jsx (ver Dashboard.jsx para el porqué).
// Sprint 2.4: weights/semaforo via ConfigProvider — sin props desde App.
export default function Market() {
  return <MarketContent />
}
