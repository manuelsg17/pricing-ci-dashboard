import { useState, useCallback, useEffect, useMemo } from 'react'
import { sb } from '../lib/supabase'
import { useRawData } from '../hooks/useRawData'
import { BRACKETS, BRACKET_LABELS, getCountryConfig } from '../lib/constants'
import '../styles/raw-data.css'

// DB-level city labels for tabs
const CITY_LABEL = { Lima: 'Lima', Trujillo: 'Trujillo', Arequipa: 'Arequipa', Airport: 'Aeropuerto', Corp: 'Corp' }

// Bracket options for filter select — derived from BRACKETS + BRACKET_LABELS
const BRACKET_OPTIONS = [
  { value: '', label: 'Todos' },
  ...BRACKETS.map(b => ({ value: b, label: BRACKET_LABELS[b] })),
]

const SURGE_OPTIONS = [
  { value: '',      label: 'Todos' },
  { value: 'true',  label: 'Sí (surge)' },
  { value: 'false', label: 'No surge' },
]

function fmt(val, decimals = 2) {
  if (val === null || val === undefined || val === '') return '—'
  const n = parseFloat(val)
  return isNaN(n) ? String(val) : n.toFixed(decimals)
}

export default function RawData({ country = 'Peru' }) {
  const config = getCountryConfig(country)
  const cityTabs = useMemo(() => config.dbCities.map(db => ({ db, label: CITY_LABEL[db] || db })), [config.dbCities])
  
  const getInitialState = (key, defaultVal) => {
    const saved = sessionStorage.getItem(`rawData_${key}`)
    return saved !== null ? saved : defaultVal
  }

  // Si dbCity inicial no está en config.dbCities, forzar a la primera ciudad de este país
  const defaultCity = getInitialState('dbCity', config.dbCities[0])
  const safeCity = config.dbCities.includes(defaultCity) ? defaultCity : config.dbCities[0]

  const [dbCity, setDbCity] = useState(safeCity)
  const [dbCategory,  setDbCategory]  = useState(getInitialState('dbCategory', ''))
  const [competition, setCompetition] = useState(getInitialState('competition', ''))
  const [surge,       setSurge]       = useState(getInitialState('surge', ''))
  const [bracket,     setBracket]     = useState(getInitialState('bracket', ''))
  const [dateFrom,    setDateFrom]    = useState(getInitialState('dateFrom', ''))
  const [dateTo,      setDateTo]      = useState(getInitialState('dateTo', ''))
  const [searchA,     setSearchA]     = useState(getInitialState('searchA', ''))
  const [searchB,     setSearchB]     = useState(getInitialState('searchB', ''))
  const [dataSource,  setDataSource]  = useState(getInitialState('dataSource', ''))
  const [outlierOnly, setOutlierOnly] = useState(() => sessionStorage.getItem('rawData_outlierOnly') === 'true')

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
  useEffect(() => { sessionStorage.setItem('rawData_outlierOnly', outlierOnly) }, [outlierOnly])
  
  // Asegurar que state.dbCity cambia si cambia el país y no es válido
  useEffect(() => {
    if (!config.dbCities.includes(dbCity)) {
      setDbCity(config.dbCities[0])
    }
  }, [country, config.dbCities, dbCity])

  const categories = useMemo(() => {
    // Si la config del país tiene categoriesByCity, usar esa, sino fallback
    return config.categoriesByCity?.[dbCity] || []
  }, [config, dbCity])

  const competitors = useMemo(() => {
    return config.competitorsByDbCityCategory?.[dbCity]?.[dbCategory] || []
  }, [config, dbCity, dbCategory])

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
    outlierOnly,
    country,
  }

  const { rows, setRows, total, setTotal, page, loading, error, fetch, pageSize } = useRawData(filters)

  const [editingId, setEditingId] = useState(null)
  const [editField, setEditField] = useState(null)
  const [editValue, setEditValue] = useState('')

  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState(null)   // { type: 'ok'|'err', text }

  const OUTLIER_THRESHOLD = 100

  const handleDelete = async (id) => {
    if (!confirm('¿Eliminar esta observación? Esta acción no se puede deshacer.')) return
    const { error: delErr } = await sb.from('pricing_observations').delete().eq('id', id)
    if (!delErr) {
      setRows(prev => prev.filter(r => r.id !== id))
      setTotal(prev => prev - 1)
    } else {
      alert('Error al eliminar: ' + delErr.message)
    }
  }

  const isOutlierRow = (r) =>
    parseFloat(r.price_without_discount) > OUTLIER_THRESHOLD ||
    parseFloat(r.price_with_discount) > OUTLIER_THRESHOLD ||
    parseFloat(r.recommended_price) > OUTLIER_THRESHOLD ||
    parseFloat(r.minimal_bid) > OUTLIER_THRESHOLD

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
    setOutlierOnly(false)
  }

  const handleSyncInDrive = async () => {
    setSyncing(true)
    setSyncMsg(null)
    try {
      const { data, error } = await sb.rpc('apply_indrive_bot_prices',
        dbCity ? { p_city: dbCity } : {}
      )
      if (error) throw error
      const count = typeof data === 'number' ? data : 0
      setSyncMsg({ type: 'ok', text: `✓ ${count.toLocaleString()} filas InDrive actualizadas` })
      fetch(page)
    } catch (e) {
      setSyncMsg({ type: 'err', text: 'Error: ' + e.message })
    } finally {
      setSyncing(false)
      setTimeout(() => setSyncMsg(null), 5000)
    }
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
        <div className="raw-data__filter-group">
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={outlierOnly}
              onChange={e => setOutlierOnly(e.target.checked)}
            />
            <span style={{ color: outlierOnly ? '#dc2626' : undefined }}>⚠ Outliers (&gt;S/100)</span>
          </label>
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

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={handleSyncInDrive}
            disabled={syncing}
            style={{
              padding: '4px 10px', fontSize: 12,
              border: '1px solid #d1d5db', borderRadius: 4,
              background: syncing ? '#f3f4f6' : '#fff',
              cursor: syncing ? 'default' : 'pointer',
            }}
            title="Recalcula price_without_discount para datos bot de InDrive usando los % configurados en Config > InDrive"
          >
            {syncing ? 'Sincronizando…' : '⟳ Precios InDrive (bot)'}
          </button>
          {syncMsg && (
            <span style={{ fontSize: 12, fontWeight: 600,
              color: syncMsg.type === 'ok' ? '#166534' : '#991b1b' }}>
              {syncMsg.text}
            </span>
          )}
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
              <th className="col-actions"></th>
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
              <th className="col-actions"></th>
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 && (
              <tr>
                <td colSpan={26} className="raw-data__state">Cargando datos…</td>
              </tr>
            )}
            {!loading && rows.length === 0 && (
              <tr>
                <td colSpan={26} className="raw-data__state">
                  No se encontraron filas con los filtros actuales.
                </td>
              </tr>
            )}
            {rows.map((r, i) => (
              <tr
                key={r.id ?? i}
                className={[
                  isYangoRow(r) ? 'raw-data__row--yango' : '',
                  isOutlierRow(r) ? 'raw-data__row--outlier' : '',
                ].filter(Boolean).join(' ')}
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
                <td className={`col-price${parseFloat(r.price_without_discount) > OUTLIER_THRESHOLD ? ' cell-outlier' : ''}`}>{renderEditable(r, 'price_without_discount')}</td>
                <td className={`col-price${parseFloat(r.price_with_discount) > OUTLIER_THRESHOLD ? ' cell-outlier' : ''}`}>{renderEditable(r, 'price_with_discount')}</td>
                <td className={`col-price${parseFloat(r.recommended_price) > OUTLIER_THRESHOLD ? ' cell-outlier' : ''}`}>{renderEditable(r, 'recommended_price')}</td>
                <td className={`col-price${parseFloat(r.minimal_bid) > OUTLIER_THRESHOLD ? ' cell-outlier' : ''}`}>{renderEditable(r, 'minimal_bid')}</td>
                <td className="col-bid">{renderEditable(r, 'bid_1')}</td>
                <td className="col-bid">{renderEditable(r, 'bid_2')}</td>
                <td className="col-bid">{renderEditable(r, 'bid_3')}</td>
                <td className="col-bid">{renderEditable(r, 'bid_4')}</td>
                <td className="col-bid">{renderEditable(r, 'bid_5')}</td>
                <td className="col-eta">{fmt(r.eta_min, 1)}</td>
                <td className="col-actions">
                  <button
                    className="raw-data__delete-btn"
                    onClick={() => handleDelete(r.id)}
                    title="Eliminar fila"
                  >🗑</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
