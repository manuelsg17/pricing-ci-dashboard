import { useState } from 'react'
import * as XLSX from 'xlsx'
import { sb }              from '../lib/supabase'
import { CITIES }          from '../lib/constants'
import { computeEffectivePrice } from '../algorithms/indrive'
import { assignBracket }         from '../algorithms/brackets'
import DropZone            from '../components/upload/DropZone'
import PreviewTable        from '../components/upload/PreviewTable'
import IngestProgress      from '../components/upload/IngestProgress'
import '../styles/upload.css'

// Mapa: nombre de columna en Excel → nombre en BD
const COL_MAP = {
  'Year':                   'year',
  'Rush Hour':              'rush_hour',
  'Rush hour':              'rush_hour',
  'Point A':                'point_a',
  'Point B':                'point_b',
  'Travel Distance (Km)':   'distance_km',
  'Travel Distance (km)':   'distance_km',
  'Category':               'category',
  'Week':                   'week',
  'Timeslot':               'timeslot',
  'Distance bracket':       'distance_bracket',
  'Distance Bracket':       'distance_bracket',
  'Date':                   'observed_date',
  'Time':                   'observed_time',
  'Competition Name':       'competition_name',
  'Surge':                  'surge',
  'Travel Time(Min)':       'travel_time_min',
  'Travel Time (Min)':      'travel_time_min',
  'ETA(min)':               'eta_min',
  'ETA (min)':              'eta_min',
  'Recommend Price':        'recommended_price',
  'Recommended Price':      'recommended_price',
  'Minimal bid':            'minimal_bid',
  'Minimal Bid':            'minimal_bid',
  'Price With Discount':    'price_with_discount',
  'PriceW/ODiscount':       'price_without_discount',
  'Price W/O Discount':     'price_without_discount',
  'Zone':                   'zone',
  'Bid 1':                  'bid_1',
  'Bid 2':                  'bid_2',
  'Bid 3':                  'bid_3',
  'Bid 4':                  'bid_4',
  'Bid 5':                  'bid_5',
  'Discount offer':         'discount_offer',
  'Discount Offer':         'discount_offer',
  'Diff(manualy calc)':     'diff',
  'Diff (manually calc)':   'diff',
}

function parseExcelDate(val) {
  if (!val) return null
  if (typeof val === 'string') return val.slice(0, 10)
  // Número serial de Excel
  if (typeof val === 'number') {
    const date = new Date((val - 25569) * 86400 * 1000)
    return date.toISOString().slice(0, 10)
  }
  if (val instanceof Date) return val.toISOString().slice(0, 10)
  return String(val).slice(0, 10)
}

function parseRows(sheetData, city) {
  if (!sheetData.length) return []
  const headers = sheetData[0]
  return sheetData.slice(1).map(row => {
    const obj = { city }
    headers.forEach((h, i) => {
      const dbCol = COL_MAP[h]
      if (dbCol) obj[dbCol] = row[i] ?? null
    })
    // Normalizar fecha
    obj.observed_date = parseExcelDate(obj.observed_date)
    // Normalizar surge
    if (typeof obj.surge === 'string') {
      obj.surge = obj.surge.toLowerCase() === 'si' || obj.surge.toLowerCase() === 'yes' || obj.surge === '1'
    }
    // Normalizar rush_hour
    if (typeof obj.rush_hour === 'string') {
      obj.rush_hour = obj.rush_hour.toLowerCase().includes('rush')
    }
    return obj
  }).filter(r => r.observed_date && r.competition_name)
}

// Detecta la ciudad a partir del nombre de la pestaña
const SHEET_CITY_MAP = {
  lima_pricing_ci_final:        'Lima',
  lima_pricing_ci_corp_final:   'Lima',
  lima_corp:                    'Lima',
  tru_pricing_ci_final:         'Trujillo',
  trujillo:                     'Trujillo',
  arq_pricing_ci_final:         'Arequipa',
  arequipa:                     'Arequipa',
  airport_ci_final:             'Airport',
  airport:                      'Airport',
}

function detectCity(sheetName) {
  const key = sheetName.toLowerCase().replace(/[\s-]/g, '_')
  for (const [pattern, city] of Object.entries(SHEET_CITY_MAP)) {
    if (key.includes(pattern.replace(/_/g, '')) || key === pattern) return city
  }
  // Fallback por palabras clave
  if (key.includes('lima'))      return 'Lima'
  if (key.includes('tru') || key.includes('trujillo')) return 'Trujillo'
  if (key.includes('arq') || key.includes('arequipa')) return 'Arequipa'
  if (key.includes('airport') || key.includes('aero')) return 'Airport'
  return null
}

const BATCH_SIZE = 500

