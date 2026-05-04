import { useState, useRef, useEffect } from 'react'
import { getCountryConfig, getCompetitors } from '../../lib/constants'
import { useI18n } from '../../context/LanguageContext'
import { useFilterContext } from '../../context/FilterContext'

const TIME_SLOTS = [
  { key: 'early_morning', label: 'Madrugada', range: '0–6h'  },
  { key: 'morning',       label: 'Mañana',    range: '6–12h' },
  { key: 'midday',        label: 'Mediodía',  range: '12–14h'},
  { key: 'afternoon',     label: 'Tarde',     range: '14–18h'},
  { key: 'evening',       label: 'Noche',     range: '18–24h'},
]

export default function FilterBar({ className = '' }) {
  const {
    filters, zones, country,
    setCity, setCategory, setSubCategory, setZone, setSurge, setDataSource,
    setCompareVs, setViewMode, setWeekStart,
    setDailyStart,
    setHistoricFrom, setHistoricTo,
    timeOfDay, setTimeOfDay, ALL_TIME_SLOTS,
  } = useFilterContext()

  const [timeOpen, setTimeOpen] = useState(false)
  const timeRef  = useRef(null)

  useEffect(() => {
    function onOutsideClick(e) {
      if (timeRef.current && !timeRef.current.contains(e.target)) setTimeOpen(false)
    }
    document.addEventListener('mousedown', onOutsideClick)
    return () => document.removeEventListener('mousedown', onOutsideClick)
  }, [])

  function toggleSlot(key) {
    setTimeOfDay(prev => {
      if (prev.includes(key)) {
        const next = prev.filter(s => s !== key)
        return next.length === 0 ? ALL_TIME_SLOTS : next
      }
      return [...prev, key]
    })
  }

  const allSelected = timeOfDay.length === ALL_TIME_SLOTS.length
  const timeLabel   = allSelected
    ? 'Todas'
    : TIME_SLOTS.filter(s => timeOfDay.includes(s.key)).map(s => s.label).join(', ')

  const config = getCountryConfig(country)
  const { city, category, subCategory, zone, surge, dataSource, compareVs, viewMode, weekStart, dailyStart, dailyEnd, historicFrom, historicTo } = filters
  const categories  = config.categoriesByCity[city] || []
  const competitors = getCompetitors(city, category, subCategory, country)
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
    <div className={`filter-bar${className ? ` ${className}` : ''}`}>
      {/* Ciudad */}
      <div className="filter-bar__group">
        <span className="filter-bar__label">{t('filter.city')}</span>
        <select value={city} onChange={e => setCity(e.target.value)}>
          {config.cities.map(c => <option key={c}>{c}</option>)}
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
            <span className="filter-bar__label">{t('filter.subcategory')}</span>
            <select value={subCategory || ''} onChange={e => setSubCategory(e.target.value)}>
              {(config.aeropuertoSubcategoriesByCity?.[city] || config.aeropuertoSubcategories || []).map(c => <option key={c}>{c}</option>)}
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

      {/* Franja horaria — dropdown con checkboxes */}
      <div className="filter-bar__group" ref={timeRef} style={{ position: 'relative' }}>
        <span className="filter-bar__label">{t('filter.time_of_day')}</span>
        <button
          type="button"
          onClick={() => setTimeOpen(v => !v)}
          style={{
            display: 'flex', alignItems: 'center', gap: 5,
            padding: '0 8px', height: 28, minWidth: 110, maxWidth: 200,
            border: `1px solid ${allSelected ? 'var(--color-border)' : '#E53935'}`,
            borderRadius: 'var(--radius-sm)',
            background: allSelected ? 'var(--color-bg)' : '#FFF5F5',
            color: allSelected ? 'var(--color-text)' : '#B71C1C',
            fontSize: 12, fontWeight: allSelected ? 400 : 600,
            cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden',
            transition: 'border-color 0.15s, background 0.15s',
          }}
        >
          <span style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            🕐 {timeLabel}
          </span>
          {!allSelected && (
            <span style={{
              background: '#E53935', color: '#fff',
              borderRadius: 10, fontSize: 10, fontWeight: 700,
              padding: '0 5px', lineHeight: '16px', flexShrink: 0,
            }}>
              {timeOfDay.length}/{ALL_TIME_SLOTS.length}
            </span>
          )}
          <span style={{ fontSize: 9, color: 'inherit', flexShrink: 0, opacity: 0.6 }}>
            {timeOpen ? '▲' : '▼'}
          </span>
        </button>

        {timeOpen && (
          <div style={{
            position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 200,
            background: 'var(--color-panel)',
            border: '1px solid var(--color-border)',
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(0,0,0,0.12), 0 2px 6px rgba(0,0,0,0.06)',
            minWidth: 220, overflow: 'hidden',
          }}>
            {/* Header del dropdown */}
            <div style={{
              padding: '8px 12px 6px',
              borderBottom: '1px solid var(--color-border)',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                {t('filter.time_of_day')}
              </span>
              <button
                type="button"
                onClick={() => setTimeOfDay(ALL_TIME_SLOTS)}
                style={{
                  fontSize: 10, fontWeight: 600,
                  color: allSelected ? 'var(--color-muted)' : '#E53935',
                  background: 'none', border: 'none', cursor: allSelected ? 'default' : 'pointer',
                  padding: 0, opacity: allSelected ? 0.4 : 1,
                }}
              >
                {t('filter.time_select_all')}
              </button>
            </div>

            {/* Opciones */}
            {TIME_SLOTS.map((slot, i) => {
              const checked = timeOfDay.includes(slot.key)
              return (
                <label
                  key={slot.key}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '7px 12px',
                    cursor: 'pointer',
                    background: checked ? 'rgba(229, 57, 53, 0.04)' : 'transparent',
                    borderBottom: i < TIME_SLOTS.length - 1 ? '1px solid var(--color-border)' : 'none',
                    transition: 'background 0.1s',
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = checked ? 'rgba(229,57,53,0.08)' : 'var(--color-bg)'}
                  onMouseLeave={e => e.currentTarget.style.background = checked ? 'rgba(229,57,53,0.04)' : 'transparent'}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleSlot(slot.key)}
                    style={{ accentColor: '#E53935', width: 14, height: 14, cursor: 'pointer', flexShrink: 0 }}
                  />
                  <div style={{ flex: 1 }}>
                    <div style={{
                      fontSize: 12, fontWeight: checked ? 600 : 400,
                      color: checked ? '#B71C1C' : 'var(--color-text)',
                    }}>
                      {slot.label}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--color-muted)', marginTop: 1 }}>
                      {slot.range}
                    </div>
                  </div>
                  {checked && (
                    <span style={{ fontSize: 12, color: '#E53935' }}>✓</span>
                  )}
                </label>
              )
            })}
          </div>
        )}
      </div>

      <div className="filter-bar__divider" />

      {/* Fuente: data del bot, hubs (manual) o ambos */}
      <div className="filter-bar__group">
        <span className="filter-bar__label">{t('filter.source')}</span>
        <select
          value={dataSource === null ? 'all' : dataSource}
          onChange={e => setDataSource(e.target.value === 'all' ? null : e.target.value)}
        >
          <option value="all">{t('filter.source_both')}</option>
          <option value="bot">{t('filter.source_bot')}</option>
          <option value="manual">{t('filter.source_hubs')}</option>
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
