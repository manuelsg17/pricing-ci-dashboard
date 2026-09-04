import { useState, useEffect, useCallback } from 'react'
import { toISODate } from '../lib/dateUtils'
import {
  useMarketEventsAdmin,
  insertMarketEvent,
  updateMarketEvent,
  deleteMarketEvent,
} from '../hooks/useMarketEvents'
import { useAuth } from '../lib/auth'
import { useI18n } from '../context/LanguageContext'
import { useToast } from '../components/ui/Toast'
import { useConfirm } from '../components/ui/ConfirmDialog'
import EmptyState from '../components/ui/EmptyState'
import { SkeletonTable } from '../components/ui/Skeleton'
import { Button } from '../components/ui/shadcn/button'
import '../styles/market-events.css'

const EVENT_TYPES = [
  { value: 'huelga', labelKey: 'market_events.type.huelga' },
  { value: 'lluvia', labelKey: 'market_events.type.lluvia' },
  { value: 'feriado', labelKey: 'market_events.type.feriado' },
  { value: 'promo_competidor', labelKey: 'market_events.type.promo_competidor' },
  { value: 'regulacion', labelKey: 'market_events.type.regulacion' },
  { value: 'otro', labelKey: 'market_events.type.otro' },
]

const IMPACT_OPTIONS = [
  { value: 'alto', labelKey: 'dashboard.chart.impact_high' },
  { value: 'medio', labelKey: 'dashboard.chart.impact_med' },
  { value: 'bajo', labelKey: 'dashboard.chart.impact_low' },
]

function todayStr() {
  return toISODate(new Date())
}

function thirtyDaysAgo() {
  const d = new Date()
  d.setDate(d.getDate() - 30)
  return toISODate(d)
}

import { useCountry } from '../context/CountryContext'

