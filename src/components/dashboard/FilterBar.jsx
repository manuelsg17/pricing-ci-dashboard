import { CITIES, CATEGORIES_BY_CITY, AEROPUERTO_SUBCATEGORIES, getCompetitors } from '../../lib/constants'

export default function FilterBar({
  filters, zones,
  setCity, setCategory, setSubCategory, setZone, setSurge,
  setCompareVs, setViewMode, setWeekStart,
  setDailyStart, setDailyEnd,
}) {
  const { city, category, subCategory, zone, surge, compareVs, viewMode, weekStart, dailyStart, dailyEnd } = filters
  const categories  = CATEGORIES_BY_CITY[city] || []
  const competitors = getCompetitors(city, category, subCategory)
  const showSubCategory = category === 'Aeropuerto'

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
        <span className="filter-bar__label">Ciudad</span>
        <select value={city} onChange={e => setCity(e.target.value)}>
          {CITIES.map(c => <option key={c}>{c}</option>)}
        </select>
      </div>

      <div className="filter-bar__divider" />

      {/* Categoría */}
      <div className="filter-bar__group">
        <span className="filter-bar__label">Categoría</span>
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
        <span className="filter-bar__label">Zona</span>
        <select value={zone} onChange={e => setZone(e.target.value)}>
          {zones.map(z => <option key={z}>{z}</option>)}
        </select>
      </div>

      <div className="filter-bar__divider" />

      {/* Surge */}
      <div className="filter-bar__group">
        <span className="filter-bar__label">Surge</span>
        <select
          value={surge === null ? 'all' : String(surge)}
          onChange={e => setSurge(e.target.value === 'all' ? null : e.target.value === 'true')}
        >
          <option value="all">Todos</option>
          <option value="true">Sí</option>
          <option value="false">No</option>
        </select>
      </div>

      <div className="filter-bar__divider" />

      {/* Comparar vs */}
      <div className="filter-bar__group">
        <span className="filter-bar__label">vs.</span>
        <select value={compareVs} onChange={e => setCompareVs(e.target.value)}>
          {competitors.map(c => <option key={c}>{c}</option>)}
        </select>
      </div>

      <div className="filter-bar__divider" />

      {/* Modo de vista */}
      <div className="filter-bar__group">
        <span className="filter-bar__label">Vista</span>
        <div className="filter-bar__view-toggle">
          <button
            className={viewMode === 'weekly' ? 'active' : ''}
            onClick={() => setViewMode('weekly')}
          >Semanal</button>
          <button
            className={viewMode === 'daily' ? 'active' : ''}
            onClick={() => setViewMode('daily')}
          >Diario</button>
        </div>
      </div>

      <div className="filter-bar__divider" />

      {/* Selector de fechas según modo */}
      {viewMode === 'weekly' ? (
        <div className="filter-bar__group">
          <span className="filter-bar__label">Inicio (lunes)</span>
          <input
            type="date"
            value={weekStart}
            onChange={handleWeekStart}
          />
        </div>
      ) : (
        <>
          <div className="filter-bar__group">
            <span className="filter-bar__label">Desde</span>
            <input type="date" value={dailyStart} onChange={e => setDailyStart(e.target.value)} />
          </div>
          <div className="filter-bar__group">
            <span className="filter-bar__label">Hasta</span>
            <input type="date" value={dailyEnd} onChange={e => setDailyEnd(e.target.value)} />
          </div>
        </>
      )}
    </div>
  )
}
