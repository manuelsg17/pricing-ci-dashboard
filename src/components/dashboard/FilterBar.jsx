import { CITIES, CATEGORIES_BY_CITY, AEROPUERTO_SUBCATEGORIES, getCompetitors } from '../../lib/constants'
import { useI18n } from '../../context/LanguageContext'

export default function FilterBar({
  filters, zones,
  setCity, setCategory, setSubCategory, setZone, setSurge,
  setCompareVs, setViewMode, setWeekStart,
  setDailyStart,
  setHistoricFrom, setHistoricTo,
}) {
  const { city, category, subCategory, zone, surge, compareVs, viewMode, weekStart, dailyStart, dailyEnd, historicFrom, historicTo } = filters
  const categories  = CATEGORIES_BY_CITY[city] || []
  const competitors = getCompetitors(city, category, subCategory)
  const showSubCategory = category === 'Aeropuerto'
  const { t } = useI18n()

  // Forzar que weekStart siempre sea lunes
  const handleWeekStart = (e) => {
    const d = new Date(e.target.value + 'T00:00:00')
    const day = d.getDay() || 7
    if (day !== 1) {
      d.setDate(d.getDate() - (day - 1))
    }
    setWeekStart(d.toISOString().slice(0, 10))
  }

  return (
    <div className="filter-bar">
      {/* Ciudad */}
      <div className="filter-bar__group">
        <span className="filter-bar__label">{t('filter.city')}</span>
        <select value={city} onChange={e => setCity(e.target.value)}>
          {CITIES.map(c => <option key={c}>{c}</option>)}
        </select>
      </div>

      <div className="filter-bar__divider" />

      {/* Categoría */}
      <div className="filter-bar__group">
        <span className="filter-bar__label">{t('filter.category')}</span>
        <select value={category} onChange={e => setCategory(e.target.value)}>
          {categories.map(c => <option key={c}>{c}</option>)}
        </select>
      </div>

      {/* Sub-categoría (solo Aeropuerto) */}
      {showSubCategory && (
        <>
          <div className="filter-bar__divider" />
          <div className="filter-bar__group">
            <span className="filter-bar__label">Sub-cat.</span>
            <select value={subCategory || ''} onChange={e => setSubCategory(e.target.value)}>
              {AEROPUERTO_SUBCATEGORIES.map(c => <option key={c}>{c}</option>)}
            </select>
          </div>
        </>
      )}

      <div className="filter-bar__divider" />

      {/* Zona */}
      <div className="filter-bar__group">
        <span className="filter-bar__label">{t('filter.zone')}</span>
        <select value={zone} onChange={e => setZone(e.target.value)}>
          {zones.map(z => <option key={z}>{z}</option>)}
        </select>
      </div>

      <div className="filter-bar__divider" />

      {/* Surge */}
      <div className="filter-bar__group">
        <span className="filter-bar__label">{t('filter.surge')}</span>
        <select
          value={surge === null ? 'all' : String(surge)}
          onChange={e => setSurge(e.target.value === 'all' ? null : e.target.value === 'true')}
        >
          <option value="all">{t('filter.both_surge')}</option>
          <option value="true">{t('filter.yes')}</option>
          <option value="false">{t('filter.no')}</option>
        </select>
      </div>

      <div className="filter-bar__divider" />

      {/* Comparar vs */}
      <div className="filter-bar__group">
        <span className="filter-bar__label">{t('filter.compare_vs')}</span>
        <select value={compareVs} onChange={e => setCompareVs(e.target.value)}>
          {competitors.map(c => <option key={c}>{c}</option>)}
        </select>
      </div>

      <div className="filter-bar__divider" />

      {/* Modo de vista */}
      <div className="filter-bar__group">
        <span className="filter-bar__label">{t('filter.view_mode')}</span>
        <div className="filter-bar__view-toggle">
          <button
            className={viewMode === 'weekly' ? 'active' : ''}
            onClick={() => setViewMode('weekly')}
          >{t('filter.weekly')}</button>
          <button
            className={viewMode === 'daily' ? 'active' : ''}
            onClick={() => setViewMode('daily')}
          >{t('filter.daily')}</button>
          <button
            className={viewMode === 'historic' ? 'active' : ''}
            onClick={() => setViewMode('historic')}
          >{t('filter.historic')}</button>
        </div>
      </div>

      <div className="filter-bar__divider" />

      {/* Selector de fechas según modo */}
      {viewMode === 'weekly' && (
        <div className="filter-bar__group">
          <span className="filter-bar__label">{t('filter.from')} (L)</span>
          <input
            type="date"
            value={weekStart}
            onChange={handleWeekStart}
          />
        </div>
      )}
      {viewMode === 'daily' && (
        <div className="filter-bar__group">
          <span className="filter-bar__label">{t('filter.from')}</span>
          <input type="date" value={dailyStart} onChange={e => setDailyStart(e.target.value)} />
        </div>
      )}
      {viewMode === 'historic' && (
        <>
          <div className="filter-bar__group">
            <span className="filter-bar__label">{t('filter.from')} (L)</span>
            <input type="date" value={historicFrom} onChange={e => setHistoricFrom(e.target.value)} />
          </div>
          <div className="filter-bar__group">
            <span className="filter-bar__label">{t('filter.to')} (L)</span>
            <input type="date" value={historicTo} onChange={e => setHistoricTo(e.target.value)} />
          </div>
        </>
      )}
    </div>
  )
}
