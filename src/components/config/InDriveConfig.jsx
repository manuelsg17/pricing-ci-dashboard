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
import { AlertTriangle, Save } from 'lucide-react'
// useMemo kept for summary/weekly client-side mapping

// Outlier threshold is now dynamic based on country configuration (cfgCountry.outlierThreshold)
import { sb } from '../../lib/supabase'
import { getCountryConfig } from '../../lib/constants'
import { computeRecentRef } from '../../algorithms/indriveRef'
import SaveStatusBanner from './SaveStatusBanner'
import { useConfirm } from '../ui/ConfirmDialog'
import { useCountry } from '../../context/CountryContext'
import { useI18n } from '../../context/LanguageContext'
import { Button } from '../ui/shadcn/button'

export default function InDriveConfig({ country }) {
  const confirm = useConfirm()
  const { dbConfigs } = useCountry()
  const cfgCountry = getCountryConfig(country, dbConfigs)
  const { t } = useI18n()

  const CONFIG_ROWS = useMemo(() => {
    return cfgCountry.dbCities.flatMap((city) => {
      const cats = cfgCountry.categoriesByCity?.[city] || []
      return cats.map((category) => ({ city, category }))
    })
  }, [cfgCountry])

  const [analysisView, setAnalysisView] = useState('summary') // 'summary' | 'weekly'
  // Ventana para la "Ref. reciente" del editor de ajuste: nº de semanas o 'all'
  const [refWindow, setRefWindow] = useState(1)

  // ── Estado de análisis histórico ─────────────────────────────
  const [summaryData, setSummaryData] = useState([])
  const [weeklyData, setWeeklyData] = useState([])
  const [counts, setCounts] = useState({ total_rows: 0, rows_with_bids: 0 })
  const [analysisLoading, setAnalysisLoading] = useState(true)
  const [analysisError, setAnalysisError] = useState(null)

  // ── Estado de config (ajustes) ───────────────────────────────
  const [config, setConfig] = useState({})
  const [original, setOriginal] = useState({})
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState(null)
  const [cfgLoaded, setCfgLoaded] = useState(false)

  // ── Cargar datos históricos via RPC (agrupado en el servidor) ──
  const loadAnalysis = useCallback(async () => {
    setAnalysisLoading(true)
    setAnalysisError(null)
    const threshold = cfgCountry.outlierThreshold || 100
    try {
      const [summaryRes, weeklyRes, countsRes] = await Promise.all([
        sb.rpc('get_indrive_summary', { outlier_threshold: threshold, p_country: country }),
        sb.rpc('get_indrive_weekly', { outlier_threshold: threshold, p_country: country }),
        sb.rpc('get_indrive_counts', { p_country: country }),
      ])
      if (summaryRes.error) throw summaryRes.error
      if (weeklyRes.error) throw weeklyRes.error
      if (countsRes.error) throw countsRes.error
      setSummaryData(summaryRes.data || [])
      setWeeklyData(weeklyRes.data || [])
      setCounts(countsRes.data?.[0] || { total_rows: 0, rows_with_bids: 0 })
    } catch (e) {
      setAnalysisError(e.message)
    } finally {
      setAnalysisLoading(false)
    }
  }, [country, cfgCountry.outlierThreshold])

  useEffect(() => {
    loadAnalysis()
  }, [loadAnalysis])

  // ── Cargar config guardada ────────────────────────────────────
  const loadCfg = useCallback(
    async ({ preserveDirty = false } = {}) => {
      const { data } = await sb
        .from('indrive_config')
        .select('city, category, adjustment_pct, note')
        .eq('country', country)
      if (!data) {
        setCfgLoaded(true)
        return
      }
      const freshMap = {}
      data.forEach((r) => {
        freshMap[`${r.city}|${r.category}`] = { pct: r.adjustment_pct ?? 0, note: r.note ?? '' }
      })
      if (preserveDirty) {
        // Mergear: por cada celda, si el user tenía dirty edit, conservar la
        // versión del usuario. Si no, tomar la fresh del server. Mismo
        // patrón que AirportMarkersTable adaptado a config-map.
        setConfig((prev) => {
          const merged = { ...freshMap }
          Object.keys(prev).forEach((key) => {
            const cur = prev[key] ?? { pct: 0, note: '' }
            const orig = original[key] ?? { pct: 0, note: '' }
            const dirty =
              String(cur.pct ?? '') !== String(orig.pct ?? '') ||
              String(cur.note ?? '') !== String(orig.note ?? '')
            if (dirty) merged[key] = cur
          })
          return merged
        })
      } else {
        setConfig(freshMap)
      }
      setOriginal(JSON.parse(JSON.stringify(freshMap)))
      setCfgLoaded(true)
    },
    [country, original]
  )

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      await loadCfg()
      if (cancelled) return
    })()
    return () => {
      cancelled = true
    }
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [country])

  // Live-sync: si otra sesión modifica indrive_config, recargamos
  // preservando dirty edits del usuario. También refrescamos el análisis
  // histórico porque el trigger DB recalcula precios efectivos del bot.
  useEffect(() => {
    function onChange(e) {
      if (e?.detail?.table === 'indrive_config') {
        loadCfg({ preserveDirty: true })
        loadAnalysis()
      }
    }
    window.addEventListener('config:changed', onChange)
    return () => window.removeEventListener('config:changed', onChange)
  }, [loadCfg, loadAnalysis])

  // summary y weekly ya vienen agregados del servidor (via RPC)
  // Solo calculamos pctDiff aquí ya que el RPC no lo incluye
  const summary = useMemo(
    () =>
      summaryData
        .filter((r) => cfgCountry.dbCities.includes(r.city))
        .map((r) => ({
          ...r,
          obsBids: Number(r.obs_with_bids),
          outlierRecs: Number(r.outlier_recs),
          avgRec: r.avg_rec != null ? String(r.avg_rec) : null,
          minRec: r.min_rec != null ? String(r.min_rec) : null,
          maxRec: r.max_rec != null ? String(r.max_rec) : null,
          avgBid: r.avg_bid != null ? String(r.avg_bid) : null,
          pctDiff: (() => {
            const rec = Number(r.avg_rec)
            const bid = Number(r.avg_bid)
            if (!Number.isFinite(rec) || !Number.isFinite(bid) || rec === 0) return null
            return ((bid / rec - 1) * 100).toFixed(1)
          })(),
        })),
    [summaryData, cfgCountry.dbCities]
  )

  const weekly = useMemo(
    () =>
      weeklyData
        .filter((r) => cfgCountry.dbCities.includes(r.city))
        .map((r) => ({
          ...r,
          obs: Number(r.obs),
          avgRec: r.avg_rec != null ? String(r.avg_rec) : null,
          avgBid: r.avg_bid != null ? String(r.avg_bid) : null,
          pctDiff: (() => {
            const rec = Number(r.avg_rec)
            const bid = Number(r.avg_bid)
            if (!Number.isFinite(rec) || !Number.isFinite(bid) || rec === 0) return null
            return ((bid / rec - 1) * 100).toFixed(1)
          })(),
        })),
    [weeklyData, cfgCountry.dbCities]
  )

  // "Ref. reciente": uplift de InDrive ponderado por obs sobre las últimas
  // `refWindow` semanas con datos (reemplaza el promedio de toda la historia).
  const recentRef = useMemo(
    () => computeRecentRef(weekly, cfgCountry.dbCities, refWindow),
    [weekly, cfgCountry.dbCities, refWindow]
  )

  // ── Helpers config ────────────────────────────────────────────
  function getCfg(city, category) {
    return config[`${city}|${category}`] ?? { pct: 0, note: '' }
  }
  function setCfgField(city, category, field, value) {
    setSaveMsg(null)
    const key = `${city}|${category}`
    setConfig((prev) => ({ ...prev, [key]: { ...getCfg(city, category), [field]: value } }))
  }

  function isCellDirty(city, category) {
    const key = `${city}|${category}`
    const cur = config[key] ?? { pct: 0, note: '' }
    const orig = original[key] ?? { pct: 0, note: '' }
    return (
      String(cur.pct ?? '') !== String(orig.pct ?? '') ||
      String(cur.note ?? '') !== String(orig.note ?? '')
    )
  }

  const hasUnsavedChanges = CONFIG_ROWS.some(({ city, category }) => isCellDirty(city, category))

  async function handleSave({ withSnapshot = true } = {}) {
    setSaveMsg(null)

    // Confirmación. El snapshot (hard copy) es opcional: fija los promedios
    // actuales antes de que el reconcile recalcule los precios efectivos del bot.
    const ok = await confirm({
      title: withSnapshot
        ? t('config.indrive.confirm_snapshot_title')
        : t('config.indrive.confirm_nosnapshot_title'),
      message: withSnapshot
        ? t('config.indrive.confirm_snapshot_message')
        : t('config.indrive.confirm_nosnapshot_message'),
      confirmText: withSnapshot
        ? t('config.thresholds.confirm_snapshot_btn')
        : t('config.thresholds.confirm_nosnapshot_btn'),
      cancelText: t('app.cancel'),
      danger: true,
    })
    if (!ok) return

    if (withSnapshot) {
      const { error: snapErr } = await sb.rpc('freeze_pricing_wa', {
        p_country: country,
        p_label: t('config.indrive.snapshot_label', { date: new Date().toISOString() }),
      })
      if (snapErr) {
        setSaveMsg({
          type: 'err',
          text: t('config.thresholds.snapshot_error', { msg: snapErr.message }),
        })
        return
      }
    }

    setSaving(true)
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
          note: cfg.note || null,
          updated_at: new Date().toISOString(),
        }
      })
      if (upserts.length === 0) {
        setSaveMsg({ type: 'warn', text: t('config.indrive.no_changes_toast') })
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
        text: t('config.indrive.saved_toast', { n: upserts.length, count: upserts.length }),
      })
      // La propagación a pricing_observations la hace reconcile_indrive_bot_prices()
      // vía pg_cron (mig 122), no un trigger inline. Recargamos el análisis local.
      await loadAnalysis()
    } catch (e) {
      setSaveMsg({ type: 'err', text: t('config.thresholds.save_error', { msg: e.message }) })
    } finally {
      setSaving(false)
    }
  }

  function handleDiscardAll() {
    setSaveMsg(null)
    setConfig(JSON.parse(JSON.stringify(original)))
  }

  const DIRTY_STYLE = {
    background: '#fef3c7',
    borderColor: '#f59e0b',
    fontWeight: 600,
    boxShadow: '0 0 0 2px rgba(245, 158, 11, 0.2)',
  }

  // ── Render ────────────────────────────────────────────────────
  return (
    <div>
      {/* ── Sección 1: Análisis histórico ── */}
      <div className="config-section">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>{t('config.indrive.analysis_title')}</h2>
          <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
            <Button
              variant="outline"
              size="sm"
              onClick={() => loadAnalysis()}
              disabled={analysisLoading}
              className="rounded-[4px] border-gray-300 bg-gray-50 hover:bg-gray-100"
              title={t('config.indrive.reload_title')}
            >
              ↻ {t('config.indrive.reload_btn')}
            </Button>
            <Button
              variant={analysisView === 'summary' ? 'default' : 'outline'}
              size="sm"
              className="rounded-[4px]"
              onClick={() => setAnalysisView('summary')}
            >
              {t('config.indrive.tab_by_city')}
            </Button>
            <Button
              variant={analysisView === 'weekly' ? 'default' : 'outline'}
              size="sm"
              className="rounded-[4px]"
              onClick={() => setAnalysisView('weekly')}
            >
              {t('config.indrive.tab_by_week')}
            </Button>
          </div>
        </div>
        <p style={{ fontSize: 12, color: '#666', marginBottom: 12 }}>
          {t('config.indrive.desc_prefix', {
            currency: cfgCountry.currency,
            threshold: cfgCountry.outlierThreshold || 100,
          })}{' '}
          · {t('config.indrive.total_db')} <strong>{counts.total_rows}</strong> |{' '}
          {t('config.indrive.with_bids')} <strong>{counts.rows_with_bids}</strong> |{' '}
          {t('config.indrive.without_bids')}{' '}
          <strong
            style={{ color: counts.total_rows - counts.rows_with_bids > 0 ? '#dc2626' : 'inherit' }}
          >
            {counts.total_rows - counts.rows_with_bids}
          </strong>
          {summary.some((r) => r.outlierRecs > 0) && (
            <>
              {' '}
              ·{' '}
              <span style={{ color: '#dc2626' }}>
                ⚠{' '}
                {t('config.indrive.outlier_warning', {
                  n: summary.reduce((s, r) => s + r.outlierRecs, 0),
                  currency: cfgCountry.currency,
                  threshold: cfgCountry.outlierThreshold || 100,
                })}
              </span>
            </>
          )}
        </p>

        {analysisLoading && <div className="state-box">{t('config.indrive.calculating')}</div>}
        {analysisError && (
          <div className="state-box state-box--error">
            {t('app.error_prefix')}
            {analysisError}
          </div>
        )}

        {!analysisLoading && !analysisError && summary.length === 0 && (
          <div className="state-box">
            {t('config.indrive.empty_title')}
            <br />
            <em style={{ fontSize: 11, color: '#888' }}>{t('config.indrive.empty_note')}</em>
          </div>
        )}

        {!analysisLoading && !analysisError && summary.length > 0 && (
          <>
            {analysisView === 'summary' && (
              <table className="config-table">
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left' }}>{t('filter.city')}</th>
                    <th style={{ textAlign: 'left' }}>{t('filter.category')}</th>
                    <th scope="col">{t('config.indrive.col_obs_bids')}</th>
                    <th scope="col">{t('config.indrive.col_avg_rec')}</th>
                    <th scope="col">{t('config.indrive.col_min_rec')}</th>
                    <th scope="col">{t('config.indrive.col_max_rec')}</th>
                    <th scope="col">{t('config.indrive.col_avg_bids')}</th>
                    <th scope="col">{t('config.indrive.col_pct_diff')}</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.map((r) => (
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
                      <td
                        style={{
                          textAlign: 'right',
                          color: r.outlierRecs > 0 ? '#dc2626' : '#9ca3af',
                          fontSize: 11,
                        }}
                      >
                        {r.maxRec != null ? `${cfgCountry.currency} ${r.maxRec}` : '—'}
                        {r.outlierRecs > 0 && (
                          <span
                            title={t('config.indrive.outlier_excluded_title', {
                              n: r.outlierRecs,
                              currency: cfgCountry.currency,
                              threshold: cfgCountry.outlierThreshold || 100,
                            })}
                          >
                            {' '}
                            ⚠
                          </span>
                        )}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {r.avgBid != null ? `${cfgCountry.currency} ${r.avgBid}` : '—'}
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 700 }}>
                        {r.pctDiff != null ? (
                          <span
                            style={{
                              color:
                                Math.abs(parseFloat(r.pctDiff)) > 80
                                  ? '#dc2626'
                                  : parseFloat(r.pctDiff) > 0
                                    ? '#166534'
                                    : '#991b1b',
                            }}
                          >
                            {parseFloat(r.pctDiff) > 0 ? '+' : ''}
                            {r.pctDiff}%
                            {Math.abs(parseFloat(r.pctDiff)) > 80 && (
                              <span title={t('config.indrive.extreme_diff_title')}> ⚠</span>
                            )}
                          </span>
                        ) : (
                          '—'
                        )}
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
                      <th style={{ textAlign: 'left' }}>{t('filter.city')}</th>
                      <th style={{ textAlign: 'left' }}>{t('filter.category')}</th>
                      <th style={{ textAlign: 'left' }}>{t('config.indrive.col_week')}</th>
                      <th scope="col">{t('config.indrive.col_obs')}</th>
                      <th scope="col">{t('config.indrive.col_avg_rec')}</th>
                      <th scope="col">{t('config.indrive.col_avg_bids')}</th>
                      <th scope="col">{t('config.indrive.col_pct_diff')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {weekly.map((r, i) => (
                      <tr key={i}>
                        <td style={{ textAlign: 'left', fontWeight: 600 }}>{r.city}</td>
                        <td style={{ textAlign: 'left' }}>{r.category}</td>
                        <td style={{ textAlign: 'left', fontFamily: 'monospace', fontSize: 11 }}>
                          {r.week}
                        </td>
                        <td style={{ textAlign: 'right' }}>{r.obs}</td>
                        <td style={{ textAlign: 'right' }}>
                          {r.avgRec != null ? `${cfgCountry.currency} ${r.avgRec}` : '—'}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {r.avgBid != null ? `${cfgCountry.currency} ${r.avgBid}` : '—'}
                        </td>
                        <td style={{ textAlign: 'right', fontWeight: 700 }}>
                          {r.pctDiff != null ? (
                            <span
                              style={{
                                color:
                                  Math.abs(parseFloat(r.pctDiff)) > 80
                                    ? '#dc2626'
                                    : parseFloat(r.pctDiff) > 0
                                      ? '#166534'
                                      : '#991b1b',
                              }}
                            >
                              {parseFloat(r.pctDiff) > 0 ? '+' : ''}
                              {r.pctDiff}%{Math.abs(parseFloat(r.pctDiff)) > 80 && ' ⚠'}
                            </span>
                          ) : (
                            '—'
                          )}
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>{t('config.indrive.config_title')}</h2>
          <div style={{ display: 'flex', gap: 4, marginLeft: 'auto', alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: '#666' }}>
              {t('config.indrive.recent_ref_label')}
            </span>
            {[
              { v: 1, labelKey: 'config.indrive.window_last_week' },
              { v: 2, labelKey: 'config.indrive.window_2weeks' },
              { v: 4, labelKey: 'config.indrive.window_4weeks' },
              { v: 'all', labelKey: 'config.indrive.window_all' },
            ].map((o) => (
              <Button
                key={String(o.v)}
                type="button"
                variant={refWindow === o.v ? 'default' : 'outline'}
                size="sm"
                className="rounded-[4px]"
                onClick={() => setRefWindow(o.v)}
                title={
                  o.v === 'all'
                    ? t('config.indrive.window_all_title')
                    : t('config.indrive.window_n_title', { n: o.v })
                }
              >
                {t(o.labelKey)}
              </Button>
            ))}
          </div>
        </div>
        <p style={{ fontSize: 12, color: '#666', marginBottom: 12 }}>
          {t('config.indrive.config_desc_1')}
          <br />
          {t('config.indrive.config_formula')}
          <br />
          <span style={{ color: '#92400e' }}>{t('config.indrive.config_desc_2')}</span>
        </p>

        {!cfgLoaded && <div className="state-box">{t('config.indrive.loading_config')}</div>}

        {cfgLoaded && (
          <>
            {hasUnsavedChanges && (
              <div
                style={{
                  marginTop: 8,
                  marginBottom: 12,
                  padding: '10px 14px',
                  borderRadius: 6,
                  background: '#fef3c7',
                  border: '1px solid #f59e0b',
                  color: '#78350f',
                  fontSize: 13,
                  fontWeight: 500,
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 12,
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <AlertTriangle size={14} /> {t('config.indrive.unsaved_warning')}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleDiscardAll}
                  className="rounded-[4px] border-amber-700 bg-transparent text-amber-900 hover:bg-amber-50"
                >
                  {t('config.discard_changes')}
                </Button>
              </div>
            )}

            <table className="config-table">
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>{t('filter.city')}</th>
                  <th style={{ textAlign: 'left' }}>{t('filter.category')}</th>
                  <th scope="col">{t('config.indrive.col_pct_adjust')}</th>
                  <th style={{ textAlign: 'left', minWidth: 200 }}>
                    {t('config.indrive.col_note_optional')}
                  </th>
                  <th scope="col" title={t('config.indrive.recent_ref_col_title')}>
                    {t('config.indrive.recent_ref')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {CONFIG_ROWS.map(({ city, category }) => {
                  const cfg = getCfg(city, category)
                  const ref = recentRef[`${city}|${category}`]
                  const dirty = isCellDirty(city, category)
                  return (
                    <tr
                      key={`${city}|${category}`}
                      style={dirty ? { background: '#fffbeb' } : undefined}
                    >
                      <td style={{ textAlign: 'left', fontWeight: 600 }}>{city}</td>
                      <td style={{ textAlign: 'left' }}>{category}</td>
                      <td>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 4,
                            justifyContent: 'center',
                          }}
                        >
                          <input
                            type="number"
                            step="0.1"
                            min="-50"
                            max="100"
                            value={cfg.pct}
                            onChange={(e) => setCfgField(city, category, 'pct', e.target.value)}
                            style={{
                              width: 70,
                              textAlign: 'right',
                              padding: '4px 6px',
                              border: '1.5px solid #d1d5db',
                              borderRadius: 4,
                              fontSize: 13,
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
                          onChange={(e) => setCfgField(city, category, 'note', e.target.value)}
                          placeholder={t('config.indrive.note_placeholder')}
                          style={{
                            width: '100%',
                            padding: '4px 6px',
                            border: '1.5px solid #d1d5db',
                            borderRadius: 4,
                            fontSize: 12,
                            ...(dirty ? DIRTY_STYLE : {}),
                          }}
                        />
                      </td>
                      <td style={{ textAlign: 'center', color: '#888', fontSize: 12 }}>
                        {ref && ref.pct != null ? (
                          <span
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 4,
                              justifyContent: 'center',
                            }}
                          >
                            <span
                              title={t('config.indrive.ref_tooltip', {
                                obs: ref.obs,
                                weeks: ref.weeksUsed.length,
                                list: ref.weeksUsed.join(', '),
                              })}
                              style={{ color: '#374151', fontWeight: 500 }}
                            >
                              {ref.pct > 0 ? '+' : ''}
                              {ref.pct.toFixed(1)}%
                            </span>
                            {ref.obs < 10 && (
                              <span
                                title={t('config.indrive.low_obs_warning', { obs: ref.obs })}
                                style={{ color: '#f59e0b' }}
                              >
                                ⚠
                              </span>
                            )}
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                setCfgField(
                                  city,
                                  category,
                                  'pct',
                                  String(Math.round(ref.pct * 10) / 10)
                                )
                              }
                              title={t('config.indrive.use_ref_title')}
                              className="h-auto rounded-[4px] border-gray-300 bg-gray-50 px-1.5 py-0.5 text-[11px] leading-none text-gray-700 hover:bg-gray-100"
                            >
                              →
                            </Button>
                          </span>
                        ) : (
                          <span title={t('config.indrive.no_ref_data')}>—</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>

            <div style={{ marginTop: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Button
                  onClick={() => handleSave({ withSnapshot: true })}
                  disabled={saving || !hasUnsavedChanges}
                  title={!hasUnsavedChanges ? t('config.semaforo.no_changes_title') : undefined}
                >
                  {saving ? (
                    t('account.saving')
                  ) : (
                    <>
                      <Save size={14} /> {t('config.indrive.save_btn')}
                    </>
                  )}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => handleSave({ withSnapshot: false })}
                  disabled={saving || !hasUnsavedChanges}
                  title={
                    !hasUnsavedChanges
                      ? t('config.semaforo.no_changes_title')
                      : t('config.indrive.save_no_snapshot_title')
                  }
                  className="rounded-sm border-gray-300 bg-gray-50 text-gray-700 hover:bg-gray-100"
                >
                  {t('config.thresholds.confirm_nosnapshot_btn')}
                </Button>
              </div>
              <SaveStatusBanner status={saveMsg} onDismiss={() => setSaveMsg(null)} />
            </div>
          </>
        )}
      </div>
    </div>
  )
}
