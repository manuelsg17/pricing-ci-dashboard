import { useState } from 'react'
import { useDistanceRefs } from '../hooks/useDistanceRefs'
import { BRACKETS, BRACKET_LABELS } from '../lib/constants'
import '../styles/distance-refs.css'

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

export default function DistanceRefs() {
  const [uiCity,   setUiCity]   = useState('Lima')
  const dbCity = DB_CITY_MAP[uiCity]
  const categories = CATEGORIES_BY_DB_CITY[dbCity] || []

  const { refs, loading, saving, error, saveRef, deleteRef, addRow } = useDistanceRefs(dbCity)

  // Local edits
  const [edits, setEdits] = useState({})
  const getField = (id, field, original) => edits[id]?.[field] ?? original ?? ''
  const setField = (id, field, value) => setEdits(prev => ({
    ...prev,
    [id]: { ...prev[id], [field]: value },
  }))

  const handleSave = async (row) => {
    const merged = { ...row, ...edits[row.id] }
    const payload = {
      id:            String(row.id).startsWith('new_') ? undefined : row.id,
      city:          dbCity,
      category:      merged.category || '',
      bracket:       merged.bracket || '',
      point_a:       merged.point_a || '',
      coordinate_a:  merged.coordinate_a || '',
      point_b:       merged.point_b || '',
      coordinate_b:  merged.coordinate_b || '',
      waze_distance: merged.waze_distance !== '' ? Number(merged.waze_distance) : null,
    }
    const ok = await saveRef(payload)
    if (ok) setEdits(prev => { const n = { ...prev }; delete n[row.id]; return n })
  }

  const handleDelete = async (id) => {
    if (String(id).startsWith('new_')) {
      // just remove from local state
      setEdits(prev => { const n = { ...prev }; delete n[id]; return n })
      return
    }
    await deleteRef(id)
  }

  return (
    <div className="drefs-page">
      <h1>Distancias de Referencia</h1>
      <p className="drefs-page__desc">
        Base de consulta de rutas usadas para el CI. Edita directamente en la tabla y guarda fila por fila.
      </p>

      <div className="drefs-filters">
        <span className="drefs-filters__label">Ciudad</span>
        <select value={uiCity} onChange={e => { setUiCity(e.target.value); setEdits({}) }}>
          {UI_CITIES.map(c => <option key={c}>{c}</option>)}
        </select>
      </div>

      {error && <div className="drefs-error">Error: {error}</div>}

      <div className="drefs-section">
        <div className="drefs-section__header">
          <span className="drefs-section__title">{uiCity} — {refs.length} rutas registradas</span>
          <div className="drefs-section__actions">
            <button className="btn-add-row" onClick={addRow} disabled={saving}>+ Agregar fila</button>
          </div>
        </div>

        {loading ? (
          <div className="drefs-empty">Cargando…</div>
        ) : refs.length === 0 ? (
          <div className="drefs-empty">
            No hay rutas registradas para {uiCity}. Haz clic en "+ Agregar fila" para empezar.
          </div>
        ) : (
          <div className="drefs-table-wrap">
            <table className="drefs-table">
              <thead>
                <tr>
                  <th>Categoría</th>
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
                {refs.map(row => (
                  <tr key={row.id} className={row._isNew ? 'row-new' : ''}>
                    <td>
                      <select
                        value={getField(row.id, 'category', row.category)}
                        onChange={e => setField(row.id, 'category', e.target.value)}
                      >
                        <option value="">— Elige —</option>
                        {categories.map(c => <option key={c}>{c}</option>)}
                      </select>
                    </td>
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
