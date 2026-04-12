/**
 * InDriveConfig.jsx
 *
 * Dos secciones:
 * 1. Análisis histórico — calcula cuánto varía el promedio de bids
 *    vs el precio recomendado, usando solo datos ingresados por hubs (data_source='manual').
 *    Vista general (por ciudad/categoría) y vista semanal.
 * 2. Configuración de ajuste — el usuario define el % a aplicar
 *    para estimar el precio efectivo en datos del bot (que no captura bids).
 */

import { useState, useEffect, useMemo, useCallback } from 'react'

const OUTLIER_THRESHOLD = 100  // PEN — precios por encima se excluyen del análisis estadístico
import { sb } from '../../lib/supabase'

// Combinaciones para la sección de config (editable por el usuario)
const CONFIG_ROWS = [
  { city: 'Lima',     category: 'Economy'  },
  { city: 'Lima',     category: 'Comfort'  },
  { city: 'Lima',     category: 'Premier'  },
  { city: 'Lima',     category: 'XL'       },
  { city: 'Lima',     category: 'TukTuk'   },
  { city: 'Trujillo', category: 'Economy'  },
  { city: 'Trujillo', category: 'Comfort'  },
  { city: 'Arequipa', category: 'Economy'  },
  { city: 'Arequipa', category: 'Comfort'  },
]

// Calcula promedio de bids (ignora nulos y ceros)
function avgBids(row) {
  const bids = [row.bid_1, row.bid_2, row.bid_3, row.bid_4, row.bid_5]
    .filter(b => b != null && b > 0)
  if (!bids.length) return null
  return bids.reduce((a, b) => a + b, 0) / bids.length
}

// ISO week desde fecha "YYYY-MM-DD"
function isoWeek(dateStr) {
  if (!dateStr) return null
  const d   = new Date(dateStr + 'T12:00:00')
  const day = d.getDay() || 7
  d.setDate(d.getDate() + 4 - day)
  const yearStart = new Date(d.getFullYear(), 0, 1)
  return `${d.getFullYear()}-W${String(Math.ceil(((d - yearStart) / 86400000 + 1) / 7)).padStart(2, '0')}`
}

