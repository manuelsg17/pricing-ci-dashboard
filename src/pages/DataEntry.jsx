import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { sb }               from '../lib/supabase'
import { useAuth }          from '../lib/auth'
import { BRACKETS, BRACKET_LABELS, COMPETITOR_COLORS } from '../lib/constants'
import { useRushHourConfig } from '../hooks/useRushHourConfig'
import { useCITimeslots }    from '../hooks/useCITimeslots'
import '../styles/data-entry.css'

// ── Mapeos ciudad ──────────────────────────────────────────────────────────
const UI_CITIES = ['Lima', 'Trujillo', 'Arequipa', 'Aeropuerto', 'Corp']

const DB_CITY_MAP = {
  Lima: 'Lima', Trujillo: 'Trujillo', Arequipa: 'Arequipa',
  Aeropuerto: 'Airport', Corp: 'Corp',
}

// Categorías tal como las ve el hub expert (NUNCA nombres internos de BD)
const CATEGORIES_BY_DB_CITY = {
  Lima:     ['Economy', 'Comfort', 'Comfort+/Premier', 'TukTuk', 'XL'],
  Trujillo: ['Economy', 'Comfort/Comfort+'],
  Arequipa: ['Economy', 'Comfort/Comfort+'],
  Airport:  ['Economy', 'Comfort', 'Comfort+/Premier'],
  Corp:     ['Corp'],
}

// Nombre UI → nombre en BD (para INSERT)
const UI_CAT_TO_DB = {
  'Economy':          'Economy',
  'Comfort':          'Comfort',
  'Comfort+/Premier': 'Premier',
  'Comfort/Comfort+': 'Comfort',
  'TukTuk':           'TukTuk',
  'XL':               'XL',
  'Corp':             'Corp',
}

// Nombre BD → nombre UI (para agrupar refs cargadas de BD)
const DB_CAT_TO_UI = {
  Lima:     { Economy:'Economy', Comfort:'Comfort', Premier:'Comfort+/Premier', TukTuk:'TukTuk', XL:'XL' },
  Trujillo: { Economy:'Economy', Comfort:'Comfort/Comfort+' },
  Arequipa: { Economy:'Economy', Comfort:'Comfort/Comfort+' },
  Airport:  { Economy:'Economy', Comfort:'Comfort', Premier:'Comfort+/Premier' },
  Corp:     { Corp:'Corp' },
}

// Competidores por ciudad + categoría UI
const COMPETITORS_BY = {
  Lima: {
    'Economy':          ['Yango', 'Uber', 'Didi', 'InDrive', 'Cabify'],
    'Comfort':          ['Yango', 'Uber', 'InDrive', 'Cabify'],
    'Comfort+/Premier': ['Yango', 'YangoPremier', 'Uber', 'Didi', 'InDrive', 'Cabify'],
    'TukTuk':           ['Yango', 'Uber', 'InDrive'],
    'XL':               ['Yango', 'Uber', 'Didi', 'InDrive', 'Cabify'],
  },
  Trujillo: {
    'Economy':         ['Yango', 'Uber', 'InDrive', 'Cabify'],
    'Comfort/Comfort+':['Yango', 'YangoComfort+', 'Uber', 'InDrive', 'Cabify'],
  },
  Arequipa: {
    'Economy':         ['Yango', 'Uber', 'Didi', 'InDrive', 'Cabify'],
    'Comfort/Comfort+':['Yango', 'YangoComfort+', 'Uber', 'Didi', 'InDrive', 'Cabify'],
  },
  Airport: {
    'Economy':          ['Yango', 'Uber', 'Didi', 'InDrive', 'Cabify'],
    'Comfort':          ['Yango', 'Uber', 'Didi', 'InDrive', 'Cabify'],
    'Comfort+/Premier': ['Yango', 'YangoPremier', 'Uber', 'Didi', 'InDrive', 'Cabify'],
  },
  Corp: {
    'Corp': ['Yango Economy', 'Yango Comfort', 'Yango Comfort+', 'Yango Premier', 'Yango XL',
             'Cabify', 'Cabify Lite', 'Cabify Extra Comfort', 'Cabify XL'],
  },
}

