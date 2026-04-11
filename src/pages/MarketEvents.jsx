import { useState, useEffect, useCallback, useMemo } from 'react'
import { sb }      from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { getCountryConfig } from '../lib/constants'
import '../styles/market-events.css'

const EVENT_TYPES = [
  { value: 'huelga',            label: 'Huelga' },
  { value: 'lluvia',            label: 'Lluvia' },
  { value: 'feriado',           label: 'Feriado' },
  { value: 'promo_competidor',  label: 'Promo competidor' },
  { value: 'regulacion',        label: 'Regulación' },
  { value: 'otro',              label: 'Otro' },
]

const IMPACT_OPTIONS = [
  { value: 'alto',  label: 'Alto' },
  { value: 'medio', label: 'Medio' },
  { value: 'bajo',  label: 'Bajo' },
]

function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

function thirtyDaysAgo() {
  const d = new Date()
  d.setDate(d.getDate() - 30)
  return d.toISOString().slice(0, 10)
}

export default function MarketEvents({ country = 'Peru' }) {
  const { session } = useAuth()
  const userEmail   = session?.user?.email || ''
  const countryConfig = useMemo(() => getCountryConfig(country), [country])
  const uiCities      = countryConfig.cities
  const dbCities      = countryConfig.dbCities

  const [filterCity,  setFilterCity]  = useState('Todas')
  const [filterFrom,  setFilterFrom]  = useState(thirtyDaysAgo())
  const [filterTo,    setFilterTo]    = useState(todayStr())

  const [events,  setEvents]  = useState([])
  const [loading, setLoading] = useState(false)
  const [saving,  setSaving]  = useState(false)
  const [msg,     setMsg]     = useState(null)

  // Local edits (for both existing and new rows)
  const [edits, setEdits] = useState({})

  const load = useCallback(async () => {
    setLoading(true)
    let q = sb
      .from('market_events')
      .select('*')
      .gte('event_date', filterFrom)
      .lte('event_date', filterTo)
      .order('event_date', { ascending: false })

    if (filterCity !== 'Todas') {
      q = q.eq('city', filterCity)
    }

    const { data } = await q
    setEvents(data || [])
    setEdits({})
    setLoading(false)
  }, [filterCity, filterFrom, filterTo])

  useEffect(() => { load() }, [load])

  function getField(row, field, defaultVal = '') {
    return edits[row.id]?.[field] ?? row[field] ?? defaultVal
  }

  function setField(id, field, val) {
    setEdits(prev => ({ ...prev, [id]: { ...prev[id], [field]: val } }))
  }

  function addRow() {
    const tempId = `new_${Date.now()}`
    setEvents(prev => [{
      id: tempId, city: filterCity !== 'Todas' ? filterCity : (dbCities[0] || 'Lima'),
      event_date: todayStr(), event_type: 'otro', description: '',
      impact: 'medio', user_email: userEmail, _isNew: true,
    }, ...prev])
  }

  async function handleSave(row) {
    setSaving(true); setMsg(null)
    const merged = { ...row, ...edits[row.id] }
    const payload = {
      city:        merged.city,
      event_date:  merged.event_date,
      event_type:  merged.event_type,
      description: merged.description,
      impact:      merged.impact,
      user_email:  userEmail,
    }
    let err
    if (String(row.id).startsWith('new_')) {
      ;({ error: err } = await sb.from('market_events').insert(payload))
    } else {
      ;({ error: err } = await sb.from('market_events').update(payload).eq('id', row.id))
    }
    if (!err) {
      setMsg({ type: 'ok', text: '✓ Evento guardado.' })
      await load()
    } else {
      setMsg({ type: 'err', text: `Error: ${err.message}` })
    }
    setSaving(false)
  }

  async function handleDelete(id) {
    if (String(id).startsWith('new_')) {
      setEvents(prev => prev.filter(e => e.id !== id))
      return
    }
    const { error } = await sb.from('market_events').delete().eq('id', id)
    if (!error) await load()
  }

  return (
    <div className="mevt-page">
      <h1>Anotaciones de Mercado</h1>
      <p className="mevt-page__desc">
        Registra eventos externos (huelgas, lluvia, feriados, promos) que puedan explicar variaciones en los precios.
        Los eventos aparecen en los gráficos del Dashboard en vista diaria.
      </p>

      {/* ── Filters ── */}
      <div className="mevt-filters">
        <label className="mevt-ctrl">
          <span className="mevt-ctrl__label">Ciudad</span>
          <select value={filterCity} onChange={e => setFilterCity(e.target.value)}>
            <option value="Todas">Todas</option>
            {uiCities.map(c => <option key={c}>{c}</option>)}
          </select>
        </label>

        <label className="mevt-ctrl">
          <span className="mevt-ctrl__label">Desde</span>
          <input type="date" value={filterFrom} onChange={e => setFilterFrom(e.target.value)} />
        </label>

        <label className="mevt-ctrl">
          <span className="mevt-ctrl__label">Hasta</span>
          <input type="date" value={filterTo} onChange={e => setFilterTo(e.target.value)} />
        </label>

        <button className="mevt-btn-add" onClick={addRow}>
          + Nuevo evento
        </button>
      </div>

      {/* ── Messages ── */}
      {msg && (
        <div className={`mevt-msg mevt-msg--${msg.type}`}>{msg.text}</div>
      )}

      {/* ── Table ── */}
      <div className="mevt-section">
        <div className="mevt-section__header">
          <span className="mevt-section__title">
            {events.filter(e => !e._isNew).length} evento{events.filter(e => !e._isNew).length !== 1 ? 's' : ''}
          </span>
        </div>

        {loading ? (
          <div className="mevt-empty">Cargando…</div>
        ) : events.length === 0 ? (
          <div className="mevt-empty">
            No hay eventos en este período. Haz clic en <strong>"+ Nuevo evento"</strong> para agregar uno.
          </div>
        ) : (
          <div className="mevt-table-wrap">
            <table className="mevt-table">
              <thead>
                <tr>
                  <th>Ciudad</th>
                  <th>Fecha</th>
                  <th>Tipo</th>
                  <th style={{ minWidth: 220 }}>Descripción</th>
                  <th>Impacto</th>
                  <th>Usuario</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {events.map(row => (
                  <tr key={row.id} className={row._isNew ? 'mevt-row-new' : ''}>
                    <td>
                      <select
                        className="mevt-input"
                        value={getField(row, 'city', 'Lima')}
                        onChange={e => setField(row.id, 'city', e.target.value)}
                        style={{ width: 100 }}
                      >
                        {dbCities.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </td>
                    <td>
                      <input
                        type="date"
                        className="mevt-input"
                        value={getField(row, 'event_date', todayStr())}
                        onChange={e => setField(row.id, 'event_date', e.target.value)}
                      />
                    </td>
                    <td>
                      <select
                        className="mevt-input"
                        value={getField(row, 'event_type', 'otro')}
                        onChange={e => setField(row.id, 'event_type', e.target.value)}
                      >
                        {EVENT_TYPES.map(t => (
                          <option key={t.value} value={t.value}>{t.label}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        type="text"
                        className="mevt-input"
                        value={getField(row, 'description', '')}
                        onChange={e => setField(row.id, 'description', e.target.value)}
                        placeholder="Describe el evento…"
                        style={{ width: '100%', minWidth: 200 }}
                      />
                    </td>
                    <td>
                      <select
                        className="mevt-input"
                        value={getField(row, 'impact', 'medio')}
                        onChange={e => setField(row.id, 'impact', e.target.value)}
                        style={{ width: 80 }}
                      >
                        {IMPACT_OPTIONS.map(o => (
                          <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                      </select>
                    </td>
                    <td style={{ color: 'var(--color-muted)', fontSize: 11 }}>
                      {row.user_email || userEmail || '—'}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button
                          className="mevt-btn-save"
                          onClick={() => handleSave(row)}
                          disabled={saving}
                        >
                          Guardar
                        </button>
                        <button
                          className="mevt-btn-del"
                          onClick={() => handleDelete(row.id)}
                        >
                          ✕
                        </button>
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
