import { useState, useEffect, useMemo } from 'react'
import { sb } from '../lib/supabase'
import { COMPETITOR_COLORS, BRACKETS, BRACKET_LABELS } from '../lib/constants'
import { useRushHourConfig } from '../hooks/useRushHourConfig'
import '../styles/data-entry.css'

// ── Competidores por ciudad+categoría DB ──────────────────
const COMPETITORS_BY = {
  Lima: {
    Premier:  ['Yango', 'YangoPremier', 'Uber', 'Cabify'],
    Economy:  ['Yango', 'Uber', 'Didi', 'InDrive', 'Cabify'],
    Comfort:  ['Yango', 'Uber', 'InDrive', 'Cabify'],
    TukTuk:   ['Yango', 'Uber'],
    XL:       ['Yango', 'Uber', 'Didi', 'InDrive', 'Cabify'],
  },
  Trujillo: {
    Economy:  ['Yango', 'Uber', 'InDrive', 'Cabify'],
    Comfort:  ['Yango', 'YangoComfort+', 'Uber', 'InDrive', 'Cabify'],
  },
  Arequipa: {
    Economy:  ['Yango', 'Uber', 'Didi', 'InDrive', 'Cabify'],
    Comfort:  ['Yango', 'YangoComfort+', 'Uber', 'Didi', 'InDrive', 'Cabify'],
  },
  Airport: {
    Economy:  ['Yango', 'Uber', 'Didi', 'InDrive', 'Cabify'],
    Comfort:  ['Yango', 'Uber', 'Didi', 'InDrive', 'Cabify'],
    Premier:  ['Yango', 'YangoPremier', 'Uber', 'Didi', 'InDrive', 'Cabify'],
  },
  Corp: {
    Corp: ['Yango Economy', 'Yango Comfort', 'Yango Comfort+', 'Yango Premier', 'Yango XL',
           'Cabify', 'Cabify Lite', 'Cabify Extra Comfort', 'Cabify XL'],
  },
}

// ── Mapeos ciudad ──────────────────────────────────────────
const UI_CITIES = ['Lima', 'Trujillo', 'Arequipa', 'Aeropuerto', 'Corp']

const DB_CITY_MAP = {
  Lima: 'Lima', Trujillo: 'Trujillo', Arequipa: 'Arequipa',
  Aeropuerto: 'Airport', Corp: 'Corp',
}

const CATEGORIES_BY_DB_CITY = {
  Lima:     ['Economy', 'Comfort', 'Premier', 'TukTuk', 'XL'],
  Trujillo: ['Economy', 'Comfort'],
  Arequipa: ['Economy', 'Comfort'],
  Airport:  ['Economy', 'Comfort', 'Premier'],
  Corp:     ['Corp'],
}

const TIMESLOTS = [
  { label: 'Mañana',   time: '08:00' },
  { label: 'Mediodía', time: '13:00' },
  { label: 'Tarde',    time: '18:00' },
  { label: 'Noche',    time: '21:00' },
]

// ── Helpers ────────────────────────────────────────────────
function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

function getISOYearWeek(dateStr) {
  const d = new Date(dateStr + 'T12:00:00')
  const day = d.getDay() || 7
  d.setDate(d.getDate() + 4 - day)
  const jan1 = new Date(d.getFullYear(), 0, 1)
  const week = Math.ceil(((d - jan1) / 86400000 + 1) / 7)
  return { year: d.getFullYear(), week }
}

function compBadge(comp) {
  const color = COMPETITOR_COLORS[comp]
  if (!color) return comp
  return (
    <span style={{
      background: color, color: '#fff', borderRadius: 4,
      padding: '1px 7px', fontWeight: 700, fontSize: 10,
      whiteSpace: 'nowrap',
    }}>
      {comp}
    </span>
  )
}