export default function MarketEvents() {
  const { session } = useAuth()
  const userEmail = session?.user?.email || ''
  const { country, countryConfig } = useCountry()
  const uiCities = countryConfig.cities
  const dbCities = countryConfig.dbCities
  const toast = useToast()
  const confirm = useConfirm()
  const { t } = useI18n()

  const [filterCity, setFilterCity] = useState('Todas')
  const [filterFrom, setFilterFrom] = useState(thirtyDaysAgo())
  const [filterTo, setFilterTo] = useState(todayStr())

  const [saving, setSaving] = useState(false)

  // Local edits (for both existing and new rows)
  const [edits, setEdits] = useState({})

  // Consulta en useMarketEvents.js; al recargar se descartan los edits locales
  // (mismo orden que antes: filas nuevas → edits vacíos → loading off).
  const onLoaded = useCallback(() => setEdits({}), [])
  const { events, setEvents, loading, load } = useMarketEventsAdmin({
    country,
    filterCity,
    filterFrom,
    filterTo,
    onLoaded,
  })

  useEffect(() => {
    load()
  }, [load])

  function getField(row, field, defaultVal = '') {
    return edits[row.id]?.[field] ?? row[field] ?? defaultVal
  }

  function setField(id, field, val) {
    setEdits((prev) => ({ ...prev, [id]: { ...prev[id], [field]: val } }))
  }

  function addRow() {
    const tempId = `new_${Date.now()}`
    setEvents((prev) => [
      {
        id: tempId,
        city: filterCity !== 'Todas' ? filterCity : dbCities[0] || 'Lima',
        event_date: todayStr(),
        event_type: 'otro',
        description: '',
        impact: 'medio',
        user_email: userEmail,
        _isNew: true,
      },
      ...prev,
    ])
  }

  async function handleSave(row) {
    setSaving(true)
    const merged = { ...row, ...edits[row.id] }
    if (!merged.description?.trim()) {
      toast.warn(t('market_events.err_empty_description'))
      setSaving(false)
      return
    }
    const payload = {
      city: merged.city,
      country,
      event_date: merged.event_date,
      event_type: merged.event_type,
      description: merged.description,
      impact: merged.impact,
      user_email: userEmail,
    }
    let err
    if (String(row.id).startsWith('new_')) {
      ;({ error: err } = await insertMarketEvent(payload))
    } else {
      ;({ error: err } = await updateMarketEvent(row.id, payload))
    }
    if (!err) {
      toast.ok(t('market_events.saved_toast'))
      await load()
    } else {
      toast.err(t('market_events.save_error', { msg: err.message }))
    }
    setSaving(false)
  }

  async function handleDelete(id) {
    if (String(id).startsWith('new_')) {
      setEvents((prev) => prev.filter((e) => e.id !== id))
      return
    }
    const ok = await confirm({
      title: t('market_events.delete_confirm_title'),
      message: t('market_events.delete_confirm_message'),
      danger: true,
      confirmText: t('app.delete'),
    })
    if (!ok) return
    const { error } = await deleteMarketEvent(id)
    if (error) toast.err(t('market_events.delete_error', { msg: error.message }))
    else {
      toast.ok(t('market_events.deleted_toast'))
      await load()
    }
  }

  return (
    <div className="mevt-page">
      <h1>{t('market_events.title')}</h1>
      <p className="mevt-page__desc">{t('market_events.desc')}</p>

      {/* ── Filters ── */}
      <div className="mevt-filters">
        <label className="mevt-ctrl">
          <span className="mevt-ctrl__label">{t('filter.city')}</span>
          <select value={filterCity} onChange={(e) => setFilterCity(e.target.value)}>
            <option value="Todas">{t('access.all')}</option>
            {uiCities.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>

        <label className="mevt-ctrl">
          <span className="mevt-ctrl__label">{t('filter.from')}</span>
          <input type="date" value={filterFrom} onChange={(e) => setFilterFrom(e.target.value)} />
        </label>

        <label className="mevt-ctrl">
          <span className="mevt-ctrl__label">{t('filter.to')}</span>
          <input type="date" value={filterTo} onChange={(e) => setFilterTo(e.target.value)} />
        </label>

        <Button size="sm" className="ml-auto" onClick={addRow}>
          {t('market_events.add_event')}
        </Button>
      </div>

      {/* ── Table ── */}
      <div className="mevt-section">
        <div className="mevt-section__header">
          <span className="mevt-section__title">
            {t('market_events.count', {
              n: events.filter((e) => !e._isNew).length,
              count: events.filter((e) => !e._isNew).length,
            })}
          </span>
        </div>

        {loading ? (
          <SkeletonTable rows={5} cols={7} />
        ) : events.length === 0 ? (
          <EmptyState
            icon="📅"
            title={t('market_events.empty_title')}
            message={t('market_events.empty_message')}
          />
        ) : (
          <div className="mevt-table-wrap">
            <table className="mevt-table">
              <thead>
                <tr>
                  <th>{t('filter.city')}</th>
                  <th>{t('dataentry.date')}</th>
                  <th>{t('market_events.col_type')}</th>
                  <th style={{ minWidth: 220 }}>{t('market_events.col_description')}</th>
                  <th>{t('dashboard.chart.impact')}</th>
                  <th>{t('dataentry.col_user')}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {events.map((row) => (
                  <tr key={row.id} className={row._isNew ? 'mevt-row-new' : ''}>
                    <td>
                      <select
                        className="mevt-input"
                        value={getField(row, 'city', 'Lima')}
                        onChange={(e) => setField(row.id, 'city', e.target.value)}
                        style={{ width: 100 }}
                      >
                        {dbCities.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        type="date"
                        className="mevt-input"
                        value={getField(row, 'event_date', todayStr())}
                        onChange={(e) => setField(row.id, 'event_date', e.target.value)}
                      />
                    </td>
                    <td>
                      <select
                        className="mevt-input"
                        value={getField(row, 'event_type', 'otro')}
                        onChange={(e) => setField(row.id, 'event_type', e.target.value)}
                      >
                        {EVENT_TYPES.map((et) => (
                          <option key={et.value} value={et.value}>
                            {t(et.labelKey)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        type="text"
                        className="mevt-input"
                        value={getField(row, 'description', '')}
                        onChange={(e) => setField(row.id, 'description', e.target.value)}
                        placeholder={t('market_events.description_placeholder')}
                        style={{ width: '100%', minWidth: 200 }}
                      />
                    </td>
                    <td>
                      <select
                        className="mevt-input"
                        value={getField(row, 'impact', 'medio')}
                        onChange={(e) => setField(row.id, 'impact', e.target.value)}
                        style={{ width: 80 }}
                      >
                        {IMPACT_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {t(o.labelKey)}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td style={{ color: 'var(--color-muted)', fontSize: 11 }}>
                      {row.user_email || userEmail || '—'}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <Button size="sm" onClick={() => handleSave(row)} disabled={saving}>
                          {t('app.save')}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="border-red-300 text-red-600 hover:bg-red-100"
                          onClick={() => handleDelete(row.id)}
                        >
                          ✕
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
