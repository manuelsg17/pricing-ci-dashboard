import { useState } from 'react'
import { ClipboardList, Bot, RefreshCw, Plug, Check, X, AlertTriangle } from 'lucide-react'
// xlsx (475 KB) se carga dinámicamente solo cuando el usuario arrastra
// un archivo. Sin esto, todo visitante a /upload baja el chunk vendor-xlsx
// inmediatamente aunque nunca suba un archivo.
import { sb } from '../lib/supabase'
import { computeEffectivePrice } from '../algorithms/indrive'
import DropZone from '../components/upload/DropZone'
import PreviewTable from '../components/upload/PreviewTable'
import IngestProgress from '../components/upload/IngestProgress'
import BotUpload from '../components/upload/BotUpload'
import BotConverter from '../components/upload/BotConverter'
import BotDbSync from '../components/upload/BotDbSync'
import OutlierReview from '../components/upload/OutlierReview'
import BotFreshnessBadge from '../components/ui/BotFreshnessBadge'
import { usePriceRules } from '../hooks/usePriceRules'
import { useRushHourConfig } from '../hooks/useRushHourConfig'
import { sanitizeBatch } from '../algorithms/ingestionFilters'
import { parseRows, detectCity } from '../lib/uploadParsers'
import { TUKTUK_DISTRICTS } from '../lib/tuktukDistricts'
import { useToast } from '../components/ui/Toast'
import { useConfirm } from '../components/ui/ConfirmDialog'
import { useI18n } from '../context/LanguageContext'
import { Button } from '../components/ui/shadcn/button'
import '../styles/upload.css'

import { useCountry } from '../context/CountryContext'

