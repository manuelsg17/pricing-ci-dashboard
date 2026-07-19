import { BRACKETS, BRACKET_LABELS } from '../../lib/constants'
import { Button } from '../ui/shadcn/button'
import { useI18n } from '../../context/LanguageContext'

const BRACKET_OPTIONS = [
  { value: '', labelKey: 'access.all_m' },
  ...BRACKETS.map((b) => ({ value: b, label: BRACKET_LABELS[b] })),
]

const SURGE_OPTIONS = [
  { value: '', labelKey: 'access.all_m' },
  { value: 'true', labelKey: 'rawdata.surge_yes' },
  { value: 'false', labelKey: 'rawdata.surge_no' },
]

export default function RawDataFilterBar({
  config,
  dateFrom,
  setDateFrom,
  dateTo,
  setDateTo,
  dbCategory,
  setDbCategory,
  categories,
  competition,
  setCompetition,
  competitors,
  surge,
  setSurge,
  bracket,
  setBracket,
  dataSource,
  setDataSource,
  searchA,
  setSearchA,
  searchB,
  setSearchB,
  outlierOnly,
  setOutlierOnly,
  outlierThreshold,
  resetFilters,
}) {
  const { t } = useI18n()
  return (
    <div className="raw-data__filters">
      <div className="raw-data__filter-group">
        <label>{t('filter.from')}</label>
        <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
      </div>
      <div className="raw-data__filter-group">
        <label>{t('filter.to')}</label>
        <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
      </div>
      <div className="raw-data__filter-group">
        <label>{t('filter.category')}</label>
        <select value={dbCategory} onChange={(e) => setDbCategory(e.target.value)}>
          <option value="">{t('access.all_m')}</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
      <div className="raw-data__filter-group">
        <label>{t('rawdata.filter_competitor', { n: competitors.length })}</label>
        <select value={competition} onChange={(e) => setCompetition(e.target.value)}>
          <option value="">{t('access.all_m')}</option>
          {competitors.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
      <div className="raw-data__filter-group">
        <label>{t('filter.surge')}</label>
        <select value={surge} onChange={(e) => setSurge(e.target.value)}>
          {SURGE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {t(o.labelKey)}
            </option>
          ))}
        </select>
      </div>
      <div className="raw-data__filter-group">
        <label>{t('rawdata.filter_bracket')}</label>
        <select value={bracket} onChange={(e) => setBracket(e.target.value)}>
          {BRACKET_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.labelKey ? t(o.labelKey) : o.label}
            </option>
          ))}
        </select>
      </div>
      <div className="raw-data__filter-group">
        <label>{t('filter.source')}</label>
        <select value={dataSource} onChange={(e) => setDataSource(e.target.value)}>
          <option value="">{t('access.all_m')}</option>
          <option value="manual">{t('rawdata.source_hubs')}</option>
          <option value="bot">{t('filter.source_bot')}</option>
        </select>
      </div>
      <div className="raw-data__filter-group">
        <label>{t('dataentry.col_point_a')}</label>
        <input
          type="text"
          value={searchA}
          onChange={(e) => setSearchA(e.target.value)}
          placeholder={t('rawdata.search_placeholder')}
        />
      </div>
      <div className="raw-data__filter-group">
        <label>{t('dataentry.col_point_b')}</label>
        <input
          type="text"
          value={searchB}
          onChange={(e) => setSearchB(e.target.value)}
          placeholder={t('rawdata.search_placeholder')}
        />
      </div>
      <div className="raw-data__filter-group">
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={outlierOnly}
            onChange={(e) => setOutlierOnly(e.target.checked)}
          />
          <span style={{ color: outlierOnly ? '#dc2626' : undefined }}>
            {t('rawdata.outliers_label', {
              currency: config.currency,
              threshold: outlierThreshold,
            })}
          </span>
        </label>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-8 self-end border-border bg-background text-muted hover:border-yango hover:bg-background hover:text-yango"
        onClick={resetFilters}
        title={t('rawdata.clear_filters_title')}
      >
        {t('rawdata.clear_filters')}
      </Button>
    </div>
  )
}
