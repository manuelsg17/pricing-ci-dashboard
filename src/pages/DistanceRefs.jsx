import { useState } from 'react'
import { useDistanceRefs } from '../hooks/useDistanceRefs'
import { BRACKETS, BRACKET_LABELS } from '../lib/constants'
import '../styles/distance-refs.css'

const UI_CITIES = ['Lima', 'Trujillo', 'Arequipa', 'Aeropuerto', 'Corp']

const DB_CITY_MAP = {
  Lima: 'Lima', Trujillo: 'Trujillo', Arequipa: 'Arequipa',
  Aeropuerto: 'Airport', Corp: 'Corp',
}

// Categorías UI por ciudad DB (lo que ve el usuario)
const CATEGORIES_BY_DB_CITY = {
  Lima:     ['Economy', 'Comfort', 'Comfort+/Premier', 'TukTuk', 'XL'],
  Trujillo: ['Economy', 'Comfort/Comfort+'],
  Arequipa: ['Economy', 'Comfort/Comfort+'],
  Airport:  ['Economy', 'Comfort', 'Comfort+/Premier'],
  Corp:     ['Corp'],
}

// Mapeo nombre UI de categoría → nombre BD
const UI_CAT_TO_DB = {
  'Economy':          'Economy',
  'Comfort':          'Comfort',
  'Comfort+/Premier': 'Premier',
  'Comfort/Comfort+': 'Comfort',
  'TukTuk':           'TukTuk',
  'XL':               'XL',
  'Corp':             'Corp',
}

