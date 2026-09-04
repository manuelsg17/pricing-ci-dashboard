import { useState, useRef, useEffect, useMemo } from 'react'
import '../../styles/dashboard.css' // usa .state-box/.filter-bar/.semaforo-*: no depender de que otra página lo cargue
import { toISODate } from '../../lib/dateUtils'
import { getCountryConfig, getCompetitors } from '../../lib/constants'
import { useI18n } from '../../context/LanguageContext'
import { useCountry } from '../../context/CountryContext'
import { useFilterContext } from '../../context/FilterContext'
import { useFilterPresets } from '../../hooks/useFilterPresets'
import { Clock, Star, ChevronDown, ChevronUp, Check, X, RotateCcw, Zap } from 'lucide-react'
import { Button } from '../ui/shadcn/button'

// Slots con keys estables y rangos (texto neutro entre idiomas). Los
// labels se traducen dentro del componente vía t('filter.time_slot.<key>')
// porque al nivel de módulo el t() de useI18n() no existe.
const TIME_SLOT_KEYS = [
  { key: 'early_morning', range: '0–6h' },
  { key: 'morning', range: '6–12h' },
  { key: 'midday', range: '12–14h' },
  { key: 'afternoon', range: '14–18h' },
  { key: 'evening', range: '18–24h' },
]

