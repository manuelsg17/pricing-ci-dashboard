import { useState, useCallback, useEffect } from 'react'
import { sb } from '../lib/supabase'
import { useRawData } from '../hooks/useRawData'
import '../styles/raw-data.css'

const DB_CATEGORIES = {
  Lima:     ['Economy', 'Comfort', 'Comfort+/Premier', 'Premier', 'TukTuk', 'XL'],
  Trujillo: ['Economy', 'Comfort/Comfort+', 'Comfort'],
  Arequipa: ['Economy', 'Comfort/Comfort+', 'Comfort'],
  Airport:  ['Economy', 'Comfort', 'Comfort+/Premier', 'Premier'],
  Corp:     ['Corp']
}

const DB_COMPETITORS = {
  Lima:     ['Yango', 'YangoPremier', 'Uber', 'Didi', 'InDrive', 'Cabify'],
  Trujillo: ['Yango', 'YangoComfort+', 'Uber', 'InDrive', 'Cabify'],
  Arequipa: ['Yango', 'YangoComfort+', 'Uber', 'Didi', 'InDrive', 'Cabify'],
  Airport:  ['Yango', 'YangoPremier', 'Uber', 'Didi', 'InDrive', 'Cabify'],
  Corp:     ['Yango Economy', 'Yango Comfort', 'Yango Comfort+', 'Yango Premier', 'Yango XL', 'Cabify', 'Cabify Lite', 'Cabify Extra Comfort', 'Cabify XL'],
}

// DB-level city labels for tabs
const CITY_TABS = [
  { db: 'Lima',      label: 'Lima' },
  { db: 'Trujillo',  label: 'Trujillo' },
  { db: 'Arequipa',  label: 'Arequipa' },
  { db: 'Airport',   label: 'Aeropuerto' },
  { db: 'Corp',      label: 'Corp' },
]

const BRACKET_OPTIONS = [
  { value: '',           label: 'Todos' },
  { value: 'very_short', label: 'Very Short' },
  { value: 'short',      label: 'Short' },
  { value: 'median',     label: 'Median' },
  { value: 'average',    label: 'Average' },
  { value: 'long',       label: 'Long' },
  { value: 'very_long',  label: 'Very Long' },
]

const SURGE_OPTIONS = [
  { value: '',      label: 'Todos' },
  { value: 'true',  label: 'Sí (surge)' },
  { value: 'false', label: 'No surge' },
]

const BRACKET_LABELS = {
  very_short: 'Very Short',
  short:      'Short',
  median:     'Median',
  average:    'Average',
  long:       'Long',
  very_long:  'Very Long',
}

function fmt(val, decimals = 2) {
  if (val === null || val === undefined || val === '') return '—'
  const n = parseFloat(val)
  return isNaN(n) ? String(val) : n.toFixed(decimals)
}