export default function DistanceRefs() {
  const [uiCity,    setUiCity]    = useState('Lima')
  const [uiCat,     setUiCat]     = useState('Economy')
  const [bulkSaving, setBulkSaving] = useState(false)
  const [bulkMsg,    setBulkMsg]    = useState(null)

  const dbCity     = DB_CITY_MAP[uiCity]
  const categories = CATEGORIES_BY_DB_CITY[dbCity] || []
  const dbCat      = UI_CAT_TO_DB[uiCat] || uiCat

  const { refs, loading, saving, error, saveRef, deleteRef, addRow, addCategoryRows } = useDistanceRefs(dbCity)

  // Local edits
  const [edits, setEdits] = useState({})
  const getField = (id, field, original) => edits[id]?.[field] ?? original ?? ''
  const setField = (id, field, value) => setEdits(prev => ({
    ...prev,
    [id]: { ...prev[id], [field]: value },
  }))

  // Refs filtradas por categoría seleccionada (DB level)
  const filteredRefs = refs.filter(r => r.category === dbCat || (r._isNew && r.category === dbCat))

  // Filas "pending": nuevas o con edits
  const pendingRefs = filteredRefs.filter(r => r._isNew || edits[r.id])
  const pendingCount = pendingRefs.length

  function handleCityChange(city) {
    setUiCity(city)
    const cats = CATEGORIES_BY_DB_CITY[DB_CITY_MAP[city]] || []
    setUiCat(cats[0] || 'Economy')
    setEdits({})
    setBulkMsg(null)
  }

  function handleCatChange(cat) {
    setUiCat(cat)
    setBulkMsg(null)
  }

  const handleSave = async (row) => {
    const merged = { ...row, ...edits[row.id] }
    const payload = {
      id:            String(row.id).startsWith('new_') ? undefined : row.id,
      city:          dbCity,
      category:      dbCat,
      bracket:       merged.bracket || '',
      point_a:       merged.point_a || '',
      coordinate_a:  merged.coordinate_a || '',
      point_b:       merged.point_b || '',
      coordinate_b:  merged.coordinate_b || '',
      waze_distance: merged.waze_distance !== '' && merged.waze_distance != null
                     ? Number(merged.waze_distance) : null,
    }
    const ok = await saveRef(payload)
    if (ok) setEdits(prev => { const n = { ...prev }; delete n[row.id]; return n })
  }

  const handleDelete = async (id) => {
    if (String(id).startsWith('new_')) {
      setEdits(prev => { const n = { ...prev }; delete n[id]; return n })
      return
    }
    await deleteRef(id)
  }

  // Agregar todos los brackets para la categoría seleccionada
  const handleAddCategory = () => {
    addCategoryRows(dbCat, BRACKETS)
    setBulkMsg(null)
  }

  // Guardar todas las filas pendientes de la vista actual
  const handleSaveAll = async () => {
    const toSave = filteredRefs.filter(r => r._isNew || edits[r.id])
    if (!toSave.length) { setBulkMsg({ type: 'ok', text: 'No hay cambios pendientes.' }); return }
    setBulkSaving(true); setBulkMsg(null)
    let saved = 0, failed = 0
    for (const row of toSave) {
      const merged = { ...row, ...edits[row.id] }
      const payload = {
        id:            String(row.id).startsWith('new_') ? undefined : row.id,
        city:          dbCity,
        category:      dbCat,
        bracket:       merged.bracket || '',
        point_a:       merged.point_a || '',
        coordinate_a:  merged.coordinate_a || '',
        point_b:       merged.point_b || '',
        coordinate_b:  merged.coordinate_b || '',
        waze_distance: merged.waze_distance !== '' && merged.waze_distance != null
                       ? Number(merged.waze_distance) : null,
      }
      const ok = await saveRef(payload)
      if (ok) { saved++; setEdits(prev => { const n = { ...prev }; delete n[row.id]; return n }) }
      else failed++
    }
    setBulkSaving(false)
    if (failed === 0) setBulkMsg({ type: 'ok', text: `✓ ${saved} filas guardadas correctamente.` })
    else setBulkMsg({ type: 'err', text: `${saved} guardadas, ${failed} con error.` })
  }

  return (
    <div className="drefs-page">
      <h1>Distancias de Referencia</h1>
      <p className="drefs-page__desc">
        Base de consulta de rutas usadas para el CI. Al agregar una categoría completa se crean los 6 brackets de una vez.
      </p>

      {/* City selector */}
      <div className="drefs-filters">
        <span className="drefs-filters__label">Ciudad</span>
        <select value={uiCity} onChange={e => handleCityChange(e.target.value)}>
          {UI_CITIES.map(c => <option key={c}>{c}</option>)}
        </select>
      </div>

      {error && <div className="drefs-error">Error: {error}</div>}

      {/* Category tabs */}
      <div className="drefs-cat-tabs">
        {categories.map(cat => (
          <button
            key={cat}
            className={`drefs-cat-tab${uiCat === cat ? ' active' : ''}`}
            onClick={() => handleCatChange(cat)}
          >
            {cat}
            {/* badge de cuántas rutas tiene */}
            <span className="drefs-cat-count">
              {refs.filter(r => r.category === UI_CAT_TO_DB[cat]).length}
            </span>
          </button>
        ))}
      </div>

      {/* Bulk messages */}
      {bulkMsg && (
        <div className={`drefs-bulk-msg${bulkMsg.type === 'ok' ? ' drefs-bulk-msg--ok' : ' drefs-bulk-msg--err'}`}>
          {bulkMsg.text}
        </div>
      )}

      <div className="drefs-section">
        <div className="drefs-section__header">
          <span className="drefs-section__title">
            {uiCity} — {uiCat} — {filteredRefs.length} rutas
            {pendingCount > 0 && (
              <span className="drefs-pending-badge">{pendingCount} pendiente{pendingCount > 1 ? 's' : ''}</span>
            )}
          </span>
          <div className="drefs-section__actions">
            {pendingCount > 0 && (
              <button
                className="btn-save-all"
                onClick={handleSaveAll}
                disabled={bulkSaving || saving}
              >
                {bulkSaving ? 'Guardando…' : `💾 Guardar todos (${pendingCount})`}
              </button>
            )}
            <button
              className="btn-add-category"
              onClick={handleAddCategory}
              disabled={saving || bulkSaving}
            >
              + Agregar {uiCat} completa
            </button>
            <button
              className="btn-add-row"
              onClick={() => { addRow(); setBulkMsg(null) }}
              disabled={saving}
            >
              + Fila individual
            </button>
          </div>
        </div>

        {loading ? (
          <div className="drefs-empty">Cargando…</div>
        ) : filteredRefs.length === 0 ? (
          <div className="drefs-empty">
            No hay rutas para <strong>{uiCity} · {uiCat}</strong>.
            Haz clic en <strong>"+ Agregar {uiCat} completa"</strong> para crear los 6 brackets de una vez.
          </div>
        ) : (
          <div className="drefs-table-wrap">
            <table className="drefs-table">
              <thead>
                <tr>
                  <th>Bracket</th>
                  <th>Punto A</th>
                  <th>Coord. A</th>
                  <th>Punto B</th>
                  <th>Coord. B</th>
                  <th>Dist. Waze (km)</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {filteredRefs.map(row => (
                  <tr key={row.id} className={row._isNew ? 'row-new' : edits[row.id] ? 'row-edited' : ''}>
                    <td>
                      <select
                        value={getField(row.id, 'bracket', row.bracket)}
                        onChange={e => setField(row.id, 'bracket', e.target.value)}
                      >
                        <option value="">— Elige —</option>
                        {BRACKETS.map(b => (
                          <option key={b} value={b}>{BRACKET_LABELS[b]}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        className="wide"
                        placeholder="Nombre punto A"
                        value={getField(row.id, 'point_a', row.point_a)}
                        onChange={e => setField(row.id, 'point_a', e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        className="coord"
                        placeholder="-12.0464, -77.0428"
                        value={getField(row.id, 'coordinate_a', row.coordinate_a)}
                        onChange={e => setField(row.id, 'coordinate_a', e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        className="wide"
                        placeholder="Nombre punto B"
                        value={getField(row.id, 'point_b', row.point_b)}
                        onChange={e => setField(row.id, 'point_b', e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        className="coord"
                        placeholder="-12.1050, -77.0365"
                        value={getField(row.id, 'coordinate_b', row.coordinate_b)}
                        onChange={e => setField(row.id, 'coordinate_b', e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        className="dist"
                        type="number"
                        step="0.1"
                        min="0"
                        placeholder="0.0"
                        value={getField(row.id, 'waze_distance', row.waze_distance)}
                        onChange={e => setField(row.id, 'waze_distance', e.target.value)}
                      />
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button
                          className="btn-save-row"
                          onClick={() => handleSave(row)}
                          disabled={saving}
                        >
                          Guardar
                        </button>
                        <button
                          className="btn-delete-row"
                          onClick={() => handleDelete(row.id)}
                          disabled={saving}
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
