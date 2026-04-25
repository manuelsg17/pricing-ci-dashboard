import { useState, useEffect, useMemo } from 'react'
import { BRACKETS, BRACKET_LABELS, getCountryConfig } from '../../lib/constants'
import SaveStatusBanner from './SaveStatusBanner'

export default function WeightsTable({ weights, onSave, saving, country }) {
  const config = getCountryConfig(country)
  const weightCities = useMemo(() => ['all', ...config.dbCities], [config.dbCities])

  const [activeCity, setActiveCity] = useState(weightCities[1] || 'all')

  // Reseteo si cambia país
  useEffect(() => {
    if (!weightCities.includes(activeCity)) {
       setActiveCity(weightCities[1] || 'all')
    }
  }, [country, weightCities, activeCity])

  const [local,   setLocal]   = useState({})
  const [saveMsg, setSaveMsg] = useState(null)

  const getKey = (city, bracket) => `${city}|||${bracket}`

  const getDbValue = (bracket) => {
    const row = weights.find(w => w.city === activeCity && w.bracket === bracket)
    return row ? (Number(row.weight) * 100).toFixed(2) : ''
  }

  const getValue = (bracket) => {
    const key = getKey(activeCity, bracket)
    if (key in local) return local[key]
    return getDbValue(bracket)
  }

  const isDirty = (bracket) => {
    const key = getKey(activeCity, bracket)
    if (!(key in local)) return false
    return String(local[key] ?? '') !== String(getDbValue(bracket) ?? '')
  }

  const hasUnsavedChanges = BRACKETS.some(b => isDirty(b))

  const handleChange = (bracket, val) => {
    setSaveMsg(null)
    setLocal(prev => ({ ...prev, [getKey(activeCity, bracket)]: val }))
  }

  const handleDiscard = () => {
    setSaveMsg(null)
    setLocal(prev => {
      const next = { ...prev }
      BRACKETS.forEach(b => delete next[getKey(activeCity, b)])
      return next
    })
  }

  // Suma total de pesos para validación
  const totalPct = useMemo(() => {
    return BRACKETS.reduce((sum, b) => {
      const v = parseFloat(getValue(b)) || 0
      return sum + v
    }, 0)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [local, weights, activeCity])

  const totalOk = Math.abs(totalPct - 100) < 0.1

  const handleSave = async () => {
    setSaveMsg(null)
    const rows = BRACKETS.map(b => ({
      city:    activeCity,
      bracket: b,
      weight:  (parseFloat(getValue(b)) || 0) / 100,
    }))
    try {
      await onSave(rows)
      setSaveMsg({ type: 'ok', text: `Pesos guardados para ${activeCity === 'all' ? 'Global' : activeCity}.` })
      setLocal(prev => {
        const next = { ...prev }
        BRACKETS.forEach(b => delete next[getKey(activeCity, b)])
        return next
      })
    } catch (e) {
      setSaveMsg({ type: 'err', text: 'Error al guardar: ' + e.message })
    }
  }

  return (
    <div className="config-section">
      <h2>Pesos para Promedio Ponderado (%)</h2>
      <p style={{ fontSize: 11, color: '#888', marginBottom: 10 }}>
        Cada ciudad puede tener pesos distintos. La suma debe ser 100%.
      </p>

      <div className="city-tabs">
        {weightCities.map(c => (
          <button
            key={c}
            className={`city-tab${activeCity === c ? ' active' : ''}`}
            onClick={() => setActiveCity(c)}
          >
            {c === 'all' ? 'Global (default)' : c}
          </button>
        ))}
      </div>

      {hasUnsavedChanges && (
        <div style={{
          marginTop: 8, marginBottom: 12,
          padding: '10px 14px', borderRadius: 6,
          background: '#fef3c7', border: '1px solid #f59e0b',
          color: '#78350f', fontSize: 13, fontWeight: 500,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
        }}>
          <span>⚠ Hay cambios sin guardar en <strong>{activeCity === 'all' ? 'Global' : activeCity}</strong></span>
          <button
            type="button"
            onClick={handleDiscard}
            style={{
              background: 'transparent', border: '1px solid #b45309',
              color: '#78350f', padding: '4px 10px', borderRadius: 4,
              fontSize: 12, cursor: 'pointer',
            }}
          >
            Descartar
          </button>
        </div>
      )}

      <table className="config-table">
        <thead>
          <tr>
            <th style={{ textAlign: 'left' }}>Bracket</th>
            <th>Peso (%)</th>
          </tr>
        </thead>
        <tbody>
          {BRACKETS.map(b => {
            const dirty = isDirty(b)
            return (
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
                    style={dirty ? {
                      background:  '#fef3c7',
                      borderColor: '#f59e0b',
                      fontWeight:  600,
                      boxShadow:   '0 0 0 2px rgba(245, 158, 11, 0.2)',
                    } : undefined}
                    title={dirty ? `BD: ${getDbValue(b) || '0'}% — sin guardar` : undefined}
                  />
                </td>
              </tr>
            )
          })}
          <tr style={{ background: totalOk ? '#f0fdf4' : '#fef2f2' }}>
            <td style={{ fontWeight: 700 }}>Total</td>
            <td>
              <span style={{
                fontWeight: 700,
                color: totalOk ? '#15803d' : '#b91c1c',
              }}>
                {totalPct.toFixed(2)}% {totalOk ? '' : '(debe ser 100%)'}
              </span>
            </td>
          </tr>
        </tbody>
      </table>

      <div className="config-footer" style={{ marginTop: 14 }}>
        <button
          className="btn-save"
          onClick={handleSave}
          disabled={saving || !hasUnsavedChanges || !totalOk}
          title={
            !hasUnsavedChanges ? 'No hay cambios para guardar'
          : !totalOk ? 'La suma debe ser exactamente 100%'
          : undefined
          }
        >
          {saving ? 'Guardando…' : 'Guardar pesos'}
        </button>
        <SaveStatusBanner status={saveMsg} onDismiss={() => setSaveMsg(null)} />
      </div>
    </div>
  )
}