export default function RawData() {
  const getInitialState = (key, defaultVal) => {
    const saved = sessionStorage.getItem(`rawData_${key}`)
    return saved !== null ? saved : defaultVal
  }

  const [dbCity, setDbCity] = useState(getInitialState('dbCity', 'Lima'))
  const [dbCategory,  setDbCategory]  = useState(getInitialState('dbCategory', ''))
  const [competition, setCompetition] = useState(getInitialState('competition', ''))
  const [surge,       setSurge]       = useState(getInitialState('surge', ''))
  const [bracket,     setBracket]     = useState(getInitialState('bracket', ''))
  const [dateFrom,    setDateFrom]    = useState(getInitialState('dateFrom', ''))
  const [dateTo,      setDateTo]      = useState(getInitialState('dateTo', ''))
  const [searchA,     setSearchA]     = useState(getInitialState('searchA', ''))
  const [searchB,     setSearchB]     = useState(getInitialState('searchB', ''))
  const [dataSource,  setDataSource]  = useState(getInitialState('dataSource', ''))

  useEffect(() => { sessionStorage.setItem('rawData_dbCity', dbCity) }, [dbCity])
  useEffect(() => { sessionStorage.setItem('rawData_dbCategory', dbCategory) }, [dbCategory])
  useEffect(() => { sessionStorage.setItem('rawData_competition', competition) }, [competition])
  useEffect(() => { sessionStorage.setItem('rawData_surge', surge) }, [surge])
  useEffect(() => { sessionStorage.setItem('rawData_bracket', bracket) }, [bracket])
  useEffect(() => { sessionStorage.setItem('rawData_dateFrom', dateFrom) }, [dateFrom])
  useEffect(() => { sessionStorage.setItem('rawData_dateTo', dateTo) }, [dateTo])
  useEffect(() => { sessionStorage.setItem('rawData_searchA', searchA) }, [searchA])
  useEffect(() => { sessionStorage.setItem('rawData_searchB', searchB) }, [searchB])
  useEffect(() => { sessionStorage.setItem('rawData_dataSource', dataSource) }, [dataSource])

  const filters = {
    dbCity,
    dbCategory,
    competition,
    surge,
    bracket,
    dateFrom,
    dateTo,
    searchA,
    searchB,
    dataSource,
  }

  const { rows, total, page, loading, error, fetch, pageSize } = useRawData(filters)

  const [editingId, setEditingId] = useState(null)
  const [editField, setEditField] = useState(null)
  const [editValue, setEditValue] = useState('')

  const startEdit = (id, field, value) => {
    setEditingId(id)
    setEditField(field)
    setEditValue(value === null || value === undefined ? '' : value)
  }

  const handleEditKeyDown = async (e, id, field) => {
    if (e.key === 'Escape') {
      setEditingId(null)
    } else if (e.key === 'Enter') {
      const parsed = parseFloat(editValue)
      const finalVal = isNaN(parsed) ? null : parsed
      const { error: updErr } = await sb
        .from('pricing_observations')
        .update({ [field]: finalVal })
        .eq('id', id)
      
      if (!updErr) {
        rows.find(r => r.id === id)[field] = finalVal
      } else {
        alert("Error actualizando: " + updErr.message)
      }
      setEditingId(null)
    }
  }

  const renderEditable = (r, field, decimals = 2) => {
    if (editingId === r.id && editField === field) {
      return (
        <input 
          autoFocus
          type="number" 
          step="any"
          value={editValue} 
          onChange={e => setEditValue(e.target.value)} 
          onKeyDown={e => handleEditKeyDown(e, r.id, field)}
          onBlur={() => setEditingId(null)}
          style={{ width: '60px', padding: '2px' }}
        />
      )
    }
    return <span onDoubleClick={() => startEdit(r.id, field, r[field])} style={{cursor: 'pointer'}} title="Doble clic para editar">{fmt(r[field], decimals)}</span>
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  const handleCityChange = useCallback((city) => {
    setDbCity(city)
    setDbCategory('')
    setCompetition('')
    setSurge('')
    setBracket('')
    setSearchA('')
    setSearchB('')
  }, [])

  const resetFilters = () => {
    setDbCategory('')
    setCompetition('')
    setSurge('')
    setBracket('')
    setDateFrom('')
    setDateTo('')
    setSearchA('')
    setSearchB('')
    setDataSource('')
  }

  const isYangoRow = (r) =>
    r.competition_name && r.competition_name.toLowerCase().startsWith('yango')

  return (
    <div className="raw-data">

      {/* City tabs */}
      <div className="raw-data__city-tabs">
        {CITY_TABS.map(t => (
          <button
            key={t.db}
            className={`raw-data__city-tab${dbCity === t.db ? ' raw-data__city-tab--active' : ''}`}
            onClick={() => handleCityChange(t.db)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Top filter bar */}
      <div className="raw-data__filters">
        <div className="raw-data__filter-group">
          <label>Desde</label>
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
        </div>
        <div className="raw-data__filter-group">
          <label>Hasta</label>
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} />
        </div>
        <div className="raw-data__filter-group">
          <label>Categoría</label>
          <select value={dbCategory} onChange={e => setDbCategory(e.target.value)}>
            <option value="">Todos</option>
            {(DB_CATEGORIES[dbCity] || []).map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="raw-data__filter-group">
          <label>Competidor</label>
          <select value={competition} onChange={e => setCompetition(e.target.value)}>
            <option value="">Todos</option>
            {(DB_COMPETITORS[dbCity] || []).map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="raw-data__filter-group">
          <label>Surge</label>
          <select value={surge} onChange={e => setSurge(e.target.value)}>
            {SURGE_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div className="raw-data__filter-group">
          <label>Bracket</label>
          <select value={bracket} onChange={e => setBracket(e.target.value)}>
            {BRACKET_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div className="raw-data__filter-group">
          <label>Fuente</label>
          <select value={dataSource} onChange={e => setDataSource(e.target.value)}>
            <option value="">Todos</option>
            <option value="manual">Hubs (manual)</option>
            <option value="bot">Bot</option>
          </select>
        </div>
        <div className="raw-data__filter-group">
          <label>Punto A</label>
          <input
            type="text"
            value={searchA}
            onChange={e => setSearchA(e.target.value)}
            placeholder="Buscar…"
          />
        </div>
        <div className="raw-data__filter-group">
          <label>Punto B</label>
          <input
            type="text"
            value={searchB}
            onChange={e => setSearchB(e.target.value)}
            placeholder="Buscar…"
          />
        </div>
        <button className="raw-data__filter-reset" onClick={resetFilters} title="Limpiar filtros">
          ✕ Limpiar
        </button>
      </div>

      {error && <div className="raw-data__error">⚠ Error: {error}</div>}

      {/* Info + Pagination */}
      <div className="raw-data__info">
        <div className="raw-data__count">
          {loading
            ? 'Cargando…'
            : <><strong>{total.toLocaleString()}</strong> filas encontradas
              {total > 0 && <> · Mostrando {page * pageSize + 1}–{Math.min((page + 1) * pageSize, total)}</>}
            </>
          }
        </div>

        {total > pageSize && (
          <div className="raw-data__pagination">
            <button
              className="raw-data__page-btn"
              onClick={() => fetch(0)}
              disabled={page === 0 || loading}
            >«</button>
            <button
              className="raw-data__page-btn"
              onClick={() => fetch(page - 1)}
              disabled={page === 0 || loading}
            >‹</button>
            <span className="raw-data__page-label">Pág. {page + 1} / {totalPages}</span>
            <button
              className="raw-data__page-btn"
              onClick={() => fetch(page + 1)}
              disabled={page >= totalPages - 1 || loading}
            >›</button>
            <button
              className="raw-data__page-btn"
              onClick={() => fetch(totalPages - 1)}
              disabled={page >= totalPages - 1 || loading}
            >»</button>
          </div>
        )}
      </div>

      {/* Table */}
      <div className="raw-data__table-wrap">
        <table className="raw-data__table">
          <thead>
            {/* Column group headers */}
            <tr>
              <th colSpan={2} className="col-year">Tiempo</th>
              <th colSpan={2} className="col-date">Fecha / Hora</th>
              <th colSpan={2} className="col-rush">Flags</th>
              <th colSpan={2} className="col-cat">Servicio</th>
              <th className="col-source">Fuente</th>
              <th colSpan={3} className="col-bracket">Ruta</th>
              <th colSpan={2} className="col-point">Puntos</th>
              <th colSpan={4} className="col-price">Precios (S/.)</th>
              <th colSpan={5} className="col-bid">Bids InDrive</th>
              <th className="col-eta">ETA</th>
            </tr>
            {/* Column labels */}
            <tr>
              <th className="col-year">Año</th>
              <th className="col-week">Sem</th>
              <th className="col-date">Fecha</th>
              <th className="col-time">Hora</th>
              <th className="col-rush">Rush</th>
              <th className="col-surge">Surge</th>
              <th className="col-cat">Categoría</th>
              <th className="col-comp">Competidor</th>
              <th className="col-source">Fuente</th>
              <th className="col-bracket">Bracket</th>
              <th className="col-zone">Zona</th>
              <th className="col-price">Dist (km)</th>
              <th className="col-point">Punto A</th>
              <th className="col-point">Punto B</th>
              <th className="col-price">P. s/desc</th>
              <th className="col-price">P. c/desc</th>
              <th className="col-price">Recomend.</th>
              <th className="col-price">Min. Bid</th>
              <th className="col-bid">Bid 1</th>
              <th className="col-bid">Bid 2</th>
              <th className="col-bid">Bid 3</th>
              <th className="col-bid">Bid 4</th>
              <th className="col-bid">Bid 5</th>
              <th className="col-eta">ETA (min)</th>
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 && (
              <tr>
                <td colSpan={25} className="raw-data__state">Cargando datos…</td>
              </tr>
            )}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={25} className="raw-data__state">
                  No se encontraron filas con los filtros actuales.
                </td>
              </tr>
            )}
            {rows.map((r, i) => (
              <tr
                key={r.id ?? i}
                className={isYangoRow(r) ? 'raw-data__row--yango' : ''}
              >
                <td className="col-year">{r.year ?? '—'}</td>
                <td className="col-week">{r.week ?? '—'}</td>
                <td className="col-date">{r.observed_date ?? '—'}</td>
                <td className="col-time">{r.observed_time ? r.observed_time.slice(0, 5) : '—'}</td>
                <td className="col-rush">
                  {r.rush_hour === true
                    ? <span className="badge-rush">Rush</span>
                    : r.rush_hour === false
                      ? <span className="badge-no">—</span>
                      : '?'}
                </td>
                <td className="col-surge">
                  {r.surge === true
                    ? <span className="badge-surge">Sí</span>
                    : r.surge === false
                      ? <span className="badge-no">No</span>
                      : <span className="badge-no">—</span>}
                </td>
                <td className="col-cat">{r.category ?? '—'}</td>
                <td className="col-comp" style={isYangoRow(r) ? { color: 'var(--color-yango)', fontWeight: 600 } : {}}>
                  {r.competition_name ?? '—'}
                </td>
                <td className="col-source">
                  {r.data_source === 'bot'
                    ? <span className="badge-bot">Bot</span>
                    : <span className="badge-hub">Hub</span>}
                </td>
                <td className="col-bracket">
                  {r.distance_bracket
                    ? <span className="bracket-pill">{BRACKET_LABELS[r.distance_bracket] ?? r.distance_bracket}</span>
                    : <span className="badge-no">—</span>}
                </td>
                <td className="col-zone">{r.zone ?? '—'}</td>
                <td className="col-price">{fmt(r.distance_km, 1)}</td>
                <td className="col-point" title={r.point_a ?? ''}>{r.point_a ?? '—'}</td>
                <td className="col-point" title={r.point_b ?? ''}>{r.point_b ?? '—'}</td>
                <td className="col-price">{renderEditable(r, 'price_without_discount')}</td>
                <td className="col-price">{renderEditable(r, 'price_with_discount')}</td>
                <td className="col-price">{renderEditable(r, 'recommended_price')}</td>
                <td className="col-price">{renderEditable(r, 'minimal_bid')}</td>
                <td className="col-bid">{renderEditable(r, 'bid_1')}</td>
                <td className="col-bid">{renderEditable(r, 'bid_2')}</td>
                <td className="col-bid">{renderEditable(r, 'bid_3')}</td>
                <td className="col-bid">{renderEditable(r, 'bid_4')}</td>
                <td className="col-bid">{renderEditable(r, 'bid_5')}</td>
                <td className="col-eta">{fmt(r.eta_min, 1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