export default function FilterBar({ className = '' }) {
  const {
    filters,
    zones,
    country,
    setCity,
    setCategory,
    setZone,
    setSurge,
    setDataSource,
    setCompareVs,
    setViewMode,
    setWeekStart,
    setDailyStart,
    setHistoricFrom,
    setHistoricTo,
    timeOfDay,
    setTimeOfDay,
    ALL_TIME_SLOTS,
    applyPreset,
  } = useFilterContext()

  const [timeOpen, setTimeOpen] = useState(false)
  const [presetOpen, setPresetOpen] = useState(false)
  const [presetName, setPresetName] = useState('')
  const [saveFeedback, setSaveFeedback] = useState(false)
  const timeRef = useRef(null)
  const presetRef = useRef(null)

  const { presets, saving, savePreset, deletePreset } = useFilterPresets(country)

  useEffect(() => {
    function onOutsideClick(e) {
      if (timeRef.current && !timeRef.current.contains(e.target)) setTimeOpen(false)
      if (presetRef.current && !presetRef.current.contains(e.target)) setPresetOpen(false)
    }
    document.addEventListener('mousedown', onOutsideClick)
    return () => document.removeEventListener('mousedown', onOutsideClick)
  }, [])

  async function handleSavePreset() {
    const ok = await savePreset(presetName, filters)
    if (ok) {
      setPresetName('')
      setSaveFeedback(true)
      setTimeout(() => setSaveFeedback(false), 2000)
    }
  }

  function toggleSlot(key) {
    setTimeOfDay((prev) => {
      if (prev.includes(key)) {
        const next = prev.filter((s) => s !== key)
        return next.length === 0 ? ALL_TIME_SLOTS : next
      }
      return [...prev, key]
    })
  }

  const { t } = useI18n()

  // Slots traducidos (memoizado por idioma). Re-computa cuando el usuario
  // cambia el toggle de idioma, no en cada render.
  const TIME_SLOTS = useMemo(
    () =>
      TIME_SLOT_KEYS.map((s) => ({
        ...s,
        label: t(`filter.time_slot.${s.key}`),
      })),
    [t]
  )

  const allSelected = timeOfDay.length === ALL_TIME_SLOTS.length
  const timeLabel = allSelected
    ? t('filter.time_all')
    : TIME_SLOTS.filter((s) => timeOfDay.includes(s.key))
        .map((s) => s.label)
        .join(', ')

  function handleResetFilters() {
    setZone('All')
    setSurge(null)
    setDataSource(null)
    setTimeOfDay(ALL_TIME_SLOTS)
  }

  // dbConfigs cubre países onboardeados via wizard (no en constants.js).
  const { dbConfigs } = useCountry()
  const config = getCountryConfig(country, dbConfigs)
  const {
    city,
    category,
    subCategory,
    zone,
    surge,
    dataSource,
    compareVs,
    viewMode,
    weekStart,
    dailyStart,
    historicFrom,
    historicTo,
  } = filters
  const categories = config.categoriesByCity[city] || []
  const competitors = getCompetitors(city, category, subCategory, country, dbConfigs)

  // Forzar que weekStart siempre sea lunes
  const handleWeekStart = (e) => {
    const d = new Date(e.target.value + 'T00:00:00')
    const day = d.getDay() || 7
    if (day !== 1) {
      d.setDate(d.getDate() - (day - 1))
    }
    setWeekStart(toISODate(d))
  }

  // Chips de filtros activos (no-default): zona / surge / fuente / franja.
  // city/category/viewMode/weekStart no aparecen (siempre tienen valor).
  const activeChips = []
  if (zone && zone !== 'All') {
    activeChips.push({
      key: 'zone',
      label: `${t('filter.zone')}: ${zone}`,
      clear: () => setZone('All'),
    })
  }
  if (surge !== null && surge !== undefined) {
    activeChips.push({
      key: 'surge',
      label: `${t('filter.surge')}: ${surge ? t('filter.yes') : t('filter.no')}`,
      clear: () => setSurge(null),
    })
  }
  if (dataSource) {
    activeChips.push({
      key: 'source',
      label: `${t('filter.source')}: ${dataSource === 'bot' ? t('filter.source_bot') : t('filter.source_hubs')}`,
      clear: () => setDataSource(null),
    })
  }
  if (!allSelected) {
    activeChips.push({
      key: 'time',
      label: `${t('filter.time_of_day')}: ${timeOfDay.length}/${ALL_TIME_SLOTS.length}`,
      clear: () => setTimeOfDay(ALL_TIME_SLOTS),
    })
  }

  return (
    <div className={`filter-bar${className ? ` ${className}` : ''}`}>
      {/* Ciudad */}
      <div className="filter-bar__group">
        <span className="filter-bar__label">{t('filter.city')}</span>
        <select value={city} onChange={(e) => setCity(e.target.value)}>
          {config.cities.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </div>

      <div className="filter-bar__divider" />

      {/* Categoría */}
      <div className="filter-bar__group">
        <span className="filter-bar__label">{t('filter.category')}</span>
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          {categories.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </div>

      <div className="filter-bar__divider" />

      {/* Zona */}
      <div className="filter-bar__group">
        <span className="filter-bar__label">{t('filter.zone')}</span>
        <select value={zone} onChange={(e) => setZone(e.target.value)}>
          {zones.map((z) => (
            <option key={z}>{z}</option>
          ))}
        </select>
      </div>

      <div className="filter-bar__divider" />

      {/* Surge */}
      <div className="filter-bar__group">
        <span
          className="filter-bar__label"
          title={t('filter.surge_tooltip')}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}
        >
          {t('filter.surge')} <Zap size={11} />
        </span>
        <select
          value={surge === null ? 'all' : String(surge)}
          onChange={(e) => setSurge(e.target.value === 'all' ? null : e.target.value === 'true')}
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
          onClick={() => setTimeOpen((v) => !v)}
          className={`fb-control${allSelected ? '' : ' fb-control--active'}`}
          style={{ minWidth: 120, maxWidth: 210, overflow: 'hidden' }}
        >
          <Clock size={13} />
          <span
            style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis' }}
          >
            {timeLabel}
          </span>
          {!allSelected && (
            <span className="fb-badge">
              {timeOfDay.length}/{ALL_TIME_SLOTS.length}
            </span>
          )}
          {timeOpen ? (
            <ChevronUp size={13} style={{ opacity: 0.6 }} />
          ) : (
            <ChevronDown size={13} style={{ opacity: 0.6 }} />
          )}
        </button>

        {timeOpen && (
          <div className="fb-popover">
            <div className="fb-popover__header">
              <span>{t('filter.time_of_day')}</span>
              <button
                type="button"
                onClick={() => setTimeOfDay(ALL_TIME_SLOTS)}
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  color: allSelected ? 'var(--color-muted)' : 'var(--color-yango)',
                  background: 'none',
                  border: 'none',
                  cursor: allSelected ? 'default' : 'pointer',
                  padding: 0,
                  opacity: allSelected ? 0.4 : 1,
                  textTransform: 'none',
                  letterSpacing: 0,
                }}
              >
                {t('filter.time_select_all')}
              </button>
            </div>

            {TIME_SLOTS.map((slot) => {
              const checked = timeOfDay.includes(slot.key)
              return (
                <label
                  key={slot.key}
                  className="fb-popover__item"
                  style={checked ? { background: 'var(--color-yango-light)' } : undefined}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleSlot(slot.key)}
                    style={{
                      accentColor: 'var(--color-yango)',
                      width: 14,
                      height: 14,
                      cursor: 'pointer',
                      flexShrink: 0,
                    }}
                  />
                  <div style={{ flex: 1 }}>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: checked ? 600 : 400,
                        color: checked ? 'var(--color-yango-dark)' : 'var(--color-text)',
                      }}
                    >
                      {slot.label}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--color-muted)', marginTop: 1 }}>
                      {slot.range}
                    </div>
                  </div>
                  {checked && (
                    <Check size={14} style={{ color: 'var(--color-yango)', flexShrink: 0 }} />
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
          onChange={(e) => setDataSource(e.target.value === 'all' ? null : e.target.value)}
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
        <select value={compareVs} onChange={(e) => setCompareVs(e.target.value)}>
          {competitors.map((c) => (
            <option key={c}>{c}</option>
          ))}
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
          >
            {t('filter.weekly')}
          </button>
          <button
            className={viewMode === 'daily' ? 'active' : ''}
            onClick={() => setViewMode('daily')}
          >
            {t('filter.daily')}
          </button>
          <button
            className={viewMode === 'historic' ? 'active' : ''}
            onClick={() => setViewMode('historic')}
          >
            {t('filter.historic')}
          </button>
        </div>
      </div>

      <div className="filter-bar__divider" />

      {/* Selector de fechas según modo */}
      {viewMode === 'weekly' && (
        <div className="filter-bar__group">
          <span className="filter-bar__label">
            {t('filter.from')} {t('filter.monday_hint')}
          </span>
          <input type="date" value={weekStart} onChange={handleWeekStart} />
        </div>
      )}
      {viewMode === 'daily' && (
        <div className="filter-bar__group">
          <span className="filter-bar__label">{t('filter.from')}</span>
          <input type="date" value={dailyStart} onChange={(e) => setDailyStart(e.target.value)} />
        </div>
      )}
      {viewMode === 'historic' && (
        <>
          <div className="filter-bar__group">
            <span className="filter-bar__label">
              {t('filter.from')} {t('filter.monday_hint')}
            </span>
            <input
              type="date"
              value={historicFrom}
              onChange={(e) => setHistoricFrom(e.target.value)}
            />
          </div>
          <div className="filter-bar__group">
            <span className="filter-bar__label">
              {t('filter.to')} {t('filter.monday_hint')}
            </span>
            <input type="date" value={historicTo} onChange={(e) => setHistoricTo(e.target.value)} />
          </div>
        </>
      )}

      <div className="filter-bar__divider" />

      {/* #23 — filter presets */}
      <div className="filter-bar__group" ref={presetRef} style={{ position: 'relative' }}>
        <span className="filter-bar__label">{t('dashboard.preset.label')}</span>
        <button type="button" onClick={() => setPresetOpen((v) => !v)} className="fb-control">
          <Star size={13} />
          {presets.length > 0 && <span className="fb-badge">{presets.length}</span>}
          {presetOpen ? (
            <ChevronUp size={13} style={{ opacity: 0.6 }} />
          ) : (
            <ChevronDown size={13} style={{ opacity: 0.6 }} />
          )}
        </button>

        {presetOpen && (
          <div className="fb-popover fb-popover--right" style={{ minWidth: 240 }}>
            {/* Save new preset */}
            <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--color-border)' }}>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: 'var(--color-muted)',
                  textTransform: 'uppercase',
                  marginBottom: 6,
                }}
              >
                {t('dashboard.preset.save')}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  type="text"
                  value={presetName}
                  onChange={(e) => setPresetName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSavePreset()}
                  placeholder={t('dashboard.preset.name_placeholder')}
                  style={{
                    flex: 1,
                    padding: '4px 8px',
                    fontSize: 12,
                    border: '1px solid var(--color-border)',
                    borderRadius: 'var(--radius-sm)',
                    outline: 'none',
                  }}
                />
                <Button
                  type="button"
                  size="sm"
                  onClick={handleSavePreset}
                  disabled={saving || !presetName.trim()}
                  className={
                    saveFeedback ? 'min-w-[34px] bg-green-600 hover:bg-green-600' : 'min-w-[34px]'
                  }
                >
                  {saveFeedback ? <Check size={14} /> : t('app.save')}
                </Button>
              </div>
            </div>

            {/* Saved presets list */}
            {presets.length === 0 ? (
              <div
                style={{
                  padding: '12px 14px',
                  fontSize: 12,
                  color: 'var(--color-muted)',
                  textAlign: 'center',
                }}
              >
                {t('app.no_data')}
              </div>
            ) : (
              <div style={{ maxHeight: 200, overflowY: 'auto' }}>
                {presets.map((preset) => (
                  <div
                    key={preset.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      padding: '8px 12px',
                      borderBottom: '1px solid var(--color-border-soft)',
                      gap: 8,
                    }}
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => {
                        applyPreset(preset.filters)
                        setPresetOpen(false)
                      }}
                      title={t('dashboard.preset.load')}
                      className="h-auto flex-1 justify-start gap-1.5 p-0 text-xs font-medium text-[var(--color-text)] hover:bg-transparent hover:text-[var(--color-text)]"
                    >
                      <Star size={12} style={{ color: 'var(--color-yango)', flexShrink: 0 }} />{' '}
                      {preset.name}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => deletePreset(preset.id)}
                      title={t('dashboard.preset.delete')}
                      className="h-auto w-auto p-0.5 text-red-500 opacity-60 hover:bg-transparent hover:opacity-100"
                    >
                      <X size={14} />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Chips de filtros activos (removibles) + limpiar todo */}
      {activeChips.length > 0 && (
        <>
          <div className="filter-bar__divider" />
          <div className="filter-bar__group" style={{ gap: 6, flexWrap: 'wrap' }}>
            {activeChips.map((c) => (
              <span key={c.key} className="fb-chip">
                {c.label}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={c.clear}
                  aria-label={`${t('filter.reset')} ${c.label}`}
                  title={`${t('filter.reset')} ${c.label}`}
                  className="h-4 w-4 rounded-full p-0 text-[var(--color-yango-dark)] opacity-70 hover:bg-[rgba(198,40,40,0.12)] hover:text-[var(--color-yango-dark)] hover:opacity-100"
                >
                  <X size={12} aria-hidden="true" />
                </Button>
              </span>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleResetFilters}
              title={t('filter.reset_title') || 'Restablecer filtros a valores neutros'}
            >
              <RotateCcw size={13} /> {t('filter.reset') || 'Limpiar'}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