// ── Componente principal ───────────────────────────────────
export default function DataEntry() {
  const [uiCity,    setUiCity]    = useState('Lima')
  const [category,  setCategory]  = useState('Economy')
  const [date,      setDate]      = useState(todayStr())
  const [timeslot,  setTimeslot]  = useState(TIMESLOTS[0])
  const [surge,     setSurge]     = useState(false)
  const [refs,      setRefs]      = useState([])
  const [refsLoading, setRefsLoading] = useState(false)

  // entries[refId][competitor] = price string
  const [entries,   setEntries]   = useState({})

  const [saving,    setSaving]    = useState(false)
  const [msg,       setMsg]       = useState(null)   // { type: 'ok'|'err', text }

  const { isRushHour } = useRushHourConfig()

  const dbCity      = DB_CITY_MAP[uiCity]
  const categories  = CATEGORIES_BY_DB_CITY[dbCity] || []
  const competitors = COMPETITORS_BY[dbCity]?.[category] || []

  // Reset category when city changes
  useEffect(() => {
    const cats = CATEGORIES_BY_DB_CITY[DB_CITY_MAP[uiCity]] || []
    setCategory(cats[0] || '')
    setEntries({})
    setMsg(null)
  }, [uiCity])

  // Reset entries when category changes
  useEffect(() => {
    setEntries({})
    setMsg(null)
  }, [category])

  // Load distance_references
  useEffect(() => {
    if (!dbCity || !category) return
    setRefsLoading(true)
    sb.from('distance_references')
      .select('*')
      .eq('city', dbCity)
      .eq('category', category)
      .order('bracket')
      .order('point_a')
      .then(({ data }) => {
        setRefs(data || [])
        setRefsLoading(false)
      })
  }, [dbCity, category])

  // Group refs by bracket
  const refsByBracket = useMemo(() => {
    const groups = {}
    for (const b of BRACKETS) {
      const rows = refs.filter(r => r.bracket === b)
      if (rows.length) groups[b] = rows
    }
    return groups
  }, [refs])

  function setEntry(refId, comp, val) {
    setEntries(prev => ({
      ...prev,
      [refId]: { ...prev[refId], [comp]: val },
    }))
  }

  function getEntry(refId, comp) {
    return entries[refId]?.[comp] ?? ''
  }

  const filledCount = useMemo(() => {
    let n = 0
    for (const refId of Object.keys(entries)) {
      for (const comp of Object.keys(entries[refId])) {
        const v = entries[refId][comp]
        if (v !== '' && !isNaN(parseFloat(v))) n++
      }
    }
    return n
  }, [entries])

  async function handleSave() {
    if (filledCount === 0) {
      setMsg({ type: 'err', text: 'No hay precios ingresados. Llena al menos un campo.' })
      return
    }
    setSaving(true)
    setMsg(null)

    const { year, week } = getISOYearWeek(date)
    const rush = isRushHour(timeslot.time, dbCity) ?? false
    const rows = []

    for (const ref of refs) {
      for (const comp of competitors) {
        const raw = getEntry(ref.id, comp)
        const price = parseFloat(raw)
        if (!raw || isNaN(price)) continue

        rows.push({
          city:                  dbCity,
          category,
          competition_name:      comp,
          observed_date:         date,
          observed_time:         timeslot.time,
          rush_hour:             rush,
          surge,
          distance_bracket:      ref.bracket,
          distance_km:           ref.waze_distance ?? null,
          point_a:               ref.point_a ?? null,
          point_b:               ref.point_b ?? null,
          price_without_discount: price,
          year,
          week,
          data_source:           'manual',
        })
      }
    }

    // Delete existing rows for this exact session before inserting
    const { error: delErr } = await sb
      .from('pricing_observations')
      .delete()
      .eq('city',         dbCity)
      .eq('category',     category)
      .eq('observed_date', date)
      .eq('observed_time', timeslot.time)
      .eq('data_source',  'manual')

    if (delErr) {
      setMsg({ type: 'err', text: `Error al limpiar: ${delErr.message}` })
      setSaving(false)
      return
    }

    // Insert in batches of 200
    const BATCH = 200
    for (let i = 0; i < rows.length; i += BATCH) {
      const { error: insErr } = await sb
        .from('pricing_observations')
        .insert(rows.slice(i, i + BATCH))
      if (insErr) {
        setMsg({ type: 'err', text: `Error al insertar: ${insErr.message}` })
        setSaving(false)
        return
      }
    }

    setMsg({ type: 'ok', text: `✓ ${rows.length} registros guardados (${uiCity} · ${category} · ${date} · ${timeslot.label})` })
    setSaving(false)
  }

  // ── Render ───────────────────────────────────────────────
  return (
    <div className="de-page">
      <h1>Ingresar CI</h1>

      {/* Session header */}
      <div className="de-session-bar">
        {/* City tabs */}
        <div className="de-city-tabs">
          {UI_CITIES.map(c => (
            <button
              key={c}
              className={`de-city-tab${uiCity === c ? ' active' : ''}`}
              onClick={() => setUiCity(c)}
            >
              {c}
            </button>
          ))}
        </div>

        <div className="de-session-controls">
          <label className="de-ctrl">
            <span>Categoría</span>
            <select value={category} onChange={e => setCategory(e.target.value)}>
              {categories.map(c => <option key={c}>{c}</option>)}
            </select>
          </label>

          <label className="de-ctrl">
            <span>Fecha</span>
            <input type="date" value={date} onChange={e => setDate(e.target.value)} />
          </label>

          <label className="de-ctrl">
            <span>Timeslot</span>
            <select
              value={timeslot.label}
              onChange={e => setTimeslot(TIMESLOTS.find(t => t.label === e.target.value))}
            >
              {TIMESLOTS.map(t => (
                <option key={t.label} value={t.label}>{t.label} ({t.time})</option>
              ))}
            </select>
          </label>

          <label className="de-ctrl de-ctrl--surge">
            <input
              type="checkbox"
              checked={surge}
              onChange={e => setSurge(e.target.checked)}
            />
            <span>Surge</span>
          </label>

          <button
            className="de-btn-save"
            onClick={handleSave}
            disabled={saving || filledCount === 0}
          >
            {saving ? 'Guardando…' : `Guardar sesión${filledCount > 0 ? ` (${filledCount})` : ''}`}
          </button>
        </div>
      </div>

      {/* Status message */}
      {msg && (
        <div className={`de-msg${msg.type === 'ok' ? ' de-msg--ok' : ' de-msg--err'}`}>
          {msg.text}
        </div>
      )}

      {/* Rush hour indicator */}
      {date && timeslot && (
        <div className="de-rush-indicator">
          {isRushHour(timeslot.time, dbCity)
            ? <span className="de-rush-badge de-rush-badge--yes">🚦 Rush Hour</span>
            : <span className="de-rush-badge de-rush-badge--no">🟢 No Rush</span>
          }
          <span className="de-session-summary">
            {uiCity} · {category} · {date} · {timeslot.label} ({timeslot.time})
            {surge && ' · 🌊 Surge'}
          </span>
        </div>
      )}

      {/* Grilla */}
      {refsLoading ? (
        <div className="de-loading">Cargando rutas…</div>
      ) : refs.length === 0 ? (
        <div className="de-empty">
          No hay rutas configuradas para <strong>{uiCity} · {category}</strong>.
          Ve a <strong>📍 Distancias Ref.</strong> para agregar las rutas primero.
        </div>
      ) : competitors.length === 0 ? (
        <div className="de-empty">
          No hay competidores configurados para esta ciudad/categoría.
        </div>
      ) : (
        <div className="de-table-wrap">
          <table className="de-table">
            <thead>
              <tr>
                <th className="de-th-bracket">Bracket</th>
                <th className="de-th-route">Punto A</th>
                <th className="de-th-route">Punto B</th>
                <th className="de-th-km">km</th>
                {competitors.map(comp => (
                  <th key={comp} className="de-th-price">
                    {compBadge(comp)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {BRACKETS.filter(b => refsByBracket[b]).map(bracket => (
                refsByBracket[bracket].map((ref, rowIdx) => (
                  <tr key={ref.id} className={rowIdx % 2 === 0 ? 'de-row-even' : 'de-row-odd'}>
                    {rowIdx === 0 && (
                      <td
                        rowSpan={refsByBracket[bracket].length}
                        className="de-td-bracket"
                      >
                        {BRACKET_LABELS[bracket]}
                      </td>
                    )}
                    <td className="de-td-route">{ref.point_a || '—'}</td>
                    <td className="de-td-route">{ref.point_b || '—'}</td>
                    <td className="de-td-km">{ref.waze_distance != null ? ref.waze_distance : '—'}</td>
                    {competitors.map(comp => (
                      <td key={comp} className="de-td-price">
                        <input
                          type="number"
                          className="de-price-input"
                          placeholder="—"
                          min="0"
                          step="0.01"
                          value={getEntry(ref.id, comp)}
                          onChange={e => setEntry(ref.id, comp, e.target.value)}
                        />
                      </td>
                    ))}
                  </tr>
                ))
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Footer save button (repeated for convenience on long tables) */}
      {refs.length > 4 && (
        <div className="de-footer">
          <button
            className="de-btn-save"
            onClick={handleSave}
            disabled={saving || filledCount === 0}
          >
            {saving ? 'Guardando…' : `Guardar sesión${filledCount > 0 ? ` (${filledCount})` : ''}`}
          </button>
          {msg && (
            <span className={msg.type === 'ok' ? 'de-footer-ok' : 'de-footer-err'}>
              {msg.text}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
