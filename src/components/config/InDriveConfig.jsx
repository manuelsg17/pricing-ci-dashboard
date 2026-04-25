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
// useMemo kept for summary/weekly client-side mapping

// Outlier threshold is now dynamic based on country configuration (cfgCountry.outlierThreshold)
import { sb } from '../../lib/supabase'
import { getCountryConfig } from '../../lib/constants'
import SaveStatusBanner from './SaveStatusBanner'


export default function InDriveConfig({ country }) {
  const cfgCountry = getCountryConfig(country)
  
  const CONFIG_ROWS = useMemo(() => {
    return cfgCountry.dbCities.flatMap(city => {
      const cats = cfgCountry.categoriesByCity?.[city] || []
      return cats.map(category => ({ city, category }))
    })
  }, [cfgCountry])

  const [analysisView, setAnalysisView] = useState('summary')  // 'summary' | 'weekly'

  // ── Estado de análisis histórico ─────────────────────────────
  const [summaryData,     setSummaryData]     = useState([])
  const [weeklyData,      setWeeklyData]      = useState([])
  const [counts,          setCounts]          = useState({ total_rows: 0, rows_with_bids: 0 })
  const [analysisLoading, setAnalysisLoading] = useState(true)
  const [analysisError,   setAnalysisError]   = useState(null)

  // ── Estado de config (ajustes) ───────────────────────────────
  const [config,    setConfig]    = useState({})
  const [original,  setOriginal]  = useState({})
  const [saving,    setSaving]    = useState(false)
  const [saveMsg,   setSaveMsg]   = useState(null)
  const [cfgLoaded, setCfgLoaded] = useState(false)

  // ── Cargar datos históricos via RPC (agrupado en el servidor) ──
  const loadAnalysis = useCallback(async () => {
    setAnalysisLoading(true)
    setAnalysisError(null)
    const threshold = cfgCountry.outlierThreshold || 100
    try {
      const [summaryRes, weeklyRes, countsRes] = await Promise.all([
        sb.rpc('get_indrive_summary', { outlier_threshold: threshold, p_country: country }),
        sb.rpc('get_indrive_weekly',  { outlier_threshold: threshold, p_country: country }),
        sb.rpc('get_indrive_counts',  { p_country: country }),
      ])
      if (summaryRes.error) throw summaryRes.error
      if (weeklyRes.error)  throw weeklyRes.error
      if (countsRes.error)  throw countsRes.error
      setSummaryData(summaryRes.data || [])
      setWeeklyData(weeklyRes.data   || [])
      setCounts(countsRes.data?.[0]  || { total_rows: 0, rows_with_bids: 0 })
    } catch (e) {
      setAnalysisError(e.message)
    } finally {
      setAnalysisLoading(false)
    }
  }, [country])

  useEffect(() => { loadAnalysis() }, [loadAnalysis])

  // ── Cargar config guardada ────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    async function loadCfg() {
      const { data } = await sb.from('indrive_config').select('city, category, adjustment_pct, note')
        .eq('country', country)
      if (cancelled) return
      if (data) {
        const map = {}
        data.forEach(r => {
          map[`${r.city}|${r.category}`] = { pct: r.adjustment_pct ?? 0, note: r.note ?? '' }
        })
        setConfig(map)
        setOriginal(JSON.parse(JSON.stringify(map)))
      }
      setCfgLoaded(true)
    }
    loadCfg()
    return () => { cancelled = true }
  }, [country])

  // summary y weekly ya vienen agregados del servidor (via RPC)
  // Solo calculamos pctDiff aquí ya que el RPC no lo incluye
  const summary = useMemo(() =>
    summaryData
      .filter(r => cfgCountry.dbCities.includes(r.city))
      .map(r => ({
        ...r,
        obsBids:     Number(r.obs_with_bids),
        outlierRecs: Number(r.outlier_recs),
        avgRec:  r.avg_rec  != null ? String(r.avg_rec)  : null,
        minRec:  r.min_rec  != null ? String(r.min_rec)  : null,
        maxRec:  r.max_rec  != null ? String(r.max_rec)  : null,
        avgBid:  r.avg_bid  != null ? String(r.avg_bid)  : null,
        pctDiff: (() => {
          const rec = Number(r.avg_rec)
          const bid = Number(r.avg_bid)
          if (!Number.isFinite(rec) || !Number.isFinite(bid) || rec === 0) return null
          return (((bid / rec) - 1) * 100).toFixed(1)
        })(),
      }))
  , [summaryData, cfgCountry.dbCities])

  const weekly = useMemo(() =>
    weeklyData
      .filter(r => cfgCountry.dbCities.includes(r.city))
      .map(r => ({
        ...r,
        obs:    Number(r.obs),
        avgRec: r.avg_rec != null ? String(r.avg_rec) : null,
        avgBid: r.avg_bid != null ? String(r.avg_bid) : null,
        pctDiff: (() => {
          const rec = Number(r.avg_rec)
          const bid = Number(r.avg_bid)
          if (!Number.isFinite(rec) || !Number.isFinite(bid) || rec === 0) return null
          return (((bid / rec) - 1) * 100).toFixed(1)
        })(),
      }))
  , [weeklyData, cfgCountry.dbCities])

  // ── Helpers config ────────────────────────────────────────────
  function getCfg(city, category) {
    return config[`${city}|${category}`] ?? { pct: 0, note: '' }
  }
  function setCfgField(city, category, field, value) {
    setSaveMsg(null)
    const key = `${city}|${category}`
    setConfig(prev => ({ ...prev, [key]: { ...getCfg(city, category), [field]: value } }))
  }

  function isCellDirty(city, category) {
    const key = `${city}|${category}`
    const cur  = config[key] ?? { pct: 0, note: '' }
    const orig = original[key] ?? { pct: 0, note: '' }
    return String(cur.pct ?? '') !== String(orig.pct ?? '')
        || String(cur.note ?? '') !== String(orig.note ?? '')
  }

  const hasUnsavedChanges = CONFIG_ROWS.some(({ city, category }) => isCellDirty(city, category))

  async function handleSave() {
    setSaving(true)
    setSaveMsg(null)
    try {
      // Solo guardar las filas que cambiaron
      const changed = CONFIG_ROWS.filter(({ city, category }) => isCellDirty(city, category))
      const upserts = changed.map(({ city, category }) => {
        const cfg = getCfg(city, category)
        return {
          country,
          city,
          category,
          adjustment_pct: parseFloat(cfg.pct) || 0,
          note:           cfg.note || null,
          updated_at:     new Date().toISOString(),
        }
      })
      if (upserts.length === 0) {
        setSaveMsg({ type: 'warn', text: 'No hay cambios para guardar.' })
        setSaving(false)
        return
      }
      const { error } = await sb
        .from('indrive_config')
        .upsert(upserts, { onConflict: 'country,city,category' })
      if (error) throw error

      // Sincronizar "original" con el estado actual y recargar análisis
      setOriginal(JSON.parse(JSON.stringify(config)))
      setSaveMsg({
        type: 'ok',
        text: `Configuración guardada (${upserts.length} ${upserts.length === 1 ? 'ajuste' : 'ajustes'}). Aplicando al bot…`,
      })
      // El trigger DB recalcula automáticamente los precios del bot para esas city+category.
      // Recargamos el análisis para reflejar el impacto.
      await loadAnalysis()
    } catch (e) {
      setSaveMsg({ type: 'err', text: 'Error al guardar: ' + e.message })
    } finally {
      setSaving(false)
    }
  }

  function handleDiscardAll() {
    setSaveMsg(null)
    setConfig(JSON.parse(JSON.stringify(original)))
  }

  const DIRTY_STYLE = {
    background:  '#fef3c7',
    borderColor: '#f59e0b',
    fontWeight:  600,
    boxShadow:   '0 0 0 2px rgba(245, 158, 11, 0.2)',
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
          Solo datos manuales (hubs) con bids registrados. Precios rec. &gt; {cfgCountry.currency} {(cfgCountry.outlierThreshold || 100)} se excluyen del cálculo de promedio como outliers.
          {' '}· Total en BD: <strong>{counts.total_rows}</strong> | Con bids: <strong>{counts.rows_with_bids}</strong> | Sin bids: <strong style={{ color: (counts.total_rows - counts.rows_with_bids) > 0 ? '#dc2626' : 'inherit' }}>{counts.total_rows - counts.rows_with_bids}</strong>
          {summary.some(r => r.outlierRecs > 0) && (
            <> · <span style={{ color: '#dc2626' }}>⚠ {summary.reduce((s, r) => s + r.outlierRecs, 0)} precios rec. outlier (&gt; {cfgCountry.currency} {(cfgCountry.outlierThreshold || 100)}) excluidos del promedio.</span></>
          )}
        </p>

        {analysisLoading && <div className="state-box">Calculando análisis…</div>}
        {analysisError   && <div className="state-box state-box--error">Error: {analysisError}</div>}

        {!analysisLoading && !analysisError && summary.length === 0 && (
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

        {!analysisLoading && !analysisError && summary.length > 0 && (
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
                        {r.avgRec != null ? `${cfgCountry.currency} ${r.avgRec}` : '—'}
                      </td>
                      <td style={{ textAlign: 'right', color: '#9ca3af', fontSize: 11 }}>
                        {r.minRec != null ? `${cfgCountry.currency} ${r.minRec}` : '—'}
                      </td>
                      <td style={{ textAlign: 'right', color: r.outlierRecs > 0 ? '#dc2626' : '#9ca3af', fontSize: 11 }}>
                        {r.maxRec != null ? `${cfgCountry.currency} ${r.maxRec}` : '—'}
                        {r.outlierRecs > 0 && <span title={`${r.outlierRecs} precios > ${cfgCountry.currency} ${(cfgCountry.outlierThreshold || 100)} excluidos`}> ⚠</span>}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {r.avgBid != null ? `${cfgCountry.currency} ${r.avgBid}` : '—'}
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
                        <td style={{ textAlign: 'right' }}>{r.avgRec != null ? `${cfgCountry.currency} ${r.avgRec}` : '—'}</td>
                        <td style={{ textAlign: 'right' }}>{r.avgBid != null ? `${cfgCountry.currency} ${r.avgBid}` : '—'}</td>
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
            {hasUnsavedChanges && (
              <div style={{
                marginTop: 8, marginBottom: 12,
                padding: '10px 14px', borderRadius: 6,
                background: '#fef3c7', border: '1px solid #f59e0b',
                color: '#78350f', fontSize: 13, fontWeight: 500,
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
              }}>
                <span>⚠ Hay cambios sin guardar en los ajustes de InDrive</span>
                <button type="button" onClick={handleDiscardAll} style={{
                  background: 'transparent', border: '1px solid #b45309', color: '#78350f',
                  padding: '4px 10px', borderRadius: 4, fontSize: 12, cursor: 'pointer',
                }}>
                  Descartar cambios
                </button>
              </div>
            )}

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
                  const dirty = isCellDirty(city, category)
                  return (
                    <tr key={`${city}|${category}`} style={dirty ? { background: '#fffbeb' } : undefined}>
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
                              ...(dirty ? DIRTY_STYLE : {}),
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
                            ...(dirty ? DIRTY_STYLE : {}),
                          }}
                        />
                      </td>
                      <td style={{ textAlign: 'center', color: '#888', fontSize: 12 }}>
                        {hist?.pctDiff != null
                          ? <span title={`${hist.obsBids} obs. con bids (avg rec ${cfgCountry.currency}${hist.avgRec})`}>
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

            <div style={{ marginTop: 14 }}>
              <button
                className="btn-save"
                onClick={handleSave}
                disabled={saving || !hasUnsavedChanges}
                title={!hasUnsavedChanges ? 'No hay cambios para guardar' : undefined}
              >
                {saving ? 'Guardando…' : '💾 Guardar ajustes'}
              </button>
              <SaveStatusBanner status={saveMsg} onDismiss={() => setSaveMsg(null)} />
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