export default function Upload() {
  const { country, countryConfig: config } = useCountry()
  const { t } = useI18n()
  const toast = useToast()
  const confirm = useConfirm()
  const [sheets, setSheets] = useState([])
  const [preview, setPreview] = useState([])
  const [allRows, setAllRows] = useState([])
  const [progress, setProgress] = useState(null)
  const [parsing, setParsing] = useState(null)
  const [uploadTab, setUploadTab] = useState('manual')
  const [suspects, setSuspects] = useState(null) // null | array de filas sospechosas
  // Las filas que el saneamiento ACEPTÓ — son sobre las que checkOutliers
  // calculó sus índices. Sin guardarlas, handleOutlierConfirm mapeaba sobre
  // `allRows` (el array PRE-descarte) y los índices no correspondían.
  const [filasAceptadas, setFilasAceptadas] = useState(null)
  const [, setSanitizationStats] = useState(null)

  const { checkOutliers, rules, rulesLoaded } = usePriceRules(country)
  const { isRushHour } = useRushHourConfig(country)

  // Procesa un único archivo (File) y devuelve array de sheets
  const parseSingleFile = async (file) => {
    // Dynamic import: solo carga xlsx (~475 KB) cuando realmente se necesita
    const XLSX = await import('xlsx')
    const buf = await file.arrayBuffer()
    const wb = XLSX.read(buf, { type: 'array', cellDates: false })

    // Para CSV el sheet name suele ser "Sheet1" — usar nombre de archivo como contexto
    const fileCity = detectCity(file.name.replace(/\.[^.]+$/, ''), config)

    const dataSheets = wb.SheetNames.filter((n) => {
      const lower = n.toLowerCase()
      return (
        !lower.includes('raw') &&
        !lower.includes('legend') &&
        !lower.includes('sheet4') &&
        !lower.includes('apoyo') &&
        !lower.includes('weight')
      )
    })

    const parsed = []
    for (const sheetName of dataSheets) {
      // Ciudad: primero intenta por nombre de pestaña, luego por nombre de archivo
      let city = detectCity(sheetName, config) ?? fileCity
      // Forzar que la ciudad detectada pertenezca al país activo
      if (city && !config.dbCities.includes(city)) {
        city = config.dbCities[0]
      }
      if (!city) city = config.dbCities[0]

      const sheet = wb.Sheets[sheetName]
      const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null })
      const {
        rows,
        droppedNoDate,
        droppedNoCompetitor,
        droppedNoCategory,
        droppedCorpYango,
        tuktukRows,
        tuktukNoDistrict,
      } = parseRows(raw, city)
      if (
        rows.length === 0 &&
        droppedNoDate === 0 &&
        droppedNoCompetitor === 0 &&
        droppedNoCategory === 0 &&
        droppedCorpYango === 0
      )
        continue

      // Etiqueta legible: usar nombre de archivo para CSV (una sola hoja)
      const label = wb.SheetNames.length === 1 ? file.name.replace(/\.[^.]+$/, '') : sheetName

      parsed.push({
        name: label,
        city,
        rowCount: rows.length,
        droppedNoDate,
        droppedNoCompetitor,
        droppedNoCategory,
        droppedCorpYango,
        tuktukRows,
        tuktukNoDistrict,
        rows,
        included: true,
      })
    }
    return parsed
  }

  const handleFile = async (files) => {
    setProgress(null)
    setPreview([])
    setAllRows([])
    setSheets([])

    const allParsed = []

    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      setParsing(
        t('upload.processing_file', { i: i + 1, total: files.length, filename: file.name })
      )
      // Dar un tick al navegador para que renderice el mensaje
      await new Promise((r) => setTimeout(r, 0))

      const fileParsed = await parseSingleFile(file)
      allParsed.push(...fileParsed)
    }

    setParsing(null)

    const allRows = allParsed.flatMap((s) => s.rows)
    setSheets(allParsed)
    setAllRows(allRows)
    setPreview(
      allRows.slice(0, 20).map((r) => ({
        ...r,
        _bracket_computed: r.distance_bracket || '(auto BD)',
        _effective_price: computeEffectivePrice(r)?.toFixed(2) ?? null,
      }))
    )
  }

  // Recomputa allRows + preview a partir del estado de sheets (respeta `included`)
  const syncFromSheets = (updatedSheets) => {
    const included = updatedSheets.filter((s) => s.included !== false)
    const flat = included.flatMap((s) => s.rows)
    setAllRows(flat)
    setPreview(
      flat.slice(0, 20).map((r) => ({
        ...r,
        _bracket_computed: r.distance_bracket || '(auto BD)',
        _effective_price: computeEffectivePrice(r)?.toFixed(2) ?? null,
      }))
    )
  }

  const updateSheetCity = (idx, newCity) => {
    setSheets((prev) => {
      const updated = prev.map((s, i) =>
        i === idx ? { ...s, city: newCity, rows: s.rows.map((r) => ({ ...r, city: newCity })) } : s
      )
      syncFromSheets(updated)
      return updated
    })
  }

  const toggleSheetIncluded = (idx) => {
    setSheets((prev) => {
      const updated = prev.map((s, i) => (i === idx ? { ...s, included: s.included === false } : s))
      syncFromSheets(updated)
      return updated
    })
  }

  const setAllSheetsIncluded = (included) => {
    setSheets((prev) => {
      const updated = prev.map((s) => ({ ...s, included }))
      syncFromSheets(updated)
      return updated
    })
  }

  // Llamado cuando el usuario hace click en "Insertar N filas"
  // Primero pasa el saneamiento compartido (filas incompletas / sin precio),
  // luego revisa outliers contra price_validation_rules.
  const handleIngestClick = () => {
    // Paso 1: saneamiento compartido (mismo código que usaremos para la BD del bot).
    // NO descartamos outliers aquí — el usuario los revisa en el panel.
    const { accepted, stats } = sanitizeBatch(allRows, rules, { dropOutliers: false })
    setSanitizationStats(stats)
    if (stats.missingFields > 0 || stats.missingPrice > 0) {
      const total = stats.missingFields + stats.missingPrice
      toast.warn(
        t('upload.sanitize_warning', {
          total,
          count: total,
          missingFields: stats.missingFields,
          missingPrice: stats.missingPrice,
        }),
        { duration: 6000 }
      )
    }

    // Paso 2: outliers (mismo flujo que ya existía).
    const { suspects: found } = checkOutliers(accepted)
    if (found.length > 0) {
      setFilasAceptadas(accepted) // los índices de `found` apuntan acá
      setSuspects(found) // muestra el panel de revisión
    } else {
      handleIngest(accepted)
    }
  }

  // Llamado desde OutlierReview cuando el usuario confirma
  const handleOutlierConfirm = (corrections) => {
    const currentSuspects = suspects
    // `filasAceptadas`, NO `allRows`. Dos bugs en uno:
    //
    //   1. `checkOutliers` calcula sus `idx` sobre lo que devuelve
    //      `sanitizeBatch`, que ya descartó las filas incompletas o sin precio.
    //      Mapear sobre `allRows` desalineaba los índices: con UNA sola fila
    //      descartada antes del outlier, la corrección caía en la fila de al
    //      lado y el outlier real entraba intacto.
    //   2. Construir el resultado desde `allRows` REINYECTABA las filas que el
    //      saneamiento había frenado — entraban con precio null.
    //
    // Se disparaba siempre que hubiera ≥1 fila descartada, aunque el usuario no
    // editara nada.
    const base = filasAceptadas ?? allRows
    const finalRows = base
      .map((row, idx) => {
        const corr = corrections[idx]
        if (!corr) return row
        if (corr.exclude) return null
        const newPrice = parseFloat(corr.price)
        if (!isNaN(newPrice)) {
          const suspect = currentSuspects?.find((s) => s.idx === idx)
          const field = suspect?.field ?? 'price_without_discount'
          if (newPrice !== row[field]) return { ...row, [field]: newPrice }
        }
        return row
      })
      .filter(Boolean)
    setSuspects(null)
    setFilasAceptadas(null)
    handleIngest(finalRows)
  }

  const handleIngest = async (rowsToInsert) => {
    if (!rowsToInsert?.length) return

    // ── Paso 0: Calcular rangos fecha+ciudad (también necesarios para el DELETE) ──
    const cityDateRanges = {}
    for (const r of rowsToInsert) {
      if (!r.city || !r.observed_date) continue
      if (!cityDateRanges[r.city])
        cityDateRanges[r.city] = { min: r.observed_date, max: r.observed_date }
      if (r.observed_date < cityDateRanges[r.city].min) cityDateRanges[r.city].min = r.observed_date
      if (r.observed_date > cityDateRanges[r.city].max) cityDateRanges[r.city].max = r.observed_date
    }

    // ── Confirmación destructiva: la ingesta hace DELETE+INSERT por (ciudad, rango) ──
    const summary = Object.entries(cityDateRanges)
      .map(([city, { min, max }]) => `${city}: ${min === max ? min : `${min} → ${max}`}`)
      .join(' · ')
    const ok = await confirm({
      title: t('upload.ingest_confirm_title'),
      message: t('upload.ingest_confirm_message', {
        country,
        summary,
        n: rowsToInsert.length,
      }),
      confirmText: t('upload.ingest_confirm_btn'),
      cancelText: t('app.cancel'),
      danger: true,
    })
    if (!ok) return

    setProgress({ current: 0, total: rowsToInsert.length, done: false, error: null })

    const batchId = crypto.randomUUID()

    // ── Paso 2: Pre-computar campos calculados en cada fila ────────────────
    const finalRows = rowsToInsert.map((r) => {
      let row = {
        ...r,
        country,
        data_source: 'manual',
        upload_batch_id: batchId,
        rush_hour: r.observed_time
          ? (isRushHour(r.observed_time, r.city) ?? r.rush_hour)
          : r.rush_hour,
      }
      // Fase 1.4 paso 2: competition_name ya NO se normaliza acá antes del
      // insert — el trigger SQL trg_normalize_competitor (mig 70/72/97,
      // normalize_competitor_name(raw, city)) es la única autoridad y cubre
      // el 100% de los paths de insert, incluido este (INSERT directo).
      // Doble normalización JS+trigger fue exactamente el patrón del
      // incidente mig 68→97; baseline de divergencia = 0 en 1.36M filas
      // (ver scripts/check-normalization-drift.sql) antes de sacar este
      // lado redundante.
      //
      // Para InDrive: calcular minimal_bid y price_without_discount desde bids
      // si las fórmulas de Excel no fueron evaluadas (llegan como 0 o null).
      // Mig 136: bid_1..bid_5 (hasta 5 bids). Comparación case-insensitive
      // sobre el valor crudo porque ya no pasa por normalizeCompetitorName()
      // en este punto (el trigger lo normaliza recién al escribir en BD).
      if (
        String(row.competition_name || '')
          .trim()
          .toLowerCase() === 'indrive'
      ) {
        const bidVals = [row.bid_1, row.bid_2, row.bid_3, row.bid_4, row.bid_5]
          .map((b) => parseFloat(b))
          .filter((n) => !isNaN(n) && n > 0)
        if (bidVals.length) {
          const curMin = parseFloat(row.minimal_bid)
          if (!curMin || curMin === 0) row.minimal_bid = Math.min(...bidVals)
          if (!row.price_without_discount || row.price_without_discount === 0) {
            // Precio efectivo = promedio de bids únicamente (minimal_bid es el piso permitido, no un bid)
            row.price_without_discount = parseFloat(
              (bidVals.reduce((a, b) => a + b, 0) / bidVals.length).toFixed(2)
            )
          }
        }
      }
      return row
    })

    // ── Paso 3: DELETE por ciudad+rango de fechas ─────────────────────────
    // ACOTADO al Excel (uploaded_by IS NULL): así este import NO borra lo que
    // cargaron los hubs a mano en "Ingresar CI" (esas filas llevan
    // uploaded_by = email del hub, mig 139). El Excel solo reemplaza sus
    // propias filas previas (y las legacy sin dueño, mayormente de Excel).
    // Excel y hub comparten data_source='manual' y se fusionan como muestras
    // en la MV (agrupa por data_source, no por uploaded_by) → el Excel aparece
    // como una muestra adicional junto a la del hub, sin pisarla.
    for (const [city, { min, max }] of Object.entries(cityDateRanges)) {
      const { error: delErr } = await sb
        .from('pricing_observations')
        .delete()
        .eq('country', country)
        .eq('city', city)
        .eq('data_source', 'manual')
        .is('uploaded_by', null)
        .gte('observed_date', min)
        .lte('observed_date', max)
      if (delErr) {
        setProgress((p) => ({ ...p, error: delErr.message, done: false }))
        return
      }
    }

    // ── Paso 4: INSERT en lotes (Supabase aplica DEFAULT del id en la BD) ─
    const BATCH_SIZE = 2000

    for (let i = 0; i < finalRows.length; i += BATCH_SIZE) {
      const chunk = finalRows.slice(i, i + BATCH_SIZE)

      const { error } = await sb.from('pricing_observations').insert(chunk)

      if (error) {
        setProgress((p) => ({ ...p, error: error.message, done: false }))
        return
      }

      setProgress((p) => ({
        ...p,
        current: Math.min(i + BATCH_SIZE, finalRows.length),
      }))

      if (i + BATCH_SIZE < finalRows.length) {
        await new Promise((r) => setTimeout(r, 150))
      }
    }

    setProgress({ current: finalRows.length, total: finalRows.length, done: true, error: null })
  }

  const handleClear = () => {
    setSheets([])
    setPreview([])
    setAllRows([])
    setProgress(null)
    setParsing(null)
    setSuspects(null)
  }

  return (
    <div className="upload-page">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          flexWrap: 'wrap',
          marginBottom: 8,
        }}
      >
        <h1 style={{ margin: 0 }}>{t('upload.title')}</h1>
        <BotFreshnessBadge variant="pill" />
      </div>

      {/* Sub-tabs */}
      <div className="upload-tabs">
        <button
          className={`upload-tab${uploadTab === 'manual' ? ' active' : ''}`}
          onClick={() => setUploadTab('manual')}
        >
          <ClipboardList size={14} /> {t('upload.tab_manual')}
        </button>
        <button
          className={`upload-tab${uploadTab === 'bot' ? ' active' : ''}`}
          onClick={() => setUploadTab('bot')}
        >
          <Bot size={14} /> {t('upload.tab_bot')}
        </button>
        <button
          className={`upload-tab${uploadTab === 'convert' ? ' active' : ''}`}
          onClick={() => setUploadTab('convert')}
        >
          <RefreshCw size={14} /> {t('upload.tab_convert')}
        </button>
        <button
          className={`upload-tab${uploadTab === 'dbsync' ? ' active' : ''}`}
          onClick={() => setUploadTab('dbsync')}
        >
          <Plug size={14} /> {t('upload.tab_dbsync')}
        </button>
      </div>

      {/* Bot upload to DB */}
      {uploadTab === 'bot' && <BotUpload />}

      {/* Bot → Excel converter */}
      {uploadTab === 'convert' && <BotConverter />}

      {/* Bot DB direct sync */}
      {uploadTab === 'dbsync' && <BotDbSync />}

      {/* Manual upload */}
      {uploadTab === 'manual' && (
        <>
          {!allRows.length && !parsing && <DropZone onFile={handleFile} />}

          {/* Indicador de parseo */}
          {parsing && (
            <div style={{ padding: '20px 0', textAlign: 'center', color: '#555', fontSize: 14 }}>
              <div style={{ marginBottom: 8, fontSize: 22 }}>⏳</div>
              {parsing}
            </div>
          )}

          {/* Resumen de archivos detectados */}
          {sheets.length > 0 && (
            <div className="config-section" style={{ marginBottom: 12 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                  flexWrap: 'wrap',
                  marginBottom: 8,
                }}
              >
                <h2 style={{ margin: 0 }}>{t('upload.files_detected_title')}</h2>
                <div style={{ display: 'flex', gap: 6 }}>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setAllSheetsIncluded(true)}
                    title={t('upload.include_all_title')}
                  >
                    <Check size={14} /> {t('upload.include_all')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setAllSheetsIncluded(false)}
                    title={t('upload.skip_all_title')}
                  >
                    <X size={14} /> {t('upload.skip_all')}
                  </Button>
                </div>
              </div>
              <table className="config-table">
                <thead>
                  <tr>
                    <th style={{ width: 60 }}>{t('upload.col_include')}</th>
                    <th style={{ textAlign: 'left' }}>{t('upload.col_file_sheet')}</th>
                    <th style={{ textAlign: 'left' }}>{t('upload.col_detected_city')}</th>
                    <th>{t('upload.col_valid_rows')}</th>
                    <th style={{ textAlign: 'left' }}>{t('upload.col_discarded')}</th>
                  </tr>
                </thead>
                <tbody>
                  {sheets.map((s, i) => {
                    const dDate = s.droppedNoDate || 0
                    const dComp = s.droppedNoCompetitor || 0
                    const dCat = s.droppedNoCategory || 0
                    const dCorp = s.droppedCorpYango || 0
                    const dropped = dDate + dComp + dCat + dCorp
                    const parts = []
                    if (dDate > 0) parts.push(t('upload.dropped_no_date', { n: dDate }))
                    if (dComp > 0) parts.push(t('upload.dropped_no_competitor', { n: dComp }))
                    if (dCat > 0) parts.push(t('upload.dropped_no_category', { n: dCat }))
                    if (dCorp > 0) parts.push(t('upload.dropped_corp_yango', { n: dCorp }))
                    const isIncluded = s.included !== false
                    return (
                      <tr key={i} style={isIncluded ? undefined : { opacity: 0.45 }}>
                        <td style={{ textAlign: 'center' }}>
                          <input
                            type="checkbox"
                            checked={isIncluded}
                            onChange={() => toggleSheetIncluded(i)}
                            title={
                              isIncluded
                                ? t('upload.toggle_skip_title')
                                : t('upload.toggle_include_title')
                            }
                            style={{ cursor: 'pointer', width: 16, height: 16 }}
                          />
                        </td>
                        <td
                          style={{
                            textAlign: 'left',
                            fontFamily: 'monospace',
                            fontSize: 11,
                            textDecoration: isIncluded ? 'none' : 'line-through',
                          }}
                        >
                          {s.name}
                        </td>
                        <td>
                          <select
                            value={s.city}
                            onChange={(e) => updateSheetCity(i, e.target.value)}
                            disabled={!isIncluded}
                            style={{ fontSize: 12, padding: '2px 4px' }}
                          >
                            {config.dbCities.map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td style={{ textAlign: 'right' }}>{s.rowCount.toLocaleString()}</td>
                        <td style={{ fontSize: 11, color: dropped > 0 ? '#dc2626' : '#9ca3af' }}>
                          {dropped > 0 ? `⚠ ${dropped} (${parts.join(' · ')})` : '—'}
                        </td>
                      </tr>
                    )
                  })}
                  <tr style={{ background: '#f9fbe7', fontWeight: 700 }}>
                    <td></td>
                    <td style={{ textAlign: 'left' }}>
                      {t('upload.total_sheets', {
                        included: sheets.filter((s) => s.included !== false).length,
                        total: sheets.length,
                      })}
                    </td>
                    <td></td>
                    <td style={{ textAlign: 'right' }}>{allRows.length.toLocaleString()}</td>
                    <td></td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          {sheets.length > 0 && allRows.length === 0 && (
            <div className="upload-error" style={{ marginBottom: 10 }}>
              <AlertTriangle size={14} className="inline align-text-bottom" />{' '}
              {t('upload.all_sheets_skipped')}
            </div>
          )}

          {/* TukTuk: distritos válidos + aviso de filas sin distrito (no se descartan) */}
          {(() => {
            const incl = sheets.filter((s) => s.included !== false)
            const hasTukTuk = incl.some((s) => (s.tuktukRows || 0) > 0)
            if (!hasTukTuk) return null
            const totalNo = incl.reduce((a, s) => a + (s.tuktukNoDistrict || 0), 0)
            return (
              <div
                className="config-section"
                style={{ marginBottom: 12, borderLeft: '3px solid #f59e0b' }}
              >
                <strong>🛺 {t('upload.tuktuk_districts_title')}</strong>{' '}
                {TUKTUK_DISTRICTS.join(' · ')}
                <div style={{ fontSize: 12, color: 'var(--color-muted)', marginTop: 4 }}>
                  {t('upload.tuktuk_zone_hint')}
                </div>
                {totalNo > 0 && (
                  <div style={{ marginTop: 6, color: '#b45309', fontWeight: 600 }}>
                    <AlertTriangle size={14} className="inline align-text-bottom" />{' '}
                    {t('upload.tuktuk_no_district', { n: totalNo, count: totalNo })}
                  </div>
                )}
              </div>
            )
          })()}

          {preview.length > 0 && !suspects && <PreviewTable rows={preview} />}

          {/* Panel de revisión de outliers */}
          {suspects && (
            <OutlierReview
              suspects={suspects}
              onConfirm={handleOutlierConfirm}
              onCancel={() => setSuspects(null)}
            />
          )}

          {progress && (
            <IngestProgress
              current={progress.current}
              total={progress.total}
              done={progress.done}
              error={progress.error}
            />
          )}

          {rulesLoaded && rules.length === 0 && allRows.length > 0 && (
            <div className="upload-error" style={{ marginBottom: 10 }}>
              <AlertTriangle size={14} className="inline align-text-bottom" />{' '}
              {t('upload.no_price_rules')}
            </div>
          )}

          {allRows.length > 0 && (
            <div className="upload-actions">
              {!progress?.done && (
                <>
                  <div className="upload-overwrite-notice">
                    <AlertTriangle size={14} className="inline align-text-bottom" />{' '}
                    {t('upload.overwrite_notice')}
                  </div>
                  <Button
                    className="bg-[#2e7d32] hover:bg-[#1b5e20]"
                    onClick={handleIngestClick}
                    disabled={!!progress && !progress.done && !progress.error}
                  >
                    {t('upload.insert_button', { n: allRows.length.toLocaleString() })}
                  </Button>
                </>
              )}
              <Button
                variant="outline"
                className="hover:border-yango hover:bg-[var(--color-yango-light)] hover:text-yango"
                onClick={handleClear}
              >
                {t('filter.reset')}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