export default function InDriveConfig() {
  const [analysisView, setAnalysisView] = useState('summary')  // 'summary' | 'weekly'

  // ── Estado de análisis histórico ─────────────────────────────
  const [analysisData,    setAnalysisData]    = useState([])
  const [analysisLoading, setAnalysisLoading] = useState(true)
  const [analysisError,   setAnalysisError]   = useState(null)

  // ── Estado de config (ajustes) ───────────────────────────────
  const [config,    setConfig]    = useState({})
  const [saving,    setSaving]    = useState(false)
  const [saveMsg,   setSaveMsg]   = useState(null)
  const [cfgLoaded, setCfgLoaded] = useState(false)

  // ── Cargar datos históricos de la BD ─────────────────────────
  const loadAnalysis = useCallback(async () => {
    setAnalysisLoading(true)
    setAnalysisError(null)
    try {
      // Datos manuales InDrive — sin filtrar por rec_price para no excluir Lima u otras ciudades
      const { data, error } = await sb
        .from('pricing_observations')
        .select('city, category, observed_date, recommended_price, bid_1, bid_2, bid_3, bid_4, bid_5')
        .eq('competition_name', 'InDrive')
        .eq('data_source', 'manual')
        .limit(50000)

      if (error) throw error
      setAnalysisData(data || [])
    } catch (e) {
      setAnalysisError(e.message)
    } finally {
      setAnalysisLoading(false)
    }
  }, [])

  useEffect(() => { loadAnalysis() }, [loadAnalysis])

  // ── Cargar config guardada ────────────────────────────────────
  useEffect(() => {
    async function loadCfg() {
      const { data } = await sb.from('indrive_config').select('city, category, adjustment_pct, note')
      if (data) {
        const map = {}
        data.forEach(r => {
          map[`${r.city}|${r.category}`] = { pct: r.adjustment_pct ?? 0, note: r.note ?? '' }
        })
        setConfig(map)
      }
      setCfgLoaded(true)
    }
    loadCfg()
  }, [])

  // ── Análisis: filtrar filas con bids válidos (rec_price puede ser null) ──
  const analysisRows = useMemo(() =>
    analysisData.filter(r => avgBids(r) !== null),
  [analysisData])

  // Filas excluidas del análisis (sin bids)
  const noBidsCount = useMemo(() =>
    analysisData.length - analysisRows.length,
  [analysisData, analysisRows])

  // ── Análisis summary: agrupar por ciudad+categoría ─────────────
  const summary = useMemo(() => {
    const groups = {}
    for (const row of analysisRows) {
      const key = `${row.city}|${row.category}`
      if (!groups[key]) groups[key] = {
        city: row.city, category: row.category,
        recs: [], bids: [], outlierRecs: 0,
      }
      const rec = parseFloat(row.recommended_price)
      const bid = avgBids(row)
      groups[key].bids.push(bid)
      if (!isNaN(rec) && rec > 0 && rec <= OUTLIER_THRESHOLD) {
        groups[key].recs.push(rec)
      } else if (!isNaN(rec) && rec > OUTLIER_THRESHOLD) {
        groups[key].outlierRecs++
      }
    }
    return Object.values(groups).map(g => {
      const avgRec  = g.recs.length ? g.recs.reduce((a, b) => a + b, 0) / g.recs.length : null
      const avgBid  = g.bids.length ? g.bids.reduce((a, b) => a + b, 0) / g.bids.length : null
      const pctDiff = avgRec && avgBid ? ((avgBid / avgRec) - 1) * 100 : null
      const minRec  = g.recs.length ? Math.min(...g.recs) : null
      const maxRec  = g.recs.length ? Math.max(...g.recs) : null
      return {
        city: g.city, category: g.category,
        obsBids:     g.bids.length,
        outlierRecs: g.outlierRecs,
        avgRec:  avgRec?.toFixed(2) ?? null,
        minRec:  minRec?.toFixed(2) ?? null,
        maxRec:  maxRec?.toFixed(2) ?? null,
        avgBid:  avgBid?.toFixed(2) ?? null,
        pctDiff: pctDiff?.toFixed(1) ?? null,
      }
    }).sort((a, b) => a.city.localeCompare(b.city) || a.category.localeCompare(b.category))
  }, [analysisRows])

  // ── Análisis semanal: agrupar por ciudad+categoría+semana ──────
  const weekly = useMemo(() => {
    const groups = {}
    for (const row of analysisRows) {
      const week = isoWeek(row.observed_date)
      if (!week) continue
      const key = `${row.city}|${row.category}|${week}`
      if (!groups[key]) groups[key] = { city: row.city, category: row.category, week, recs: [], bids: [] }
      const rec = parseFloat(row.recommended_price)
      if (!isNaN(rec) && rec > 0 && rec <= OUTLIER_THRESHOLD) groups[key].recs.push(rec)
      groups[key].bids.push(avgBids(row))
    }
    return Object.values(groups).map(g => {
      const avgRec  = g.recs.length ? g.recs.reduce((a, b) => a + b, 0) / g.recs.length : null
      const avgBid  = g.bids.length ? g.bids.reduce((a, b) => a + b, 0) / g.bids.length : null
      const pctDiff = avgRec && avgBid ? ((avgBid / avgRec) - 1) * 100 : null
      return {
        city: g.city, category: g.category, week: g.week,
        obs:     g.bids.length,
        avgRec:  avgRec?.toFixed(2) ?? null,
        avgBid:  avgBid?.toFixed(2) ?? null,
        pctDiff: pctDiff?.toFixed(1) ?? null,
      }
    }).sort((a, b) =>
      a.city.localeCompare(b.city) || a.category.localeCompare(b.category) || b.week.localeCompare(a.week)
    )
  }, [analysisRows])

  // ── Helpers config ────────────────────────────────────────────
  function getCfg(city, category) {
    return config[`${city}|${category}`] ?? { pct: 0, note: '' }
  }
  function setCfgField(city, category, field, value) {
    const key = `${city}|${category}`
    setConfig(prev => ({ ...prev, [key]: { ...getCfg(city, category), [field]: value } }))
  }

  async function handleSave() {
    setSaving(true)
    setSaveMsg(null)
    try {
      const upserts = CONFIG_ROWS.map(({ city, category }) => {
        const cfg = getCfg(city, category)
        return {
          city,
          category,
          adjustment_pct: parseFloat(cfg.pct) || 0,
          note:           cfg.note || null,
          updated_at:     new Date().toISOString(),
        }
      })
      const { error } = await sb
        .from('indrive_config')
        .upsert(upserts, { onConflict: 'city,category' })
      if (error) throw error
      setSaveMsg({ type: 'ok', text: '✓ Configuración guardada' })
    } catch (e) {
      setSaveMsg({ type: 'err', text: 'Error al guardar: ' + e.message })
    } finally {
      setSaving(false)
    }
  }

  // ── Render ────────────────────────────────────────────────────
  return (
    <div>
      {/* ── Sección 1: Análisis histórico ── */}
      <div className="config-section">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>Análisis histórico — Bids vs Precio recomendado</h2>
          <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
            <button
              onClick={() => loadAnalysis()}
              disabled={analysisLoading}
              style={{ padding: '5px 10px', border: '1px solid #d1d5db', borderRadius: 4, background: '#f9fafb', cursor: 'pointer', fontSize: 12 }}
              title="Recargar datos"
            >
              ↻ Recargar
            </button>
            <button
              onClick={() => setAnalysisView('summary')}
              style={tabBtnStyle(analysisView === 'summary')}
            >
              Por ciudad/cat
            </button>
            <button
              onClick={() => setAnalysisView('weekly')}
              style={tabBtnStyle(analysisView === 'weekly')}
            >
              Por semana
            </button>
          </div>
        </div>
        <p style={{ fontSize: 12, color: '#666', marginBottom: 12 }}>
          Solo datos manuales (hubs) con bids registrados. Precios rec. &gt; S/{OUTLIER_THRESHOLD} se excluyen del cálculo de promedio como outliers.
          {noBidsCount > 0 && <> · {noBidsCount} filas sin bids excluidas del análisis.</>}
          {summary.some(r => r.outlierRecs > 0) && (
            <> · <span style={{ color: '#dc2626' }}>⚠ {summary.reduce((s, r) => s + r.outlierRecs, 0)} precios rec. outlier (&gt; S/{OUTLIER_THRESHOLD}) excluidos del promedio.</span></>
          )}
        </p>

        {analysisLoading && <div className="state-box">Calculando análisis…</div>}
        {analysisError   && <div className="state-box state-box--error">Error: {analysisError}</div>}

        {!analysisLoading && !analysisError && analysisRows.length === 0 && (
          <div className="state-box">
            Sin datos manuales de InDrive con bids aún.
            Una vez que los hubs ingresen observaciones con bids, aquí aparecerá el análisis.
            <br />
            <em style={{ fontSize: 11, color: '#888' }}>
              Nota: si Lima no aparece, significa que aún no hay datos manuales de InDrive para Lima
              (el dato del bot no cuenta porque el bot no captura bids).
            </em>
          </div>
        )}

        {!analysisLoading && !analysisError && analysisRows.length > 0 && (
          <>
            {analysisView === 'summary' && (
              <table className="config-table">
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left' }}>Ciudad</th>
                    <th style={{ textAlign: 'left' }}>Categoría</th>
                    <th>Obs. con bids</th>
                    <th>Avg rec.</th>
                    <th>Rec. mín</th>
                    <th>Rec. máx</th>
                    <th>Avg bids</th>
                    <th>Diferencia %</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.map(r => (
                    <tr key={`${r.city}|${r.category}`}>
                      <td style={{ textAlign: 'left', fontWeight: 600 }}>{r.city}</td>
                      <td style={{ textAlign: 'left' }}>{r.category}</td>
                      <td style={{ textAlign: 'right' }}>{r.obsBids.toLocaleString()}</td>
                      <td style={{ textAlign: 'right' }}>
                        {r.avgRec != null ? `S/ ${r.avgRec}` : '—'}
                      </td>
                      <td style={{ textAlign: 'right', color: '#9ca3af', fontSize: 11 }}>
                        {r.minRec != null ? `S/ ${r.minRec}` : '—'}
                      </td>
                      <td style={{ textAlign: 'right', color: r.outlierRecs > 0 ? '#dc2626' : '#9ca3af', fontSize: 11 }}>
                        {r.maxRec != null ? `S/ ${r.maxRec}` : '—'}
                        {r.outlierRecs > 0 && <span title={`${r.outlierRecs} precios > S/${OUTLIER_THRESHOLD} excluidos`}> ⚠</span>}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {r.avgBid != null ? `S/ ${r.avgBid}` : '—'}
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 700 }}>
                        {r.pctDiff != null ? (
                          <span style={{ color: Math.abs(parseFloat(r.pctDiff)) > 80 ? '#dc2626' : parseFloat(r.pctDiff) > 0 ? '#166534' : '#991b1b' }}>
                            {parseFloat(r.pctDiff) > 0 ? '+' : ''}{r.pctDiff}%
                            {Math.abs(parseFloat(r.pctDiff)) > 80 && (
                              <span title="Diferencia extrema — posibles outliers en precio recomendado"> ⚠</span>
                            )}
                          </span>
                        ) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {analysisView === 'weekly' && (
              <div style={{ maxHeight: 420, overflowY: 'auto' }}>
                <table className="config-table">
                  <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
                    <tr>
                      <th style={{ textAlign: 'left' }}>Ciudad</th>
                      <th style={{ textAlign: 'left' }}>Categoría</th>
                      <th style={{ textAlign: 'left' }}>Semana</th>
                      <th>Obs.</th>
                      <th>Avg rec.</th>
                      <th>Avg bids</th>
                      <th>Diferencia %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {weekly.map((r, i) => (
                      <tr key={i}>
                        <td style={{ textAlign: 'left', fontWeight: 600 }}>{r.city}</td>
                        <td style={{ textAlign: 'left' }}>{r.category}</td>
                        <td style={{ textAlign: 'left', fontFamily: 'monospace', fontSize: 11 }}>{r.week}</td>
                        <td style={{ textAlign: 'right' }}>{r.obs}</td>
                        <td style={{ textAlign: 'right' }}>{r.avgRec != null ? `S/ ${r.avgRec}` : '—'}</td>
                        <td style={{ textAlign: 'right' }}>{r.avgBid != null ? `S/ ${r.avgBid}` : '—'}</td>
                        <td style={{ textAlign: 'right', fontWeight: 700 }}>
                          {r.pctDiff != null ? (
                            <span style={{ color: Math.abs(parseFloat(r.pctDiff)) > 80 ? '#dc2626' : parseFloat(r.pctDiff) > 0 ? '#166534' : '#991b1b' }}>
                              {parseFloat(r.pctDiff) > 0 ? '+' : ''}{r.pctDiff}%
                              {Math.abs(parseFloat(r.pctDiff)) > 80 && ' ⚠'}
                            </span>
                          ) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Sección 2: Configuración de ajuste ── */}
      <div className="config-section" style={{ marginTop: 24 }}>
        <h2>Configuración de ajuste — Datos del bot</h2>
        <p style={{ fontSize: 12, color: '#666', marginBottom: 12 }}>
          Define el % a aplicar al precio recomendado de InDrive en datos ingresados por el bot.
          <strong> Solo aplica a datos del bot</strong> — la data de hubs ya incluye los bids reales.
          <br />
          Fórmula: <code>precio_estimado = precio_recomendado × (1 + ajuste%/100)</code>
        </p>

        {!cfgLoaded && <div className="state-box">Cargando configuración…</div>}

        {cfgLoaded && (
          <>
            <table className="config-table">
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>Ciudad</th>
                  <th style={{ textAlign: 'left' }}>Categoría</th>
                  <th>% Ajuste</th>
                  <th style={{ textAlign: 'left', minWidth: 200 }}>Nota (opcional)</th>
                  <th>Ref. histórica</th>
                </tr>
              </thead>
              <tbody>
                {CONFIG_ROWS.map(({ city, category }) => {
                  const cfg  = getCfg(city, category)
                  const hist = summary.find(a => a.city === city && a.category === category)
                  return (
                    <tr key={`${city}|${category}`}>
                      <td style={{ textAlign: 'left', fontWeight: 600 }}>{city}</td>
                      <td style={{ textAlign: 'left' }}>{category}</td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, justifyContent: 'center' }}>
                          <input
                            type="number"
                            step="0.1"
                            min="-50"
                            max="100"
                            value={cfg.pct}
                            onChange={e => setCfgField(city, category, 'pct', e.target.value)}
                            style={{
                              width: 70, textAlign: 'right',
                              padding: '4px 6px', border: '1.5px solid #d1d5db',
                              borderRadius: 4, fontSize: 13,
                            }}
                          />
                          <span style={{ color: '#666', fontSize: 12 }}>%</span>
                        </div>
                      </td>
                      <td>
                        <input
                          type="text"
                          value={cfg.note}
                          onChange={e => setCfgField(city, category, 'note', e.target.value)}
                          placeholder="ej: basado en sem. 12-2026"
                          style={{
                            width: '100%', padding: '4px 6px',
                            border: '1.5px solid #d1d5db',
                            borderRadius: 4, fontSize: 12,
                          }}
                        />
                      </td>
                      <td style={{ textAlign: 'center', color: '#888', fontSize: 12 }}>
                        {hist?.pctDiff != null
                          ? <span title={`${hist.obsBids} obs. con bids (avg rec S/${hist.avgRec})`}>
                              {parseFloat(hist.pctDiff) > 0 ? '+' : ''}{hist.pctDiff}%
                            </span>
                          : <span title="Sin datos históricos">—</span>
                        }
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>

            <div style={{ marginTop: 14, display: 'flex', gap: 12, alignItems: 'center' }}>
              <button
                className="btn-save"
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? 'Guardando…' : '💾 Guardar ajustes'}
              </button>
              {saveMsg && (
                <span style={{
                  fontSize: 13,
                  color: saveMsg.type === 'ok' ? '#166534' : '#991b1b',
                  fontWeight: 600,
                }}>
                  {saveMsg.text}
                </span>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function tabBtnStyle(active) {
  return {
    padding: '4px 12px',
    border: '1px solid #d1d5db',
    borderRadius: 4,
    fontSize: 12,
    cursor: 'pointer',
    fontWeight: active ? 700 : 400,
    background: active ? 'var(--color-yango)' : '#f9fafb',
    color: active ? '#fff' : '#374151',
  }
}
