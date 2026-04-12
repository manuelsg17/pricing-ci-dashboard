/**
 * InDriveConfig.jsx
 *
 * Dos secciones:
 * 1. Análisis histórico — calcula cuánto varía el promedio de bids
 *    vs el precio recomendado, usando solo datos ingresados por hubs (data_source='manual').
 * 2. Configuración de ajuste — el usuario define el % a aplicar
 *    para estimar el precio efectivo en datos del bot (que no captura bids).
 */

import { useState, useEffect, useMemo } from 'react'
import { sb } from '../../lib/supabase'

const CITY_CATEGORIES = {
  Lima:     ['Economy', 'Comfort', 'Premier', 'XL', 'TukTuk'],
  Trujillo: ['Economy', 'Comfort'],
  Arequipa: ['Economy', 'Comfort'],
}

const ALL_ROWS = Object.entries(CITY_CATEGORIES).flatMap(([city, cats]) =>
  cats.map(category => ({ city, category }))
)

// Calcula promedio de bids (ignora nulos y ceros)
function avgBids(row) {
  const bids = [row.bid_1, row.bid_2, row.bid_3, row.bid_4, row.bid_5]
    .filter(b => b != null && b > 0)
  if (!bids.length) return null
  return bids.reduce((a, b) => a + b, 0) / bids.length
}

export default function InDriveConfig() {
  // ── Estado de análisis histórico ─────────────────────────────
  const [analysisData, setAnalysisData] = useState([])  // filas de pricing_observations
  const [analysisLoading, setAnalysisLoading] = useState(true)
  const [analysisError,   setAnalysisError]   = useState(null)

  // ── Estado de config (ajustes) ───────────────────────────────
  const [config,   setConfig]   = useState({})   // { "Lima|Economy": 0.0, ... }
  const [saving,   setSaving]   = useState(false)
  const [saveMsg,  setSaveMsg]  = useState(null)
  const [cfgLoaded, setCfgLoaded] = useState(false)

  // ── Cargar datos históricos de la BD ─────────────────────────
  useEffect(() => {
    async function load() {
      setAnalysisLoading(true)
      setAnalysisError(null)
      try {
        // Solo datos manuales InDrive que tengan al menos un bid
        const { data, error } = await sb
          .from('pricing_observations')
          .select('city, category, recommended_price, bid_1, bid_2, bid_3, bid_4, bid_5')
          .eq('competition_name', 'InDrive')
          .eq('data_source', 'manual')
          .not('recommended_price', 'is', null)
          .gt('recommended_price', 0)
          .limit(20000)

        if (error) throw error
        setAnalysisData(data || [])
      } catch (e) {
        setAnalysisError(e.message)
      } finally {
        setAnalysisLoading(false)
      }
    }
    load()
  }, [])

  // ── Cargar config guardada ────────────────────────────────────
  useEffect(() => {
    async function loadCfg() {
      const { data } = await sb.from('indrive_config').select('city, category, adjustment_pct, note')
      if (data) {
        const map = {}
        data.forEach(r => { map[`${r.city}|${r.category}`] = { pct: r.adjustment_pct ?? 0, note: r.note ?? '' } })
        setConfig(map)
      }
      setCfgLoaded(true)
    }
    loadCfg()
  }, [])

  // ── Análisis: agrupar por ciudad+categoría ─────────────────────
  const analysis = useMemo(() => {
    const groups = {}
    for (const row of analysisData) {
      const key = `${row.city}|${row.category}`
      if (!groups[key]) groups[key] = { city: row.city, category: row.category, recs: [], bids: [] }
      groups[key].recs.push(row.recommended_price)
      const b = avgBids(row)
      if (b != null) groups[key].bids.push(b)
    }
    return Object.values(groups).map(g => {
      const avgRec = g.recs.length ? g.recs.reduce((a, b) => a + b, 0) / g.recs.length : null
      const avgBid = g.bids.length ? g.bids.reduce((a, b) => a + b, 0) / g.bids.length : null
      const pctDiff = avgRec && avgBid ? ((avgBid / avgRec) - 1) * 100 : null
      return {
        city:     g.city,
        category: g.category,
        obsTotal: g.recs.length,
        obsBids:  g.bids.length,
        avgRec:   avgRec?.toFixed(2) ?? null,
        avgBid:   avgBid?.toFixed(2) ?? null,
        pctDiff:  pctDiff?.toFixed(1) ?? null,
      }
    }).sort((a, b) => a.city.localeCompare(b.city) || a.category.localeCompare(b.category))
  }, [analysisData])

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
      const upserts = ALL_ROWS.map(({ city, category }) => {
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
        <h2>Análisis histórico — Bids vs Precio recomendado</h2>
        <p style={{ fontSize: 12, color: '#666', marginBottom: 12 }}>
          Calculado a partir de observaciones manuales (ingresadas por hubs) que incluyen bids.
          Muestra cuánto varía en promedio el precio efectivo (promedio de bids) respecto al precio recomendado del bot.
          Esta variación es la referencia para configurar el ajuste a aplicar a datos del bot.
        </p>

        {analysisLoading && <div className="state-box">Calculando análisis…</div>}
        {analysisError   && <div className="state-box state-box--error">Error: {analysisError}</div>}

        {!analysisLoading && !analysisError && (
          analysis.length === 0 ? (
            <div className="state-box">
              Sin datos manuales de InDrive con bids aún.
              Una vez que los hubs ingresen observaciones con los 5 bids, aquí aparecerá el análisis.
            </div>
          ) : (
            <table className="config-table">
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>Ciudad</th>
                  <th style={{ textAlign: 'left' }}>Categoría</th>
                  <th>Obs. totales</th>
                  <th>Obs. con bids</th>
                  <th>Avg precio rec.</th>
                  <th>Avg bids</th>
                  <th>Diferencia %</th>
                </tr>
              </thead>
              <tbody>
                {analysis.map(r => (
                  <tr key={`${r.city}|${r.category}`}>
                    <td style={{ textAlign: 'left', fontWeight: 600 }}>{r.city}</td>
                    <td style={{ textAlign: 'left' }}>{r.category}</td>
                    <td style={{ textAlign: 'right' }}>{r.obsTotal.toLocaleString()}</td>
                    <td style={{ textAlign: 'right' }}>{r.obsBids.toLocaleString()}</td>
                    <td style={{ textAlign: 'right' }}>
                      {r.avgRec != null ? `S/ ${r.avgRec}` : '—'}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {r.avgBid != null ? `S/ ${r.avgBid}` : '—'}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 700 }}>
                      {r.pctDiff != null ? (
                        <span style={{ color: parseFloat(r.pctDiff) > 0 ? '#166534' : '#991b1b' }}>
                          {parseFloat(r.pctDiff) > 0 ? '+' : ''}{r.pctDiff}%
                        </span>
                      ) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}
      </div>

      {/* ── Sección 2: Configuración de ajuste ── */}
      <div className="config-section" style={{ marginTop: 24 }}>
        <h2>Configuración de ajuste — Datos del bot</h2>
        <p style={{ fontSize: 12, color: '#666', marginBottom: 12 }}>
          Define el % a aplicar al precio recomendado de InDrive en datos ingresados por el bot
          para estimar el precio efectivo (promedio de bids).
          <strong> Solo aplica a datos del bot</strong> — la data ingresada por hubs ya incluye los bids reales.
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
                {ALL_ROWS.map(({ city, category }) => {
                  const cfg  = getCfg(city, category)
                  const hist = analysis.find(a => a.city === city && a.category === category)
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
                          ? <span title={`${hist.obsBids} obs. con bids`}>
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
