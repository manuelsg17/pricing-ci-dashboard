import { useState, useMemo } from 'react'
import { BRACKETS, BRACKET_LABELS, WEIGHT_CITIES } from '../../lib/constants'

export default function WeightsTable({ weights, onSave, saving }) {
  const [activeCity, setActiveCity] = useState(WEIGHT_CITIES[1]) // 'Lima' por defecto
  const [local,      setLocal]      = useState({})
  const [saveMsg,    setSaveMsg]    = useState('')

  const getKey = (city, bracket) => `${city}|||${bracket}`

  const getValue = (bracket) => {
    const key = getKey(activeCity, bracket)
    if (key in local) return local[key]
    const row = weights.find(w => w.city === activeCity && w.bracket === bracket)
    // Mostrar como porcentaje (0.0983 → 9.83)
    return row ? (Number(row.weight) * 100).toFixed(2) : ''
  }

  const handleChange = (bracket, val) => {
    setLocal(prev => ({ ...prev, [getKey(activeCity, bracket)]: val }))
  }

  // Suma total de pesos para validación
  const totalPct = useMemo(() => {
    return BRACKETS.reduce((sum, b) => {
      const v = parseFloat(getValue(b)) || 0
      return sum + v
    }, 0)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [local, weights, activeCity])

  const handleSave = async () => {
    setSaveMsg('')
    const rows = BRACKETS.map(b => ({
      city:    activeCity,
      bracket: b,
      weight:  (parseFloat(getValue(b)) || 0) / 100,  // guardar como fracción
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
      <h2>Pesos para Promedio Ponderado (%)</h2>
      <p style={{ fontSize: 11, color: '#888', marginBottom: 10 }}>
        Cada ciudad puede tener pesos distintos.
      </p>

      <div className="city-tabs">
        {WEIGHT_CITIES.map(c => (
          <button
            key={c}
            className={`city-tab${activeCity === c ? ' active' : ''}`}
            onClick={() => setActiveCity(c)}
          >
            {c === 'all' ? 'Global (default)' : c}
          </button>
        ))}
      </div>

      <table className="config-table">
        <thead>
          <tr>
            <th style={{ textAlign: 'left' }}>Bracket</th>
            <th>Peso (%)</th>
          </tr>
        </thead>
        <tbody>
          {BRACKETS.map(b => (
            <tr key={b}>
              <td>{BRACKET_LABELS[b]}</td>
              <td>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  value={getValue(b)}
                  onChange={e => handleChange(b, e.target.value)}
                />
              </td>
            </tr>
          ))}
          <tr style={{ background: '#f9fbe7' }}>
            <td style={{ fontWeight: 700 }}>Total</td>
            <td>
              <span className="weight-sum ok">
                {totalPct.toFixed(2)}%
              </span>
            </td>
          </tr>
        </tbody>
      </table>

      <div className="config-footer">
        <button className="btn-save" onClick={handleSave} disabled={saving}>
          {saving ? 'Guardando...' : 'Guardar pesos'}
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
