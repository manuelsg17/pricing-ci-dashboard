import { useState, useEffect, useCallback } from 'react'
import { sb } from '../../lib/supabase'
import { COUNTRY_CONFIG, COMPETITOR_COLORS } from '../../lib/constants'
import { useCountry } from '../../context/CountryContext'

const CONST_KEYS    = Object.keys(COUNTRY_CONFIG)
const ALL_COMPETITORS = Object.keys(COMPETITOR_COLORS)

// ── Style helpers ─────────────────────────────────────────────────────

const fieldLabelStyle = {
  display: 'block', fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: 0.4, color: 'var(--color-muted)', marginBottom: 3, marginTop: 8,
}

function inputStyle(disabled) {
  return {
    width: '100%', padding: '4px 6px',
    border: '1.5px solid var(--color-border)',
    borderRadius: 'var(--radius-sm)', fontSize: 12,
    background: disabled ? 'var(--color-bg)' : 'var(--color-panel)',
    color: disabled ? 'var(--color-muted)' : 'var(--color-text)',
    boxSizing: 'border-box', outline: 'none',
  }
}

const competitorTagStyle = {
  display: 'inline-flex', alignItems: 'center',
  padding: '2px 8px', fontSize: 11,
  background: 'rgba(229,57,53,0.08)',
  border: '1px solid rgba(229,57,53,0.25)',
  borderRadius: 12, color: '#b71c1c',
  fontWeight: 600,
}

// ── Sub-component: add-competitor dropdown ────────────────────────────

