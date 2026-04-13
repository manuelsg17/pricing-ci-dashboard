import { useState, useEffect, useMemo } from 'react'
import { BRACKETS, BRACKET_LABELS, getCountryConfig } from '../../lib/constants'

export default function ThresholdsTable({ thresholds, onSave, saving, country = 'Peru' }) {
  const config = getCountryConfig(country)
  
  // Combinar todas las city+category configuradas (incluye 'all')
  const cityCategories = useMemo(() => {
    const pairs = new Set()
    config.dbCities.forEach(city => {
      const cats = config.categoriesByCity?.[city] || []
      cats.forEach(cat => pairs.add(`${city}|||${cat}`))
    })
    // Agregar las que ya existen en DB y pertenezcan al país
    thresholds.forEach(t => {
      if (config.dbCities.includes(t.city)) {
        pairs.add(`${t.city}|||${t.category}`)
      }
    })
    return [...pairs].sort().map(p => {
      const [city, category] = p.split('|||')
      return { city, category }
    })
  }, [thresholds, config.dbCities, config.categoriesByCity])

  const [selectedCity, setSelectedCity] = useState(config.dbCities[0])
  const [selectedCat,  setSelectedCat]  = useState(config.categoriesByCity?.[config.dbCities[0]]?.[0] || '')
  
  // Reseteo si cambia país
  useEffect(() => {
    if (!config.dbCities.includes(selectedCity)) {
       const newCity = config.dbCities[0]
       setSelectedCity(newCity)
       setSelectedCat(config.categoriesByCity?.[newCity]?.[0] || '')
    }
  }, [country, config.dbCities, config.categoriesByCity, selectedCity])

  const [local,        setLocal]        = useState({})
  const [saveMsg,      setSaveMsg]      = useState('')

  // Cargar datos del par ciudad+categoría seleccionado
  const getKey = (city, cat, bracket) => `${city}|||${cat}|||${bracket}`

  const getValue = (bracket) => {
    const key = getKey(selectedCity, selectedCat, bracket)
    if (key in local) return local[key]
    const row = thresholds.find(t => t.city === selectedCity && t.category === selectedCat && t.bracket === bracket)
    return row ? (row.max_km ?? '') : ''
  }

  const handleChange = (bracket, val) => {
    setLocal(prev => ({ ...prev, [getKey(selectedCity, selectedCat, bracket)]: val }))
  }

  const handleSave = async () => {
    setSaveMsg('')
    const rows = BRACKETS.map(b => ({
      city:     selectedCity,
      category: selectedCat,
      bracket:  b,
      max_km:   getValue(b) === '' ? null : Number(getValue(b)),
    }))
    try {
      await onSave(rows)
      setSaveMsg('Guardado correctamente')
    } catch (e) {
      setSaveMsg('Error: ' + e.message)
    }
  }

  return (
    <div className="config-section">
      <h2>Umbrales de Distancia (km)</h2>
      <p style={{ fontSize: 11, color: '#888', marginBottom: 10 }}>
        Cada ciudad+categoría tiene su propia configuración. max_km vacío = sin límite (último bracket).
      </p>

      <div className="threshold-selector">
        <label>Ciudad</label>
        <select
          value={selectedCity}
          onChange={e => {
            setSelectedCity(e.target.value)
            setSelectedCat(config.categoriesByCity?.[e.target.value]?.[0] || '')
          }}
        >
          {config.dbCities.map(c => <option key={c}>{c}</option>)}
        </select>

        <label>Categoría</label>
        <select value={selectedCat} onChange={e => setSelectedCat(e.target.value)}>
          {(config.categoriesByCity?.[selectedCity] || []).map(c => <option key={c}>{c}</option>)}
        </select>
      </div>

      <table className="config-table">
        <thead>
          <tr>
            <th style={{ textAlign: 'left' }}>Bracket</th>
            <th>Máx. km (≤)</th>
            <th style={{ textAlign: 'left', fontSize: 9 }}>Descripción</th>
          </tr>
        </thead>
        <tbody>
          {BRACKETS.map((b, i) => (
            <tr key={b}>
              <td>{BRACKET_LABELS[b]}</td>
              <td>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder={i === BRACKETS.length - 1 ? '∞' : '0.00'}
                  value={getValue(b)}
                  onChange={e => handleChange(b, e.target.value)}
                />
              </td>
              <td style={{ textAlign: 'left', fontSize: 10, color: '#888', paddingLeft: 8 }}>
                {i === 0 && `Viajes ≤ ${getValue(b) || '?'} km`}
                {i > 0 && i < BRACKETS.length - 1 && `Entre ${getValue(BRACKETS[i-1]) || '?'} y ${getValue(b) || '?'} km`}
                {i === BRACKETS.length - 1 && 'Sin límite superior'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="config-footer">
        <button className="btn-save" onClick={handleSave} disabled={saving}>
          {saving ? 'Guardando...' : 'Guardar cambios'}
        </button>
        {saveMsg && (
          <span className={saveMsg.startsWith('Error') ? 'config-save-err' : 'config-save-ok'}>
            {saveMsg}
          </span>
        )}
      </div>
    </div>
  )
}
