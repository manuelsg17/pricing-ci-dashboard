import { useState, useCallback } from 'react'
import * as XLSX from 'xlsx'
import { sb } from '../../lib/supabase'
import { mapBotRows } from '../../lib/botMapping'
import { useCountry } from '../../context/CountryContext'
import { usePriceRules } from '../../hooks/usePriceRules'
import OutlierReview from './OutlierReview'

const BATCH_SIZE = 500

export default function BotUpload() {
  const { country } = useCountry()
  const { checkOutliers } = usePriceRules(country)
  const [rows,      setRows]      = useState([])  // mapped rows OK
  const [skipped,   setSkipped]   = useState([])  // skipped rows with reason
  const [fileName,  setFileName]  = useState('')
  const [loading,   setLoading]   = useState(false)
  const [progress,  setProgress]  = useState(null) // { done, total }
  const [message,   setMessage]   = useState(null) // { type: 'ok'|'err', text }
  const [dragOver,  setDragOver]  = useState(false)
  const [suspects,  setSuspects]  = useState(null) // null | array de filas sospechosas

  const parseFile = useCallback(async (file) => {
    setLoading(true)
    setMessage(null)
    setRows([])
    setSkipped([])
    setFileName(file.name)

    try {
      const buffer = await file.arrayBuffer()
      const wb     = XLSX.read(buffer, { type: 'array' })
      const ws     = wb.Sheets[wb.SheetNames[0]]
      const raw    = XLSX.utils.sheet_to_json(ws, { defval: '' })

      const { ok, skipped: skip } = mapBotRows(raw, country)

      // Filtrar filas sin precio en columna de salida:
      // · No-InDrive: necesita price_without_discount
      // · InDrive:    necesita recommended_price (bids son opcionales)
      const validRows   = ok.filter(r =>
        r.competition_name === 'InDrive'
          ? r.recommended_price != null
          : r.price_without_discount != null,
      )
      const noPriceRows = ok
        .filter(r =>
          r.competition_name === 'InDrive'
            ? r.recommended_price == null
            : r.price_without_discount == null,
        )
        .map(r => ({ row: r, reason: 'Sin precio en columna de salida' }))

      setRows(validRows)
      setSkipped([...skip, ...noPriceRows])
    } catch (e) {
      setMessage({ type: 'err', text: 'Error al parsear el archivo: ' + e.message })
    }
    setLoading(false)
  }, [])

  const handleDrop = useCallback((e) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) parseFile(file)
  }, [parseFile])

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
    const finalRows = rows.map((row, idx) => {
      const corr = corrections[idx]
      if (!corr) return row
      if (corr.exclude) return null
      const newPrice = parseFloat(corr.price)
      if (!isNaN(newPrice) && newPrice !== row.price_without_discount) {
        return { ...row, price_without_discount: newPrice }
      }
      return row
    }).filter(Boolean)
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
        if (!cityDateRanges[r.city]) cityDateRanges[r.city] = { min: r.observed_date, max: r.observed_date }
        if (r.observed_date < cityDateRanges[r.city].min) cityDateRanges[r.city].min = r.observed_date
        if (r.observed_date > cityDateRanges[r.city].max) cityDateRanges[r.city].max = r.observed_date
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
        const chunk = rowsToInsert.slice(i, i + BATCH_SIZE).map(r => ({
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
      setMessage({ type: 'ok', text: `✓ ${inserted} filas del bot insertadas. Los datos de los hubs no fueron afectados.` })
      setRows([])
      setSkipped([])
      setFileName('')
    } catch (e) {
      setMessage({ type: 'err', text: 'Error al insertar: ' + e.message })
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
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        <div className="dropzone__icon">🤖</div>
        <div className="dropzone__text">
          {fileName ? `Archivo: ${fileName}` : 'Arrastra el CSV del bot aquí o haz clic para seleccionar'}
        </div>
        <div className="dropzone__hint">Formato: LATAM CI - Peru.csv (output del bot)</div>
        <input
          id="bot-file-input"
          type="file"
          accept=".csv,.xlsx,.xls"
          style={{ display: 'none' }}
          onChange={handleInput}
        />
      </div>

      {loading && <div className="state-box">Analizando archivo del bot…</div>}

      {/* Resumen */}
      {(rows.length > 0 || skipped.length > 0) && !loading && (
        <div style={{ display: 'flex', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
          <div className="upload-ok">✓ {rows.length} filas listas para insertar</div>
          {skipped.length > 0 && (
            <div className="upload-error">⚠ {skipped.length} filas omitidas</div>
          )}
        </div>
      )}

      {/* Preview tabla OK */}
      {rows.length > 0 && !loading && (
        <div className="preview-section" style={{ marginBottom: 14 }}>
          <h2>Vista previa — primeras 20 filas (OK)</h2>
          <div className="preview-wrap">
            <table className="preview-table">
              <thead>
                <tr>
                  <th>Ciudad</th>
                  <th>Competidor</th>
                  <th>Categoría</th>
                  <th>Fecha</th>
                  <th>Hora</th>
                  <th>Bracket</th>
                  <th>Precio</th>
                  <th>Con desc.</th>
                  <th>Recom.</th>
                  <th>Mín. bid</th>
                  <th>Surge</th>
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
                    <td>{r.price_with_discount   ?? '—'}</td>
                    <td>{r.recommended_price      ?? '—'}</td>
                    <td>{r.minimal_bid            ?? '—'}</td>
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
          <h2>Filas omitidas — primeras 10</h2>
          <div className="preview-wrap">
            <table className="preview-table">
              <thead>
                <tr>
                  <th>App</th><th>País</th><th>Ciudad</th><th>Categoría</th><th>Status</th><th>Razón de omisión</th>
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
          <div className="ingest-status">Insertando… {progress.done} / {progress.total} ({pct}%)</div>
        </div>
      )}

      {/* Message */}
      {message && (
        <div className={message.type === 'ok' ? 'upload-ok' : 'upload-error'} style={{ marginBottom: 14 }}>
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

      {/* Actions */}
      {rows.length > 0 && !loading && !progress && !suspects && (
        <div className="upload-actions">
          <button className="btn-ingest" onClick={handleIngestClick}>
            Insertar {rows.length} filas en la BD
          </button>
          <button className="btn-clear" onClick={() => { setRows([]); setSkipped([]); setFileName('') }}>
            Limpiar
          </button>
        </div>
      )}
    </div>
  )
}