function CompetitorAdder({ existing, onAdd }) {
  const [val, setVal] = useState('')
  const available = ALL_COMPETITORS.filter(c => !existing.includes(c))
  return (
    <div style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
      <select
        value={val}
        onChange={e => setVal(e.target.value)}
        style={{
          fontSize: 11, padding: '2px 4px',
          border: '1px dashed var(--color-border)',
          borderRadius: 'var(--radius-sm)', background: 'var(--color-panel)',
        }}
      >
        <option value="">+ Agregar...</option>
        {available.map(c => <option key={c} value={c}>{c}</option>)}
      </select>
      {val && (
        <button
          className="btn-save-sm"
          style={{ height: 22, padding: '0 8px', fontSize: 10 }}
          onClick={() => { onAdd(val); setVal('') }}
        >
          OK
        </button>
      )}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────

export default function CountriesConfig() {
  const { dbConfigs, refreshConfigs } = useCountry()

  const [dbRows, setDbRows]                   = useState([])
  const [loading, setLoading]                 = useState(true)
  const [selectedKey, setSelectedKey]         = useState(null)
  const [selectedCityIdx, setSelectedCityIdx] = useState(null)
  const [draft, setDraft]                     = useState({})
  const [savingKey, setSavingKey]             = useState(null)
  const [msg, setMsg]                         = useState(null)

  const loadRows = useCallback(async () => {
    setLoading(true)
    const { data } = await sb.from('country_config').select('*').order('sort_order')
    setDbRows(data || [])
    setLoading(false)
  }, [])

  useEffect(() => { loadRows() }, [loadRows])

  // ── Derived helpers ───────────────────────────────────────────────

  const dbKeys     = dbRows.map(r => r.country_key)
  const dbOnlyKeys = dbKeys.filter(k => !CONST_KEYS.includes(k))
  const allKeys    = [...CONST_KEYS, ...dbOnlyKeys]

  const isDbManaged = (key) => dbRows.some(r => r.country_key === key)
  const isReadOnly  = (key) => CONST_KEYS.includes(key) && !isDbManaged(key)

  // ── Draft helpers ─────────────────────────────────────────────────

  function getOrInitDraft(key) {
    if (draft[key]) return draft[key]
    const existing = dbRows.find(r => r.country_key === key)
    if (existing) return JSON.parse(JSON.stringify(existing))   // deep clone
    return {
      country_key: key, label: key, currency: 'USD', locale: 'en-US',
      outlier_threshold: 100, max_price: 1000, sort_order: dbRows.length, cities: [],
    }
  }

  function setDraftField(key, field, value) {
    const base = getOrInitDraft(key)
    setDraft(prev => ({ ...prev, [key]: { ...base, [field]: value } }))
  }

  function setCity(key, cityIdx, cityObj) {
    const row = getOrInitDraft(key)
    const cities = [...(row.cities || [])]
    cities[cityIdx] = cityObj
    setDraft(prev => ({ ...prev, [key]: { ...row, cities } }))
  }

  function addCity(key) {
    const row = getOrInitDraft(key)
    const cities = [...(row.cities || []), { uiName: '', dbName: '', botKey: '', isVirtual: false, categories: [] }]
    setDraft(prev => ({ ...prev, [key]: { ...row, cities } }))
    setSelectedCityIdx(cities.length - 1)
  }

  function deleteCity(key, cityIdx) {
    const row = getOrInitDraft(key)
    const cities = row.cities.filter((_, i) => i !== cityIdx)
    setDraft(prev => ({ ...prev, [key]: { ...row, cities } }))
    setSelectedCityIdx(prev => (prev >= cities.length ? Math.max(0, cities.length - 1) : prev))
  }

  function addCategory(key, cityIdx) {
    const row  = getOrInitDraft(key)
    const cities = row.cities.map((c, i) =>
      i !== cityIdx ? c : {
        ...c,
        categories: [...(c.categories || []), { name: '', dbName: '', competitors: [], yangoDisplayName: 'Yango' }],
      }
    )
    setDraft(prev => ({ ...prev, [key]: { ...row, cities } }))
  }

  function deleteCategory(key, cityIdx, catIdx) {
    const row = getOrInitDraft(key)
    const cities = row.cities.map((c, i) =>
      i !== cityIdx ? c : { ...c, categories: c.categories.filter((_, ci) => ci !== catIdx) }
    )
    setDraft(prev => ({ ...prev, [key]: { ...row, cities } }))
  }

  function setCategoryField(key, cityIdx, catIdx, field, value) {
    const row = getOrInitDraft(key)
    const cities = row.cities.map((c, i) => {
      if (i !== cityIdx) return c
      const categories = c.categories.map((cat, ci) =>
        ci !== catIdx ? cat : { ...cat, [field]: value }
      )
      return { ...c, categories }
    })
    setDraft(prev => ({ ...prev, [key]: { ...row, cities } }))
  }

  function addCompetitor(key, cityIdx, catIdx, competitor) {
    const row = getOrInitDraft(key)
    const existing = row.cities[cityIdx].categories[catIdx].competitors
    if (competitor && !existing.includes(competitor)) {
      setCategoryField(key, cityIdx, catIdx, 'competitors', [...existing, competitor])
    }
  }

  function removeCompetitor(key, cityIdx, catIdx, competitor) {
    const row = getOrInitDraft(key)
    const existing = row.cities[cityIdx].categories[catIdx].competitors
    setCategoryField(key, cityIdx, catIdx, 'competitors', existing.filter(c => c !== competitor))
  }

  // ── Save / Delete ─────────────────────────────────────────────────

  async function handleSave(key) {
    const row = draft[key] || dbRows.find(r => r.country_key === key)
    if (!row) return
    setSavingKey(key); setMsg(null)
    const payload = {
      country_key:       row.country_key,
      label:             row.label,
      currency:          row.currency,
      locale:            row.locale,
      outlier_threshold: Number(row.outlier_threshold),
      max_price:         Number(row.max_price),
      sort_order:        Number(row.sort_order ?? 0),
      cities:            row.cities || [],
      updated_at:        new Date().toISOString(),
    }
    const { error } = await sb.from('country_config')
      .upsert(payload, { onConflict: 'country_key' })
    if (!error) {
      setMsg({ type: 'ok', text: '✓ Guardado' })
      await loadRows()
      refreshConfigs()
    } else {
      setMsg({ type: 'err', text: 'Error: ' + error.message })
    }
    setSavingKey(null)
  }

  async function handleDeleteCountry(key) {
    if (!window.confirm(`¿Eliminar la configuración de "${key}" de la base de datos?`)) return
    await sb.from('country_config').delete().eq('country_key', key)
    setDbRows(prev => prev.filter(r => r.country_key !== key))
    setDraft(prev => { const n = { ...prev }; delete n[key]; return n })
    if (selectedKey === key) { setSelectedKey(null); setSelectedCityIdx(null) }
    refreshConfigs()
  }

  function addNewCountry() {
    const key = `NewCountry_${Date.now()}`
    const blank = {
      country_key: key, label: 'Nuevo País', currency: 'USD',
      locale: 'en-US', outlier_threshold: 100, max_price: 1000,
      sort_order: dbRows.length, cities: [],
    }
    setDbRows(prev => [...prev, blank])
    setDraft(prev => ({ ...prev, [key]: blank }))
    setSelectedKey(key)
    setSelectedCityIdx(null)
  }

  // ── Derived active values ─────────────────────────────────────────

  const activeRow      = selectedKey ? getOrInitDraft(selectedKey) : null
  const activeCities   = activeRow?.cities || []
  const activeCity     = selectedCityIdx != null ? activeCities[selectedCityIdx] : null
  const readonly       = selectedKey ? isReadOnly(selectedKey) : false

  // ── Render ────────────────────────────────────────────────────────

  if (loading) return <div className="config-loading">Cargando países…</div>

  return (
    <div style={{ display: 'flex', gap: 0, height: 'calc(100vh - 160px)', overflow: 'hidden', borderTop: '1px solid var(--color-border)' }}>

      {/* ── Panel 1: Country list ──────────────────────────────── */}
      <div style={{
        width: 210, borderRight: '1px solid var(--color-border)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden', flexShrink: 0,
      }}>
        <div style={{
          padding: '10px 12px', display: 'flex', alignItems: 'center',
          justifyContent: 'space-between', borderBottom: '1px solid var(--color-border)',
        }}>
          <span style={{ fontWeight: 700, fontSize: 11, textTransform: 'uppercase',
                         letterSpacing: 0.5, color: 'var(--color-muted)' }}>
            Países
          </span>
          <button className="btn-add-row" style={{ height: 24, padding: '0 10px' }}
            onClick={addNewCountry} title="Agregar nuevo país">
            +
          </button>
        </div>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {allKeys.map(key => {
            const dbRow   = dbRows.find(r => r.country_key === key)
            const label   = draft[key]?.label ?? dbRow?.label ?? key
            const isActive = selectedKey === key
            const ro       = isReadOnly(key)
            return (
              <div
                key={key}
                onClick={() => { setSelectedKey(key); setSelectedCityIdx(null) }}
                style={{
                  padding: '8px 12px', cursor: 'pointer', fontSize: 13,
                  background: isActive ? 'rgba(229,57,53,0.07)' : 'transparent',
                  borderLeft: isActive ? '3px solid #e53935' : '3px solid transparent',
                  color: ro ? 'var(--color-muted)' : 'var(--color-text)',
                  fontStyle: ro ? 'italic' : 'normal',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  gap: 6,
                }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {label}
                </span>
                {ro && <span title="Configurado en código (solo lectura)" style={{ fontSize: 9, flexShrink: 0 }}>🔒</span>}
              </div>
            )
          })}
        </div>
      </div>

      {/* ── Panel 2: Country settings + City list ─────────────── */}
      <div style={{
        width: 290, borderRight: '1px solid var(--color-border)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden', flexShrink: 0,
      }}>
        {!selectedKey ? (
          <div style={{ padding: 20, color: 'var(--color-muted)', fontSize: 13 }}>
            Selecciona un país para ver su configuración.
          </div>
        ) : (
          <>
            {/* Country settings */}
            <div style={{
              padding: '12px 14px', borderBottom: '1px solid var(--color-border)',
              overflowY: 'auto',
            }}>
              <div style={{ fontWeight: 700, fontSize: 11, textTransform: 'uppercase',
                            letterSpacing: 0.5, color: 'var(--color-muted)', marginBottom: 6 }}>
                {readonly ? 'Vista previa (solo lectura 🔒)' : 'Datos del país'}
              </div>

              <label style={fieldLabelStyle}>Nombre / Label</label>
              <input
                style={inputStyle(readonly)}
                value={activeRow?.label || ''}
                disabled={readonly}
                onChange={e => setDraftField(selectedKey, 'label', e.target.value)}
              />

              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <label style={fieldLabelStyle}>Moneda</label>
                  <input style={inputStyle(readonly)} disabled={readonly}
                    value={activeRow?.currency || ''}
                    onChange={e => setDraftField(selectedKey, 'currency', e.target.value)}
                    placeholder="USD"
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={fieldLabelStyle}>Locale</label>
                  <input style={inputStyle(readonly)} disabled={readonly}
                    value={activeRow?.locale || ''}
                    onChange={e => setDraftField(selectedKey, 'locale', e.target.value)}
                    placeholder="en-US"
                  />
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <label style={fieldLabelStyle}>Umbral outlier</label>
                  <input type="number" style={inputStyle(readonly)} disabled={readonly}
                    value={activeRow?.outlier_threshold ?? 100}
                    onChange={e => setDraftField(selectedKey, 'outlier_threshold', e.target.value)}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={fieldLabelStyle}>Precio máx.</label>
                  <input type="number" style={inputStyle(readonly)} disabled={readonly}
                    value={activeRow?.max_price ?? 1000}
                    onChange={e => setDraftField(selectedKey, 'max_price', e.target.value)}
                  />
                </div>
              </div>

              {!readonly && (
                <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button className="btn-save-sm"
                    disabled={savingKey === selectedKey}
                    onClick={() => handleSave(selectedKey)}>
                    {savingKey === selectedKey ? 'Guardando…' : 'Guardar país'}
                  </button>
                  {isDbManaged(selectedKey) && (
                    <button className="btn-delete-sm"
                      onClick={() => handleDeleteCountry(selectedKey)}>
                      Eliminar
                    </button>
                  )}
                  {msg && (
                    <span style={{
                      fontSize: 11,
                      color: msg.type === 'ok' ? '#16a34a' : '#dc2626',
                    }}>
                      {msg.text}
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* City list */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div style={{
                padding: '8px 12px', display: 'flex', alignItems: 'center',
                justifyContent: 'space-between', borderBottom: '1px solid var(--color-border)',
              }}>
                <span style={{ fontWeight: 700, fontSize: 11, textTransform: 'uppercase',
                               letterSpacing: 0.5, color: 'var(--color-muted)' }}>
                  Ciudades
                </span>
                {!readonly && (
                  <button className="btn-add-row" style={{ height: 24, padding: '0 10px' }}
                    onClick={() => addCity(selectedKey)} title="Agregar ciudad">
                    +
                  </button>
                )}
              </div>
              <div style={{ overflowY: 'auto', flex: 1 }}>
                {activeCities.length === 0 && (
                  <div style={{ padding: '12px 14px', color: 'var(--color-muted)', fontSize: 12 }}>
                    Sin ciudades. {!readonly && 'Haz clic en + para agregar.'}
                  </div>
                )}
                {activeCities.map((city, idx) => (
                  <div
                    key={idx}
                    onClick={() => setSelectedCityIdx(idx)}
                    style={{
                      padding: '7px 12px', cursor: 'pointer', fontSize: 13,
                      background: selectedCityIdx === idx ? 'rgba(229,57,53,0.07)' : 'transparent',
                      borderLeft: selectedCityIdx === idx ? '3px solid #e53935' : '3px solid transparent',
                      display: 'flex', alignItems: 'center', gap: 6,
                    }}
                  >
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {city.uiName || <em style={{ color: 'var(--color-muted)' }}>(sin nombre)</em>}
                    </span>
                    {city.isVirtual && (
                      <span style={{ fontSize: 9, color: 'var(--color-muted)', flexShrink: 0 }}>virtual</span>
                    )}
                    {!readonly && (
                      <button
                        className="btn-delete-sm"
                        style={{ height: 18, padding: '0 6px', fontSize: 10, flexShrink: 0 }}
                        onClick={e => { e.stopPropagation(); deleteCity(selectedKey, idx) }}
                        title="Eliminar ciudad"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>

      {/* ── Panel 3: City detail — fields + categories/competitors ── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 18px', minWidth: 0 }}>
        {!activeCity ? (
          <div style={{ color: 'var(--color-muted)', fontSize: 13, paddingTop: 20 }}>
            Selecciona una ciudad para configurar sus categorías y competidores.
          </div>
        ) : (
          <>
            {/* City fields */}
            <div className="config-section" style={{ marginBottom: 14 }}>
              <h2 style={{ marginBottom: 8 }}>Datos de la ciudad</h2>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div style={{ minWidth: 130 }}>
                  <label style={fieldLabelStyle}>Nombre visible (UI)</label>
                  <input style={inputStyle(readonly)} disabled={readonly}
                    placeholder="Ej: Lima"
                    value={activeCity.uiName || ''}
                    onChange={e => setCity(selectedKey, selectedCityIdx, { ...activeCity, uiName: e.target.value })}
                  />
                </div>
                <div style={{ minWidth: 130 }}>
                  <label style={fieldLabelStyle}>Nombre en base de datos</label>
                  <input style={inputStyle(readonly)} disabled={readonly}
                    placeholder="Ej: Lima"
                    value={activeCity.dbName || ''}
                    onChange={e => setCity(selectedKey, selectedCityIdx, { ...activeCity, dbName: e.target.value })}
                  />
                </div>
                <div style={{ minWidth: 120 }}>
                  <label style={fieldLabelStyle}>Bot key (minúsculas)</label>
                  <input style={inputStyle(readonly)} disabled={readonly}
                    placeholder="Ej: lima"
                    value={activeCity.botKey || ''}
                    onChange={e => setCity(selectedKey, selectedCityIdx, { ...activeCity, botKey: e.target.value })}
                  />
                </div>
                <label style={{
                  display: 'flex', gap: 6, fontSize: 12, color: 'var(--color-muted)',
                  alignItems: 'center', paddingBottom: 6, cursor: readonly ? 'default' : 'pointer',
                }}>
                  <input
                    type="checkbox"
                    disabled={readonly}
                    checked={!!activeCity.isVirtual}
                    onChange={e => setCity(selectedKey, selectedCityIdx, { ...activeCity, isVirtual: e.target.checked })}
                    style={{ accentColor: '#e53935' }}
                  />
                  Ciudad virtual
                  <span title="Las ciudades virtuales no aparecen en el selector de la interfaz pero sí en los datos (ej: Aeropuerto, Corp)"
                    style={{ cursor: 'help', opacity: 0.6 }}>ⓘ</span>
                </label>
              </div>
            </div>

            {/* Categories + competitors */}
            <div className="config-section">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <h2 style={{ margin: 0 }}>Categorías y Competidores</h2>
                {!readonly && (
                  <button className="btn-add-row"
                    onClick={() => addCategory(selectedKey, selectedCityIdx)}>
                    + Agregar categoría
                  </button>
                )}
              </div>

              {(!activeCity.categories || activeCity.categories.length === 0) && (
                <div style={{ color: 'var(--color-muted)', fontSize: 12, padding: '8px 0' }}>
                  Sin categorías. {!readonly && 'Haz clic en "+ Agregar categoría" para comenzar.'}
                </div>
              )}

              {activeCity.categories?.map((cat, catIdx) => (
                <div key={catIdx} style={{
                  border: '1px solid var(--color-border-soft)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '10px 14px',
                  marginBottom: 10,
                  background: 'var(--color-bg)',
                }}>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 10 }}>
                    <div style={{ minWidth: 110 }}>
                      <label style={fieldLabelStyle}>Nombre UI</label>
                      <input style={{ ...inputStyle(readonly), width: 120 }}
                        placeholder="Economy"
                        disabled={readonly} value={cat.name || ''}
                        onChange={e => setCategoryField(selectedKey, selectedCityIdx, catIdx, 'name', e.target.value)}
                      />
                    </div>
                    <div style={{ minWidth: 110 }}>
                      <label style={fieldLabelStyle}>Nombre DB</label>
                      <input style={{ ...inputStyle(readonly), width: 120 }}
                        placeholder="Economy"
                        disabled={readonly} value={cat.dbName || ''}
                        onChange={e => setCategoryField(selectedKey, selectedCityIdx, catIdx, 'dbName', e.target.value)}
                      />
                    </div>
                    <div style={{ minWidth: 130 }}>
                      <label style={fieldLabelStyle}>Yango display name</label>
                      <input style={{ ...inputStyle(readonly), width: 150 }}
                        placeholder="Yango"
                        disabled={readonly} value={cat.yangoDisplayName || ''}
                        onChange={e => setCategoryField(selectedKey, selectedCityIdx, catIdx, 'yangoDisplayName', e.target.value)}
                      />
                    </div>
                    {!readonly && (
                      <button className="btn-delete-sm" style={{ marginBottom: 1 }}
                        onClick={() => deleteCategory(selectedKey, selectedCityIdx, catIdx)}>
                        ✕ Eliminar
                      </button>
                    )}
                  </div>

                  <label style={fieldLabelStyle}>Competidores</label>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 5 }}>
                    {cat.competitors.map(comp => (
                      <span key={comp} style={competitorTagStyle}>
                        {comp}
                        {!readonly && (
                          <button
                            onClick={() => removeCompetitor(selectedKey, selectedCityIdx, catIdx, comp)}
                            style={{
                              background: 'none', border: 'none', cursor: 'pointer',
                              color: '#dc2626', fontWeight: 700, marginLeft: 4,
                              padding: '0 2px', fontSize: 12, lineHeight: 1,
                            }}
                            title={`Quitar ${comp}`}
                          >
                            ×
                          </button>
                        )}
                      </span>
                    ))}
                    {!readonly && (
                      <CompetitorAdder
                        existing={cat.competitors}
                        onAdd={comp => addCompetitor(selectedKey, selectedCityIdx, catIdx, comp)}
                      />
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
