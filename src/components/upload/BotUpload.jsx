import { useState, useCallback } from 'react'
import '../../styles/dashboard.css' // usa .state-box/.filter-bar/.semaforo-*: no depender de que otra página lo cargue
import { AlertTriangle } from 'lucide-react'
import * as XLSX from 'xlsx'
import { sb } from '../../lib/supabase'
import { mapBotRows } from '../../lib/botMapping'
import { useCountry } from '../../context/CountryContext'
import { usePriceRules } from '../../hooks/usePriceRules'
import OutlierReview from './OutlierReview'
import { Button } from '../ui/shadcn/button'
import { useI18n } from '../../context/LanguageContext'

const BATCH_SIZE = 500

export default function BotUpload() {
  const { t } = useI18n()
  const { country, dbConfigs } = useCountry()
  const { checkOutliers, rules, rulesLoaded } = usePriceRules(country)
  const [rows, setRows] = useState([]) // mapped rows OK
  const [skipped, setSkipped] = useState([]) // skipped rows with reason
  const [fileName, setFileName] = useState('')
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState(null) // { done, total }
  const [message, setMessage] = useState(null) // { type: 'ok'|'err', text }
  const [dragOver, setDragOver] = useState(false)
  const [suspects, setSuspects] = useState(null) // null | array de filas sospechosas

  const parseFile = useCallback(
    async (file) => {
      setLoading(true)
      setMessage(null)
      setRows([])
      setSkipped([])
      setFileName(file.name)

      try {
        const buffer = await file.arrayBuffer()
        const wb = XLSX.read(buffer, { type: 'array' })
        const ws = wb.Sheets[wb.SheetNames[0]]
        const raw = XLSX.utils.sheet_to_json(ws, { defval: '' })

        const { ok, skipped: skip } = mapBotRows(raw, country, dbConfigs)

        // Filtrar filas sin precio en columna de salida:
        // · No-InDrive: necesita price_without_discount
        // · InDrive:    necesita recommended_price (bids son opcionales)
        const validRows = ok.filter((r) =>
          r.competition_name === 'InDrive'
            ? r.recommended_price != null
            : r.price_without_discount != null
        )
        const noPriceRows = ok
          .filter((r) =>
            r.competition_name === 'InDrive'
              ? r.recommended_price == null
              : r.price_without_discount == null
          )
          .map((r) => ({ row: r, reason: t('botupload.no_output_price') }))

        setRows(validRows)
        setSkipped([...skip, ...noPriceRows])
      } catch (e) {
        setMessage({ type: 'err', text: t('botupload.parse_error', { msg: e.message }) })
      }
      setLoading(false)
    },
    [country, dbConfigs, t]
  )

  const handleDrop = useCallback(
    (e) => {
      e.preventDefault()
      setDragOver(false)
      const file = e.dataTransfer.files[0]
      if (file) parseFile(file)
    },
    [parseFile]
  )

  const handleInput = (e) => {
    const file = e.target.files[0]
    if (file) parseFile(file)
  }

  const handleIngestClick = () => {
    const { suspects: found } = checkOutliers(rows)
    if (found.length > 0) {
      setSuspects(found)
    } else {
      handleIngest(rows)
    }
  }

  const handleOutlierConfirm = (corrections) => {
    const currentSuspects = suspects
    const finalRows = rows
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
    handleIngest(finalRows)
  }

  const handleIngest = async (rowsToInsert) => {
    if (!rowsToInsert?.length) return
    setProgress({ done: 0, total: rowsToInsert.length })
    setMessage(null)
    let inserted = 0

    try {
      const batchId = crypto.randomUUID()

      // Borrar solo filas previas del BOT para el mismo rango de fechas+ciudad
      // (las filas del Excel/hubs NO se tocan)
      const cityDateRanges = {}
      for (const r of rowsToInsert) {
        if (!r.city || !r.observed_date) continue
        if (!cityDateRanges[r.city])
          cityDateRanges[r.city] = { min: r.observed_date, max: r.observed_date }
        if (r.observed_date < cityDateRanges[r.city].min)
          cityDateRanges[r.city].min = r.observed_date
        if (r.observed_date > cityDateRanges[r.city].max)
          cityDateRanges[r.city].max = r.observed_date
      }
      for (const [city, { min, max }] of Object.entries(cityDateRanges)) {
        const { error: delErr } = await sb
          .from('pricing_observations')
          .delete()
          .eq('country', country)
          .eq('city', city)
          .eq('data_source', 'bot')
          .gte('observed_date', min)
          .lte('observed_date', max)
        if (delErr) throw delErr
      }

      for (let i = 0; i < rowsToInsert.length; i += BATCH_SIZE) {
        const chunk = rowsToInsert.slice(i, i + BATCH_SIZE).map((r) => ({
          ...r,
          country,
          data_source: 'bot',
          upload_batch_id: batchId,
          uploaded_at: new Date().toISOString(),
        }))
        const { error } = await sb.from('pricing_observations').insert(chunk)
        if (error) throw error
        inserted += chunk.length
        setProgress({ done: inserted, total: rows.length })
      }
      setMessage({
        type: 'ok',
        text: t('botupload.insert_success', { n: inserted }),
      })
      setRows([])
      setSkipped([])
      setFileName('')
    } catch (e) {
      setMessage({ type: 'err', text: t('botupload.insert_error', { msg: e.message }) })
    }
    setProgress(null)
  }

  const pct = progress ? Math.round((progress.done / progress.total) * 100) : 0

  return (
    <div>
      {/* Drop zone */}
      <div
        className={`dropzone${dragOver ? ' drag-over' : ''}`}
        onClick={() => document.getElementById('bot-file-input').click()}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        <div className="dropzone__icon">🤖</div>
        <div className="dropzone__text">
          {fileName ? t('botupload.file_label', { name: fileName }) : t('botupload.dropzone_text')}
        </div>
        <div className="dropzone__hint">{t('botupload.dropzone_hint')}</div>
        <input
          id="bot-file-input"
          type="file"
          accept=".csv,.xlsx,.xls"
          style={{ display: 'none' }}
          onChange={handleInput}
        />
      </div>

      {loading && <div className="state-box">{t('botupload.analyzing')}</div>}

      {/* Resumen */}
      {(rows.length > 0 || skipped.length > 0) && !loading && (
        <div style={{ display: 'flex', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
          <div className="upload-ok">{t('botupload.rows_ready', { n: rows.length })}</div>
          {skipped.length > 0 && (
            <div className="upload-error">{t('botupload.rows_skipped', { n: skipped.length })}</div>
          )}
        </div>
      )}

      {/* Preview tabla OK */}
      {rows.length > 0 && !loading && (
        <div className="preview-section" style={{ marginBottom: 14 }}>
          <h2>{t('botupload.preview_title')}</h2>
          <div className="preview-wrap">
            <table className="preview-table">
              <thead>
                <tr>
                  <th>{t('filter.city')}</th>
                  <th>{t('rawdata.col_competitor')}</th>
                  <th>{t('filter.category')}</th>
                  <th>{t('dataentry.date')}</th>
                  <th>{t('rawdata.col_time')}</th>
                  <th>{t('rawdata.col_bracket')}</th>
                  <th>{t('botupload.col_price')}</th>
                  <th>{t('botupload.col_with_disc')}</th>
                  <th>{t('botupload.col_recom')}</th>
                  <th>{t('botupload.col_min_bid')}</th>
                  <th>{t('filter.surge')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 20).map((r, i) => (
                  <tr key={i}>
                    <td>{r.city}</td>
                    <td>{r.competition_name}</td>
                    <td>{r.category}</td>
                    <td>{r.observed_date}</td>
                    <td>{r.observed_time}</td>
                    <td>{r.distance_bracket || '—'}</td>
                    <td>{r.price_without_discount ?? '—'}</td>
                    <td>{r.price_with_discount ?? '—'}</td>
                    <td>{r.recommended_price ?? '—'}</td>
                    <td>{r.minimal_bid ?? '—'}</td>
                    <td>{r.surge === true ? '✓' : r.surge === false ? '✗' : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Skipped preview */}
      {skipped.length > 0 && !loading && (
        <div className="preview-section" style={{ marginBottom: 14 }}>
          <h2>{t('botupload.skipped_title')}</h2>
          <div className="preview-wrap">
            <table className="preview-table">
              <thead>
                <tr>
                  <th>{t('botupload.col_app')}</th>
                  <th>{t('botupload.col_country')}</th>
                  <th>{t('filter.city')}</th>
                  <th>{t('filter.category')}</th>
                  <th>{t('botupload.col_status')}</th>
                  <th>{t('botupload.col_skip_reason')}</th>
                </tr>
              </thead>
              <tbody>
                {skipped.slice(0, 10).map((s, i) => (
                  <tr key={i}>
                    <td>{s.row.app}</td>
                    <td>{s.row.country}</td>
                    <td>{s.row.city}</td>
                    <td>{s.row.vehicle_category}</td>
                    <td>{s.row.status}</td>
                    <td style={{ color: '#721c24', fontWeight: 500 }}>{s.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Progress */}
      {progress && (
        <div style={{ marginBottom: 14 }}>
          <div className="ingest-bar">
            <div className="ingest-bar__fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="ingest-status">
            {t('botupload.inserting_progress', { done: progress.done, total: progress.total, pct })}
          </div>
        </div>
      )}

      {/* Message */}
      {message && (
        <div
          className={message.type === 'ok' ? 'upload-ok' : 'upload-error'}
          style={{ marginBottom: 14 }}
        >
          {message.text}
        </div>
      )}

      {/* Outlier review panel */}
      {suspects && (
        <OutlierReview
          suspects={suspects}
          onConfirm={handleOutlierConfirm}
          onCancel={() => setSuspects(null)}
        />
      )}

      {/* Warning: sin reglas de precio cargadas */}
      {rulesLoaded && rules.length === 0 && rows.length > 0 && !loading && (
        <div className="upload-error" style={{ marginBottom: 10 }}>
          <AlertTriangle size={14} className="inline align-text-bottom" />{' '}
          {t('upload.no_price_rules')}
        </div>
      )}

      {/* Actions */}
      {rows.length > 0 && !loading && !progress && !suspects && (
        <div className="upload-actions">
          <Button className="bg-[#2e7d32] hover:bg-[#1b5e20]" onClick={handleIngestClick}>
            {t('botupload.insert_button', { n: rows.length })}
          </Button>
          <Button
            variant="outline"
            className="hover:border-yango hover:bg-[var(--color-yango-light)] hover:text-yango"
            onClick={() => {
              setRows([])
              setSkipped([])
              setFileName('')
            }}
          >
            {t('filter.reset')}
          </Button>
        </div>
      )}
    </div>
  )
}
