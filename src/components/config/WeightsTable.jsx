import { useState, useEffect, useMemo } from 'react'
import { BRACKETS, BRACKET_LABELS, getCountryConfig } from '../../lib/constants'
import { SIMPLE_AVG_SINCE } from '../../algorithms/weightedAverage'
import { isoWeekMonday } from '../../lib/dateUtils'
import SaveStatusBanner from './SaveStatusBanner'
import { useConfirm } from '../ui/ConfirmDialog'
import { useCountry } from '../../context/CountryContext'
import { useI18n } from '../../context/LanguageContext'
import { sb } from '../../lib/supabase'
import { Button } from '../ui/shadcn/button'

export default function WeightsTable({ weights, onSave, saving, country }) {
  const { dbConfigs } = useCountry()
  const config = getCountryConfig(country, dbConfigs)
  const { t, locale } = useI18n()

  // Fechas del corte Ponderado→Simple, derivadas de SIMPLE_AVG_SINCE (sin
  // drift). Recalculadas por locale para que se vean en el idioma activo.
  const waWeightedUntil = useMemo(
    () =>
      isoWeekMonday(SIMPLE_AVG_SINCE.year, SIMPLE_AVG_SINCE.week - 1).toLocaleDateString(locale, {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      }),
    [locale]
  )
  const waSimpleFrom = useMemo(
    () =>
      isoWeekMonday(SIMPLE_AVG_SINCE.year, SIMPLE_AVG_SINCE.week).toLocaleDateString(locale, {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      }),
    [locale]
  )
  const weightCities = useMemo(() => ['all', ...config.dbCities], [config.dbCities])

  // Lista de categorías disponibles para el país. 'all' es default y
  // siempre presente (representa pesos globales del país, retrocompat
  // con pre mig 56).
  const weightCategories = useMemo(() => {
    const cats = new Set(['all'])
    Object.values(config.categoriesByCity || {}).forEach((list) =>
      (list || []).forEach((c) => cats.add(c))
    )
    return Array.from(cats)
  }, [config.categoriesByCity])

  const [activeCity, setActiveCity] = useState(weightCities[1] || 'all')
  const [activeCategory, setActiveCategory] = useState('all')

  // Reseteo si cambia país
  useEffect(() => {
    if (!weightCities.includes(activeCity)) {
      setActiveCity(weightCities[1] || 'all')
    }
    if (!weightCategories.includes(activeCategory)) {
      setActiveCategory('all')
    }
  }, [country, weightCities, weightCategories, activeCity, activeCategory])

  const [local, setLocal] = useState({})
  const [saveMsg, setSaveMsg] = useState(null)

  const getKey = (city, category, bracket) => `${city}|||${category}|||${bracket}`

  // Lee la fila exacta para (city, category). Sin fallback —
  // la cascada se aplica en buildWeightsMap al consumir, no acá.
  const getDbValue = (bracket) => {
    const row = weights.find(
      (w) =>
        w.city === activeCity && (w.category ?? 'all') === activeCategory && w.bracket === bracket
    )
    return row ? (Number(row.weight) * 100).toFixed(2) : ''
  }

  const getValue = (bracket) => {
    const key = getKey(activeCity, activeCategory, bracket)
    if (key in local) return local[key]
    return getDbValue(bracket)
  }

  const isDirty = (bracket) => {
    const key = getKey(activeCity, activeCategory, bracket)
    if (!(key in local)) return false
    return String(local[key] ?? '') !== String(getDbValue(bracket) ?? '')
  }

  const hasUnsavedChanges = BRACKETS.some((b) => isDirty(b))

  const handleChange = (bracket, val) => {
    setSaveMsg(null)
    setLocal((prev) => ({ ...prev, [getKey(activeCity, activeCategory, bracket)]: val }))
  }

  const handleDiscard = () => {
    setSaveMsg(null)
    setLocal((prev) => {
      const next = { ...prev }
      BRACKETS.forEach((b) => delete next[getKey(activeCity, activeCategory, b)])
      return next
    })
  }

  // Suma total de pesos para validación
  const totalPct = useMemo(() => {
    return BRACKETS.reduce((sum, b) => {
      const v = parseFloat(getValue(b)) || 0
      return sum + v
    }, 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [local, weights, activeCity, activeCategory])

  const totalOk = Math.abs(totalPct - 100) < 0.1

  const confirm = useConfirm()

  const doSave = async (withSnapshot) => {
    setSaveMsg(null)

    const ok = await confirm({
      title: withSnapshot
        ? t('config.weights.confirm_snapshot_title')
        : t('config.thresholds.confirm_nosnapshot_title'),
      message: withSnapshot
        ? t('config.weights.confirm_snapshot_message')
        : t('config.weights.confirm_nosnapshot_message'),
      confirmText: withSnapshot
        ? t('config.thresholds.confirm_snapshot_btn')
        : t('config.thresholds.confirm_nosnapshot_btn'),
      cancelText: t('app.cancel'),
      danger: withSnapshot,
    })
    if (!ok) return

    if (withSnapshot) {
      const { error: snapErr } = await sb.rpc('freeze_pricing_wa', {
        p_country: country,
        p_label: t('config.weights.snapshot_label', { date: new Date().toISOString() }),
      })
      if (snapErr) {
        setSaveMsg({
          type: 'err',
          text: t('config.thresholds.snapshot_error', { msg: snapErr.message }),
        })
        return
      }
    }

    const rows = BRACKETS.map((b) => ({
      city: activeCity,
      category: activeCategory,
      bracket: b,
      weight: (parseFloat(getValue(b)) || 0) / 100,
    }))
    try {
      await onSave(rows)
      const snapNote = withSnapshot
        ? t('config.weights.snap_created')
        : t('config.weights.no_snapshot_suffix')
      const scopeLabel = `${activeCity === 'all' ? t('config.weights.global_label') : activeCity} / ${activeCategory === 'all' ? t('config.weights.all_categories_label') : activeCategory}`
      setSaveMsg({
        type: 'ok',
        text: t('config.weights.saved_toast', { scope: scopeLabel, snap: snapNote }),
      })
      setLocal((prev) => {
        const next = { ...prev }
        BRACKETS.forEach((b) => delete next[getKey(activeCity, activeCategory, b)])
        return next
      })
    } catch (e) {
      setSaveMsg({ type: 'err', text: t('config.thresholds.save_error', { msg: e.message }) })
    }
  }

  const handleSave = () => doSave(true)
  const handleSaveNoSnapshot = () => doSave(false)

  return (
    <div className="config-section">
      <h2>{t('config.weights.title')}</h2>
      <p style={{ fontSize: 11, color: '#888', marginBottom: 10 }}>
        {t('config.weights.subtitle')}
      </p>

      <div
        style={{
          marginBottom: 12,
          padding: '10px 14px',
          borderRadius: 6,
          background: '#dbeafe',
          border: '1px solid #93c5fd',
          color: '#1e3a8a',
          fontSize: 12.5,
          lineHeight: 1.5,
        }}
      >
        {t('config.weights.info_box', { until: waWeightedUntil, from: waSimpleFrom })}
        {country === 'Peru' && t('config.weights.info_peru_note')}
      </div>

      <div className="city-tabs" style={{ marginBottom: 6 }}>
        {weightCities.map((c) => (
          <button
            key={c}
            className={`city-tab${activeCity === c ? ' active' : ''}`}
            onClick={() => setActiveCity(c)}
          >
            {c === 'all' ? t('config.weights.global_default') : c}
          </button>
        ))}
      </div>

      <div
        style={{
          display: 'flex',
          gap: 6,
          alignItems: 'center',
          flexWrap: 'wrap',
          marginBottom: 12,
          fontSize: 12,
        }}
      >
        <strong style={{ marginRight: 4 }}>{t('config.weights.category_label')}</strong>
        {weightCategories.map((c) => (
          <button
            key={c}
            onClick={() => setActiveCategory(c)}
            style={{
              padding: '4px 10px',
              borderRadius: 14,
              fontSize: 11,
              border: activeCategory === c ? '1.5px solid #2563eb' : '1px solid #cbd5e1',
              background: activeCategory === c ? '#dbeafe' : '#fff',
              color: activeCategory === c ? '#1e3a8a' : '#475569',
              fontWeight: activeCategory === c ? 600 : 400,
              cursor: 'pointer',
            }}
          >
            {c === 'all' ? t('config.weights.all_categories_default') : c}
          </button>
        ))}
      </div>

      {hasUnsavedChanges && (
        <div
          style={{
            marginTop: 8,
            marginBottom: 12,
            padding: '10px 14px',
            borderRadius: 6,
            background: '#fef3c7',
            border: '1px solid #f59e0b',
            color: '#78350f',
            fontSize: 13,
            fontWeight: 500,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <span>
            ⚠ {t('config.thresholds.unsaved_prefix')}{' '}
            <strong>
              {activeCity === 'all' ? t('config.weights.global_label') : activeCity} /{' '}
              {activeCategory === 'all' ? t('config.weights.all_categories_label') : activeCategory}
            </strong>
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="bg-transparent border-[#b45309] text-[#78350f]"
            onClick={handleDiscard}
          >
            {t('config.discard_changes')}
          </Button>
        </div>
      )}

      <table className="config-table">
        <thead>
          <tr>
            <th style={{ textAlign: 'left' }}>{t('config.thresholds.col_bracket')}</th>
            <th scope="col">{t('config.weights.col_weight')}</th>
          </tr>
        </thead>
        <tbody>
          {BRACKETS.map((b) => {
            const dirty = isDirty(b)
            return (
              <tr key={b}>
                <td>{BRACKET_LABELS[b]}</td>
                <td>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    max="100"
                    value={getValue(b)}
                    onChange={(e) => handleChange(b, e.target.value)}
                    style={
                      dirty
                        ? {
                            background: '#fef3c7',
                            borderColor: '#f59e0b',
                            fontWeight: 600,
                            boxShadow: '0 0 0 2px rgba(245, 158, 11, 0.2)',
                          }
                        : undefined
                    }
                    title={
                      dirty
                        ? t('config.weights.db_hint', { value: getDbValue(b) || '0' })
                        : undefined
                    }
                  />
                </td>
              </tr>
            )
          })}
          <tr style={{ background: totalOk ? '#f0fdf4' : '#fffbeb' }}>
            <td style={{ fontWeight: 700 }}>{t('config.weights.total_label')}</td>
            <td>
              <span
                style={{
                  fontWeight: 700,
                  color: totalOk ? '#15803d' : '#b45309',
                }}
              >
                {totalPct.toFixed(2)}%{totalOk ? '' : t('config.weights.total_not_100')}
              </span>
            </td>
          </tr>
        </tbody>
      </table>

      <div
        className="config-footer"
        style={{ marginTop: 14, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}
      >
        {/* Primario: sin snapshot — el usuario lo usa frecuentemente */}
        <Button
          onClick={handleSaveNoSnapshot}
          disabled={saving || !hasUnsavedChanges}
          title={
            !hasUnsavedChanges
              ? t('config.semaforo.no_changes_title')
              : !totalOk
                ? t('config.weights.total_not_100_title', { pct: totalPct.toFixed(1) })
                : t('config.weights.save_no_snapshot_title')
          }
        >
          {saving ? t('account.saving') : t('config.thresholds.save_no_snapshot_btn')}
        </Button>
        {/* Secundario: con snapshot — para cambios que afectan data histórica significativa */}
        <Button
          variant="outline"
          className="border-slate-300 text-slate-600"
          onClick={handleSave}
          disabled={saving || !hasUnsavedChanges}
          title={t('config.thresholds.save_snapshot_title')}
        >
          📸 {t('config.thresholds.save_snapshot_btn')}
        </Button>
        <SaveStatusBanner status={saveMsg} onDismiss={() => setSaveMsg(null)} />
      </div>
    </div>
  )
}
