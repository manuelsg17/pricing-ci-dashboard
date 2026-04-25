import { useState, useEffect, useMemo } from 'react'
import { BRACKETS, BRACKET_LABELS, getCountryConfig } from '../../lib/constants'

export default function ThresholdsTable({ thresholds, onSave, saving, country }) {
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

  const [local,   setLocal]   = useState({})
  const [saveMsg, setSaveMsg] = useState(null)   // { type: 'ok'|'err', text } | null

  // Auto-ocultar mensaje OK tras 4s
  useEffect(() => {
    if (saveMsg?.type !== 'ok') return
    const id = setTimeout(() => setSaveMsg(null), 4000)
    return () => clearTimeout(id)
  }, [saveMsg])

  const getKey = (city, cat, bracket) => `${city}|||${cat}|||${bracket}`

  const getDbValue = (bracket) => {
    const row = thresholds.find(t => t.city === selectedCity && t.category === selectedCat && t.bracket === bracket)
    return row ? (row.max_km ?? '') : ''
  }

  const getValue = (bracket) => {
    const key = getKey(selectedCity, selectedCat, bracket)
    if (key in local) return local[key]
    return getDbValue(bracket)
  }

  // ¿El input del bracket actual está sucio (distinto del valor de BD)?
  const isDirty = (bracket) => {
    const key = getKey(selectedCity, selectedCat, bracket)
    if (!(key in local)) return false
    const localVal = String(local[key] ?? '')
    const dbVal    = String(getDbValue(bracket) ?? '')
    return localVal !== dbVal
  }

  // Hay al menos un input modificado en la ciudad+categoría actual
  const hasUnsavedChanges = BRACKETS.some(b => isDirty(b))

  const handleChange = (bracket, val) => {
    setSaveMsg(null)
    setLocal(prev => ({ ...prev, [getKey(selectedCity, selectedCat, bracket)]: val }))
  }

  const handleDiscard = () => {
    setSaveMsg(null)
    setLocal(prev => {
      const next = { ...prev }
      BRACKETS.forEach(b => delete next[getKey(selectedCity, selectedCat, b)])
      return next
    })
  }

  const handleSave = async () => {
    setSaveMsg(null)
    const rows = BRACKETS.map(b => ({
      city:     selectedCity,
      category: selectedCat,
      bracket:  b,
      max_km:   getValue(b) === '' ? null : Number(getValue(b)),
    }))
    try {
      const result = await onSave(rows)
      const recomputed = result?.recomputedCount ?? 0
      setSaveMsg({
        type: 'ok',
        text: recomputed > 0
          ? `Guardado. ${recomputed.toLocaleString()} filas del dashboard fueron reclasificadas con los nuevos umbrales.`
          : `Guardado para ${selectedCity} — ${selectedCat}.`,
      })
      // limpiar el buffer local solo para la ciudad+categoría guardada
      setLocal(prev => {
        const next = { ...prev }
        BRACKETS.forEach(b => delete next[getKey(selectedCity, selectedCat, b)])
        return next
      })
    } catch (e) {
      setSaveMsg({ type: 'err', text: 'Error al guardar: ' + e.message })
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

      {/* Aviso inline de cambios pendientes */}
      {hasUnsavedChanges && (
        <div
          style={{
            marginTop: 8, marginBottom: 12,
            padding: '10px 14px', borderRadius: 6,
            background: '#fef3c7', border: '1px solid #f59e0b',
            color: '#78350f', fontSize: 13, fontWeight: 500,
            display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
          }}
        >
          <span>⚠ Hay cambios sin guardar en <strong>{selectedCity} — {selectedCat}</strong></span>
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
            <th>Máx. km (≤)</th>
            <th style={{ textAlign: 'left', fontSize: 9 }}>Descripción</th>
          </tr>
        </thead>
        <tbody>
          {BRACKETS.map((b, i) => {
            const dirty = isDirty(b)
            return (
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
                    style={dirty ? {
                      background:   '#fef3c7',
                      borderColor:  '#f59e0b',
                      fontWeight:   600,
                      boxShadow:    '0 0 0 2px rgba(245, 158, 11, 0.2)',
                    } : undefined}
                    title={dirty ? `Valor en BD: ${getDbValue(b) || 'sin límite'} — sin guardar` : undefined}
                  />
                </td>
                <td style={{ textAlign: 'left', fontSize: 10, color: '#888', paddingLeft: 8 }}>
                  {i === 0 && `Viajes ≤ ${getValue(b) || '?'} km`}
                  {i > 0 && i < BRACKETS.length - 1 && `Entre ${getValue(BRACKETS[i-1]) || '?'} y ${getValue(b) || '?'} km`}
                  {i === BRACKETS.length - 1 && 'Sin límite superior'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <div className="config-footer" style={{ marginTop: 14 }}>
        <button
          className="btn-save"
          onClick={handleSave}
          disabled={saving || !hasUnsavedChanges}
          title={!hasUnsavedChanges ? 'No hay cambios para guardar' : undefined}
        >
          {saving ? 'Guardando…' : 'Guardar cambios'}
        </button>

        {saveMsg && (
          <div
            role="status"
            style={{
              marginTop: 10,
              padding: '10px 14px', borderRadius: 6,
              fontSize: 13, fontWeight: 500,
              background: saveMsg.type === 'ok' ? '#d1fae5' : '#fee2e2',
              color:      saveMsg.type === 'ok' ? '#065f46' : '#991b1b',
              border: `1px solid ${saveMsg.type === 'ok' ? '#10b981' : '#ef4444'}`,
            }}
          >
            {saveMsg.type === 'ok' ? '✓ ' : '✕ '}{saveMsg.text}
          </div>
        )}
      </div>
    </div>
  )
}