// Colores de sección por categoría
const CAT_COLORS = {
  'Economy':          { bg:'#eff6ff', border:'#93c5fd', text:'#1d4ed8', accent:'#3b82f6' },
  'Comfort':          { bg:'#f0fdf4', border:'#86efac', text:'#15803d', accent:'#22c55e' },
  'Comfort/Comfort+': { bg:'#f0fdf4', border:'#86efac', text:'#15803d', accent:'#22c55e' },
  'Comfort+/Premier': { bg:'#fffbeb', border:'#fcd34d', text:'#b45309', accent:'#f59e0b' },
  'TukTuk':           { bg:'#fdf4ff', border:'#e879f9', text:'#86198f', accent:'#d946ef' },
  'XL':               { bg:'#fff7ed', border:'#fdba74', text:'#c2410c', accent:'#f97316' },
  'Corp':             { bg:'#f8fafc', border:'#cbd5e1', text:'#334155', accent:'#64748b' },
}

// ── Helpers ────────────────────────────────────────────────────────────────
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

function fmtElapsed(ms) {
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
}

function calcIndriveAvg(bids, minBid) {
  const nums = bids.map(b => parseFloat(b)).filter(n => !isNaN(n) && n > 0)
  if (minBid) {
    const mn = parseFloat(minBid)
    if (!isNaN(mn) && mn > 0) nums.push(mn)
  }
  if (!nums.length) return ''
  return (nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(2)
}

function compBadge(comp) {
  const color = COMPETITOR_COLORS[comp]
  if (!color) return <span className="de-comp-name">{comp}</span>
  return (
    <span style={{
      background: color, color: '#fff', borderRadius: 4,
      padding: '2px 8px', fontWeight: 700, fontSize: 10,
      whiteSpace: 'nowrap', display: 'inline-block',
    }}>
      {comp}
    </span>
  )
}

// ── InDrive cell component ─────────────────────────────────────────────────
function InDriveCell({ avg, extra, onChange, hasError }) {
  const [open, setOpen] = useState(false)
  const bids   = extra?.bids   || ['']
  const minBid = extra?.minBid || ''

  function updateBid(i, val) {
    const newBids = [...bids]
    newBids[i] = val
    const newAvg = calcIndriveAvg(newBids, minBid)
    onChange({ bids: newBids, minBid }, newAvg)
  }

  function updateMin(val) {
    const newAvg = calcIndriveAvg(bids, val)
    onChange({ bids, minBid: val }, newAvg)
  }

  function addBid() {
    if (bids.length >= 5) return
    const newBids = [...bids, '']
    onChange({ bids: newBids, minBid }, calcIndriveAvg(newBids, minBid))
  }

  function removeBid(i) {
    if (bids.length <= 1) return
    const newBids = bids.filter((_, j) => j !== i)
    onChange({ bids: newBids, minBid }, calcIndriveAvg(newBids, minBid))
  }

  return (
    <div className={`indrive-cell${hasError ? ' indrive-cell--error' : ''}`}>
      <div className="indrive-cell__row">
        <input
          className="de-price-input indrive-avg"
          type="number"
          value={avg}
          readOnly
          placeholder="Promedio"
          title="Promedio calculado automáticamente"
          style={{ background: avg ? '#f0fdf4' : undefined, cursor: 'default' }}
        />
        <button
          className="indrive-toggle"
          onClick={() => setOpen(o => !o)}
          title={open ? 'Cerrar bids' : 'Agregar bids'}
        >
          {open ? '▲' : '▼'}
        </button>
      </div>

      {open && (
        <div className="indrive-bids-panel">
          <div className="indrive-bid-row">
            <span className="indrive-bid-label">Mín</span>
            <input
              type="number"
              className="indrive-bid-input"
              placeholder="0.00"
              value={minBid}
              min="0"
              step="0.01"
              onChange={e => updateMin(e.target.value)}
            />
          </div>
          {bids.map((b, i) => (
            <div key={i} className="indrive-bid-row">
              <span className="indrive-bid-label">Bid {i + 1}</span>
              <input
                type="number"
                className="indrive-bid-input"
                placeholder="0.00"
                value={b}
                min="0"
                step="0.01"
                onChange={e => updateBid(i, e.target.value)}
              />
              {bids.length > 1 && (
                <button className="indrive-bid-remove" onClick={() => removeBid(i)}>✕</button>
              )}
            </div>
          ))}
          {bids.length < 5 && (
            <button className="indrive-bid-add" onClick={addBid}>+ Bid</button>
          )}
        </div>
      )}
    </div>
  )
}

// ── Componente principal ───────────────────────────────────────────────────
export default function DataEntry() {
  const { session }    = useAuth()
  const userEmail      = session?.user?.email || ''

  const [uiCity,   setUiCity]   = useState('Lima')
  const [date,     setDate]     = useState(todayStr())
  const [surge,    setSurge]    = useState(false)
  const [refs,     setRefs]     = useState([])
  const [refsLoading, setRefsLoading] = useState(false)

  // entries: key = `${uiCat}|${refId}|${tsLabel}|${comp}` → price string
  const [entries,  setEntries]  = useState({})
  // indriveExtra: key = `${uiCat}|${refId}|${tsLabel}` → { bids, minBid }
  const [indriveExtra, setIndriveExtra] = useState({})
  // errorKeys: Set of price keys with error
  const [errorKeys,    setErrorKeys]    = useState(new Set())

  const [saving,   setSaving]   = useState(false)
  const [msg,      setMsg]      = useState(null)

  // Timer
  const sessionStartRef = useRef(Date.now())
  const [elapsed,  setElapsed]  = useState('00:00')

  const { isRushHour }  = useRushHourConfig()
  const { timeslots }   = useCITimeslots()

  const dbCity     = DB_CITY_MAP[uiCity]
  const categories = CATEGORIES_BY_DB_CITY[dbCity] || []

  // ── Timer ──────────────────────────────────────────────
  useEffect(() => {
    sessionStartRef.current = Date.now()
    const id = setInterval(() => {
      setElapsed(fmtElapsed(Date.now() - sessionStartRef.current))
    }, 1000)
    return () => clearInterval(id)
  }, [uiCity, date]) // reset timer cuando cambia ciudad o fecha

  // ── Load refs ──────────────────────────────────────────
  useEffect(() => {
    if (!dbCity) return
    setRefsLoading(true)
    setEntries({})
    setIndriveExtra({})
    setErrorKeys(new Set())
    setMsg(null)
    sb.from('distance_references')
      .select('*')
      .eq('city', dbCity)
      .order('category').order('bracket').order('point_a')
      .then(({ data }) => {
        setRefs(data || [])
        setRefsLoading(false)
      })
  }, [dbCity])

  // ── Reset on date change ───────────────────────────────
  useEffect(() => {
    setEntries({})
    setIndriveExtra({})
    setErrorKeys(new Set())
    setMsg(null)
  }, [date])

  // ── Group refs by UI category + bracket ───────────────
  const refsByUICat = useMemo(() => {
    const catMap = DB_CAT_TO_UI[dbCity] || {}
    const result = {}
    for (const cat of categories) result[cat] = []
    for (const ref of refs) {
      const uiCat = catMap[ref.category]
      if (uiCat && result[uiCat]) result[uiCat].push(ref)
    }
    return result
  }, [refs, dbCity, categories])

  // ── Entry helpers ──────────────────────────────────────
  const priceKey = (uiCat, refId, tsLabel, comp) => `${uiCat}|${refId}|${tsLabel}|${comp}`
  const indKey   = (uiCat, refId, tsLabel)       => `${uiCat}|${refId}|${tsLabel}`

  const setEntry = useCallback((uiCat, refId, tsLabel, comp, val) => {
    setEntries(prev => ({ ...prev, [priceKey(uiCat, refId, tsLabel, comp)]: val }))
    // clear error on edit
    setErrorKeys(prev => {
      const n = new Set(prev)
      n.delete(priceKey(uiCat, refId, tsLabel, comp))
      return n
    })
  }, [])

  const getEntry = (uiCat, refId, tsLabel, comp) =>
    entries[priceKey(uiCat, refId, tsLabel, comp)] ?? ''

  const setIndrive = useCallback((uiCat, refId, tsLabel, extra, avg) => {
    setIndriveExtra(prev => ({ ...prev, [indKey(uiCat, refId, tsLabel)]: extra }))
    setEntries(prev => ({ ...prev, [priceKey(uiCat, refId, tsLabel, 'InDrive')]: avg }))
    setErrorKeys(prev => {
      const n = new Set(prev)
      n.delete(priceKey(uiCat, refId, tsLabel, 'InDrive'))
      return n
    })
  }, [])

  // ── Row validation ─────────────────────────────────────
  // Returns 'empty' | 'full' | 'partial' for a (uiCat, ref, ts) row
  function rowState(uiCat, ref, ts) {
    const comps = COMPETITORS_BY[dbCity]?.[uiCat] || []
    const vals  = comps.map(c => entries[priceKey(uiCat, ref.id, ts.label, c)] ?? '')
    const filled = vals.filter(v => v !== '' && !isNaN(parseFloat(v)))
    if (filled.length === 0)          return 'empty'
    if (filled.length === comps.length) return 'full'
    return 'partial'
  }

  // ── Count filled ───────────────────────────────────────
  const filledCount = useMemo(() => {
    return Object.values(entries).filter(v => v !== '' && !isNaN(parseFloat(v))).length
  }, [entries])

  // ── Build rows to insert ───────────────────────────────
  function buildRows(uiCat, ref, ts) {
    const comps = COMPETITORS_BY[dbCity]?.[uiCat] || []
    const { year, week } = getISOYearWeek(date)
    const rush = isRushHour(ts.start_time?.slice(0, 5), dbCity) ?? false
    return comps.map(comp => {
      const raw = entries[priceKey(uiCat, ref.id, ts.label, comp)] ?? ''
      const price = parseFloat(raw)
      const extra = indriveExtra[indKey(uiCat, ref.id, ts.label)]
      const bids  = comp === 'InDrive' ? (extra?.bids || []) : []
      const minBid = comp === 'InDrive' ? (extra?.minBid || null) : null
      return {
        price: isNaN(price) ? null : price,
        comp, ref, ts, uiCat, rush, year, week, bids, minBid,
      }
    }).filter(r => r.price !== null)
  }

  function buildInsertPayload(r) {
    const base = {
      city:                   dbCity,
      category:               UI_CAT_TO_DB[r.uiCat] || r.uiCat,
      competition_name:       r.comp,
      observed_date:          date,
      observed_time:          r.ts.start_time?.slice(0, 5),
      rush_hour:              r.rush,
      surge,
      distance_bracket:       r.ref.bracket,
      distance_km:            r.ref.waze_distance ?? null,
      point_a:                r.ref.point_a ?? null,
      point_b:                r.ref.point_b ?? null,
      price_without_discount: r.price,
      year:                   r.year,
      week:                   r.week,
      data_source:            'manual',
    }
    if (r.comp === 'InDrive') {
      r.bids.forEach((b, i) => {
        const n = parseFloat(b)
        if (!isNaN(n)) base[`bid_${i+1}`] = n
      })
      const mn = parseFloat(r.minBid)
      if (!isNaN(mn)) base.minimal_bid = mn
    }
    return base
  }

  // ── Validate rows & collect errors ─────────────────────
  function validateAndCollectErrors(requireAllFull = false) {
    const newErrors = new Set()
    let hasPartial = false
    let hasEmpty   = false

    for (const uiCat of categories) {
      const catRefs = refsByUICat[uiCat] || []
      const comps   = COMPETITORS_BY[dbCity]?.[uiCat] || []
      for (const ref of catRefs) {
        for (const ts of timeslots) {
          const state = rowState(uiCat, ref, ts)
          if (state === 'partial') {
            hasPartial = true
            // mark missing cells
            comps.forEach(comp => {
              const v = entries[priceKey(uiCat, ref.id, ts.label, comp)] ?? ''
              if (v === '' || isNaN(parseFloat(v))) {
                newErrors.add(priceKey(uiCat, ref.id, ts.label, comp))
              }
            })
          }
          if (state === 'empty' && requireAllFull) {
            hasEmpty = true
            comps.forEach(comp => {
              newErrors.add(priceKey(uiCat, ref.id, ts.label, comp))
            })
          }
        }
      }
    }
    setErrorKeys(newErrors)
    return { hasPartial, hasEmpty, errorCount: newErrors.size }
  }

  // ── Save shared logic ──────────────────────────────────
  async function performSave(rowsToInsert, isFinish = false) {
    setSaving(true); setMsg(null)

    // Group by (dbCat, ts) for targeted delete
    const combos = new Set(
      rowsToInsert.map(r => `${UI_CAT_TO_DB[r.uiCat] || r.uiCat}|${r.ts.start_time?.slice(0, 5)}`)
    )
    for (const combo of combos) {
      const [cat, time] = combo.split('|')
      const { error: delErr } = await sb.from('pricing_observations')
        .delete()
        .eq('city',         dbCity)
        .eq('category',     cat)
        .eq('observed_date', date)
        .eq('observed_time', time)
        .eq('data_source',  'manual')
      if (delErr) {
        setMsg({ type: 'err', text: `Error al limpiar: ${delErr.message}` })
        setSaving(false); return false
      }
    }

    const payloads = rowsToInsert.map(buildInsertPayload)
    const BATCH = 200
    for (let i = 0; i < payloads.length; i += BATCH) {
      const { error: insErr } = await sb.from('pricing_observations').insert(payloads.slice(i, i + BATCH))
      if (insErr) {
        setMsg({ type: 'err', text: `Error al insertar: ${insErr.message}` })
        setSaving(false); return false
      }
    }

    if (isFinish) {
      const now    = new Date()
      const dur    = Math.round((now - new Date(sessionStartRef.current)) / 60000 * 10) / 10
      await sb.from('ci_sessions').insert({
        city:             dbCity,
        observed_date:    date,
        user_email:       userEmail,
        started_at:       new Date(sessionStartRef.current).toISOString(),
        ended_at:         now.toISOString(),
        duration_minutes: dur,
        rows_saved:       payloads.length,
      })
      setMsg({ type: 'ok', text: `✓ Sesión completada en ${dur} min. ${payloads.length} registros guardados.` })
    } else {
      setMsg({ type: 'ok', text: `✓ ${payloads.length} registros guardados. Puedes seguir completando.` })
    }

    setSaving(false)
    return true
  }

  // ── Guardar progreso ───────────────────────────────────
  async function handleSaveProgress() {
    const { hasPartial } = validateAndCollectErrors(false)
    if (hasPartial) {
      setMsg({ type: 'err', text: 'Hay filas incompletas (marcadas en rojo). Completa todas las casillas de esa fila o déjala completamente vacía.' })
      return
    }
    // Collect all full rows
    const rowsToInsert = []
    for (const uiCat of categories) {
      for (const ref of (refsByUICat[uiCat] || [])) {
        for (const ts of timeslots) {
          if (rowState(uiCat, ref, ts) === 'full') {
            rowsToInsert.push(...buildRows(uiCat, ref, ts))
          }
        }
      }
    }
    if (!rowsToInsert.length) {
      setMsg({ type: 'err', text: 'No hay filas completamente llenas para guardar.' }); return
    }
    await performSave(rowsToInsert, false)
  }

  // ── Terminar sesión ────────────────────────────────────
  async function handleFinishSession() {
    const { hasPartial, hasEmpty } = validateAndCollectErrors(true)
    if (hasPartial || hasEmpty) {
      const detail = []
      if (hasPartial) detail.push('filas incompletas')
      if (hasEmpty)   detail.push('filas completamente vacías')
      setMsg({ type: 'err', text: `Para terminar la sesión, todas las filas deben estar llenas. Hay ${detail.join(' y ')}.` })
      return
    }
    const rowsToInsert = []
    for (const uiCat of categories) {
      for (const ref of (refsByUICat[uiCat] || [])) {
        for (const ts of timeslots) {
          rowsToInsert.push(...buildRows(uiCat, ref, ts))
        }
      }
    }
    await performSave(rowsToInsert, true)
  }

  // ── Total expected rows ────────────────────────────────
  const totalExpected = useMemo(() => {
    let n = 0
    for (const uiCat of categories) {
      const catRefs = refsByUICat[uiCat] || []
      const comps   = COMPETITORS_BY[dbCity]?.[uiCat] || []
      n += catRefs.length * timeslots.length * comps.length
    }
    return n
  }, [refsByUICat, categories, timeslots, dbCity])

  // ── Render ─────────────────────────────────────────────
  return (
    <div className="de-page">
      {/* ── Header ── */}
      <div className="de-header">
        <div className="de-header__left">
          <h1>Ingresar CI</h1>
          <div className="de-timer" title="Tiempo de sesión">{elapsed}</div>
        </div>
        <div className="de-header__actions">
          <button
            className="de-btn-save"
            onClick={handleSaveProgress}
            disabled={saving || filledCount === 0}
          >
            {saving ? 'Guardando…' : `💾 Guardar progreso${filledCount > 0 ? ` (${filledCount})` : ''}`}
          </button>
          <button
            className="de-btn-finish"
            onClick={handleFinishSession}
            disabled={saving}
          >
            ✅ Terminar sesión
          </button>
        </div>
      </div>

      {/* ── Session bar ── */}
      <div className="de-session-bar">
        {/* City tabs */}
        <div className="de-city-tabs">
          {UI_CITIES.map(c => (
            <button
              key={c}
              className={`de-city-tab${uiCity === c ? ' active' : ''}`}
              onClick={() => { setUiCity(c); setMsg(null) }}
            >
              {c}
            </button>
          ))}
        </div>

        <div className="de-session-controls">
          <label className="de-ctrl">
            <span>Fecha</span>
            <input type="date" value={date} onChange={e => setDate(e.target.value)} />
          </label>

          <label className="de-ctrl de-ctrl--surge">
            <input
              type="checkbox"
              checked={surge}
              onChange={e => setSurge(e.target.checked)}
            />
            <span>Surge</span>
          </label>

          <div className="de-session-info">
            {timeslots.map(ts => (
              <span key={ts.label} className="de-ts-badge">
                {ts.label} ({ts.start_time?.slice(0,5)}–{ts.end_time?.slice(0,5)})
              </span>
            ))}
          </div>

          <div className="de-progress-pill">
            <span className="de-progress-filled">{filledCount}</span>
            <span className="de-progress-sep">/</span>
            <span className="de-progress-total">{totalExpected}</span>
            <span className="de-progress-label">campos</span>
          </div>
        </div>
      </div>

      {/* ── Status message ── */}
      {msg && (
        <div className={`de-msg${msg.type === 'ok' ? ' de-msg--ok' : ' de-msg--err'}`}>
          {msg.text}
        </div>
      )}

      {/* ── Grilla ── */}
      {refsLoading ? (
        <div className="de-loading">Cargando rutas…</div>
      ) : (
        <>
          {categories.map(uiCat => {
            const catRefs  = refsByUICat[uiCat] || []
            const comps    = COMPETITORS_BY[dbCity]?.[uiCat] || []
            const colors   = CAT_COLORS[uiCat] || CAT_COLORS['Corp']
            const totalRows = catRefs.length * timeslots.length

            return (
              <div key={uiCat} className="de-cat-section">
                {/* Category header */}
                <div
                  className="de-cat-header"
                  style={{ background: colors.bg, borderColor: colors.border }}
                >
                  <span className="de-cat-label" style={{ color: colors.text }}>
                    {uiCat}
                  </span>
                  <span className="de-cat-meta">
                    {catRefs.length} ruta{catRefs.length !== 1 ? 's' : ''} ×{' '}
                    {timeslots.length} timeslot{timeslots.length !== 1 ? 's' : ''} ={' '}
                    {totalRows} filas
                  </span>
                </div>

                {catRefs.length === 0 ? (
                  <div className="de-cat-empty">
                    No hay rutas para <strong>{uiCity} · {uiCat}</strong>.
                    Ve a <strong>📍 Distancias Ref.</strong> para agregarlas.
                  </div>
                ) : (
                  <div className="de-table-wrap">
                    <table className="de-table">
                      <thead>
                        <tr>
                          <th className="de-th de-th-bracket">Bracket</th>
                          <th className="de-th de-th-km">km</th>
                          <th className="de-th de-th-route">Punto A</th>
                          <th className="de-th de-th-route">Punto B</th>
                          <th className="de-th de-th-ts">Timeslot</th>
                          {comps.map(comp => (
                            <th key={comp} className="de-th de-th-price">
                              {compBadge(comp)}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {BRACKETS.filter(b => catRefs.some(r => r.bracket === b)).map(bracket => {
                          const bracketRefs = catRefs.filter(r => r.bracket === bracket)
                          return bracketRefs.map((ref, ri) =>
                            timeslots.map((ts, ti) => {
                              const state = rowState(uiCat, ref, ts)
                              const rowClass = state === 'partial' ? ' de-row-partial' : ''
                              return (
                                <tr key={`${ref.id}|${ts.label}`} className={`de-row${rowClass}`}>
                                  {/* Bracket: rowspan over all refs × timeslots in this bracket */}
                                  {ri === 0 && ti === 0 && (
                                    <td
                                      rowSpan={bracketRefs.length * timeslots.length}
                                      className="de-td-bracket"
                                    >
                                      {BRACKET_LABELS[bracket]}
                                    </td>
                                  )}
                                  {/* KM + Routes: rowspan over timeslots */}
                                  {ti === 0 && (
                                    <>
                                      <td rowSpan={timeslots.length} className="de-td-km">
                                        {ref.waze_distance != null ? ref.waze_distance : '—'}
                                      </td>
                                      <td rowSpan={timeslots.length} className="de-td-route">
                                        {ref.point_a || '—'}
                                      </td>
                                      <td rowSpan={timeslots.length} className="de-td-route">
                                        {ref.point_b || '—'}
                                      </td>
                                    </>
                                  )}
                                  {/* Timeslot */}
                                  <td className="de-td-ts">
                                    <span className="de-ts-pill">{ts.label}</span>
                                    <span className="de-ts-time">{ts.start_time?.slice(0,5)}</span>
                                  </td>
                                  {/* Price cells */}
                                  {comps.map(comp => {
                                    const key = priceKey(uiCat, ref.id, ts.label, comp)
                                    const hasErr = errorKeys.has(key)
                                    if (comp === 'InDrive') {
                                      return (
                                        <td key={comp} className={`de-td-price${hasErr ? ' de-td-error' : ''}`}>
                                          <InDriveCell
                                            avg={getEntry(uiCat, ref.id, ts.label, 'InDrive')}
                                            extra={indriveExtra[indKey(uiCat, ref.id, ts.label)]}
                                            onChange={(extra, avg) => setIndrive(uiCat, ref.id, ts.label, extra, avg)}
                                            hasError={hasErr}
                                          />
                                        </td>
                                      )
                                    }
                                    return (
                                      <td key={comp} className={`de-td-price${hasErr ? ' de-td-error' : ''}`}>
                                        <input
                                          type="number"
                                          className={`de-price-input${hasErr ? ' de-price-input--error' : ''}`}
                                          placeholder="—"
                                          min="0"
                                          step="0.01"
                                          value={getEntry(uiCat, ref.id, ts.label, comp)}
                                          onChange={e => setEntry(uiCat, ref.id, ts.label, comp, e.target.value)}
                                        />
                                      </td>
                                    )
                                  })}
                                </tr>
                              )
                            })
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )
          })}
        </>
      )}

      {/* Footer repeat buttons */}
      {!refsLoading && refs.length > 0 && (
        <div className="de-footer">
          <button
            className="de-btn-save"
            onClick={handleSaveProgress}
            disabled={saving || filledCount === 0}
          >
            {saving ? 'Guardando…' : `💾 Guardar progreso${filledCount > 0 ? ` (${filledCount})` : ''}`}
          </button>
          <button
            className="de-btn-finish"
            onClick={handleFinishSession}
            disabled={saving}
          >
            ✅ Terminar sesión
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