export default function Upload() {
  const [sheets,   setSheets]   = useState([])   // [{ name, city, rowCount, rows }]
  const [preview,  setPreview]  = useState([])
  const [allRows,  setAllRows]  = useState([])
  const [progress, setProgress] = useState(null)
  const [fileInfo, setFileInfo] = useState(null)

  const handleFile = async (file) => {
    setProgress(null)
    setPreview([])
    setAllRows([])
    setFileInfo({ name: file.name, size: (file.size / 1024 / 1024).toFixed(1) + ' MB' })

    const buf = await file.arrayBuffer()
    const wb  = XLSX.read(buf, { type: 'array', cellDates: false })

    // Procesar solo pestañas que NO sean "_raw" ni de configuración
    const dataSheets = wb.SheetNames.filter(n => {
      const lower = n.toLowerCase()
      return !lower.includes('raw') &&
             !lower.includes('legend') &&
             !lower.includes('sheet4') &&
             !lower.includes('apoyo') &&
             !lower.includes('weight')
    })

    const parsed = []
    for (const sheetName of dataSheets) {
      const city = detectCity(sheetName)
      if (!city) continue  // ignorar pestañas no reconocidas

      const sheet = wb.Sheets[sheetName]
      const raw   = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null })
      const rows  = parseRows(raw, city)
      if (rows.length === 0) continue

      parsed.push({ name: sheetName, city, rowCount: rows.length, rows })
    }

    const allParsed = parsed.flatMap(s => s.rows)
    setSheets(parsed)
    setAllRows(allParsed)
    setPreview(allParsed.slice(0, 20).map(r => ({
      ...r,
      _bracket_computed: r.distance_bracket || '(auto BD)',
      _effective_price:  computeEffectivePrice(r)?.toFixed(2) ?? null,
    })))
  }

  const updateSheetCity = (idx, newCity) => {
    setSheets(prev => {
      const updated = prev.map((s, i) =>
        i === idx ? { ...s, city: newCity, rows: s.rows.map(r => ({ ...r, city: newCity })) } : s
      )
      setAllRows(updated.flatMap(s => s.rows))
      return updated
    })
  }

  const handleIngest = async () => {
    if (!allRows.length) return
    setProgress({ current: 0, total: allRows.length, done: false, error: null })

    const batchId = crypto.randomUUID()
    let inserted  = 0

    for (let i = 0; i < allRows.length; i += BATCH_SIZE) {
      const batch = allRows.slice(i, i + BATCH_SIZE).map(r => ({
        ...r,
        upload_batch_id: batchId,
      }))
      const { error } = await sb.from('pricing_observations').insert(batch)
      if (error) {
        setProgress(p => ({ ...p, error: error.message, done: false }))
        return
      }
      inserted += batch.length
      setProgress({ current: inserted, total: allRows.length, done: false, error: null })
    }

    await sb.from('upload_batches').insert({
      id:        batchId,
      filename:  fileInfo?.name,
      row_count: allRows.length,
      city:      'multi',
    })

    setProgress({ current: allRows.length, total: allRows.length, done: true, error: null })
  }

  const handleClear = () => {
    setSheets([])
    setPreview([])
    setAllRows([])
    setProgress(null)
    setFileInfo(null)
  }

  return (
    <div className="upload-page">
      <h1>Cargar Data</h1>

      {!allRows.length && <DropZone onFile={handleFile} />}

      {/* Resumen de pestañas detectadas */}
      {sheets.length > 0 && (
        <div className="config-section" style={{ marginBottom: 12 }}>
          <h2>Pestañas detectadas — verifica la ciudad asignada</h2>
          <table className="config-table">
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Pestaña</th>
                <th style={{ textAlign: 'left' }}>Ciudad detectada</th>
                <th># Filas</th>
              </tr>
            </thead>
            <tbody>
              {sheets.map((s, i) => (
                <tr key={i}>
                  <td style={{ textAlign: 'left', fontFamily: 'monospace', fontSize: 11 }}>{s.name}</td>
                  <td>
                    <select
                      value={s.city}
                      onChange={e => updateSheetCity(i, e.target.value)}
                      style={{ fontSize: 12, padding: '2px 4px' }}
                    >
                      {CITIES.map(c => <option key={c}>{c}</option>)}
                    </select>
                  </td>
                  <td style={{ textAlign: 'right' }}>{s.rowCount.toLocaleString()}</td>
                </tr>
              ))}
              <tr style={{ background: '#f9fbe7', fontWeight: 700 }}>
                <td style={{ textAlign: 'left' }}>TOTAL</td>
                <td></td>
                <td style={{ textAlign: 'right' }}>{allRows.length.toLocaleString()}</td>
              </tr>
            </tbody>
          </table>
          {fileInfo && (
            <p style={{ fontSize: 11, color: '#888', marginTop: 8 }}>
              Archivo: {fileInfo.name} ({fileInfo.size})
            </p>
          )}
        </div>
      )}

      {preview.length > 0 && <PreviewTable rows={preview} />}

      {progress && (
        <IngestProgress
          current={progress.current}
          total={progress.total}
          done={progress.done}
          error={progress.error}
        />
      )}

      {allRows.length > 0 && (
        <div className="upload-actions">
          {!progress?.done && (
            <button
              className="btn-ingest"
              onClick={handleIngest}
              disabled={!!progress && !progress.done && !progress.error}
            >
              Insertar {allRows.length.toLocaleString()} filas en Supabase
            </button>
          )}
          <button className="btn-clear" onClick={handleClear}>Limpiar</button>
        </div>
      )}
    </div>
  )
}
