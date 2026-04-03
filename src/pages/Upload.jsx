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

const BATCH_SIZE = 500

export default function Upload() {
  const [city,     setCity]     = useState(CITIES[0])
  const [rows,     setRows]     = useState([])
  const [preview,  setPreview]  = useState([])
  const [thresholds, setThresholds] = useState([])
  const [progress, setProgress] = useState(null)  // { current, total, done, error }
  const [fileInfo, setFileInfo] = useState(null)

  // Cargar thresholds para asignación de brackets en preview
  const loadThresholds = async (c, cat) => {
    const { data } = await sb.from('distance_thresholds')
      .select('*')
      .eq('city', c)
    setThresholds(data || [])
  }

  const handleFile = async (file) => {
    setProgress(null)
    setFileInfo({ name: file.name, size: (file.size / 1024).toFixed(1) + ' KB' })

    const buf  = await file.arrayBuffer()
    const wb   = XLSX.read(buf, { type: 'array', cellDates: false })
    const sheet = wb.Sheets[wb.SheetNames[0]]
    const raw  = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null })

    const parsed = parseRows(raw, city)
    await loadThresholds(city, null)

    const withComputed = parsed.map(r => {
      const cityThresh = thresholds.length
        ? thresholds.filter(t => t.category === r.category || t.category === 'all')
        : []
      return {
        ...r,
        _bracket_computed:  assignBracket(r.distance_km, cityThresh),
        _effective_price:   computeEffectivePrice(r)?.toFixed(2) ?? null,
      }
    })

    setRows(parsed)
    setPreview(withComputed.slice(0, 20))
  }

  const handleIngest = async () => {
    if (!rows.length) return
    setProgress({ current: 0, total: rows.length, done: false, error: null })

    const batchId = crypto.randomUUID()
    let inserted  = 0

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE).map(r => ({
        ...r,
        upload_batch_id: batchId,
      }))
      const { error } = await sb.from('pricing_observations').insert(batch)
      if (error) {
        setProgress(p => ({ ...p, error: error.message, done: false }))
        return
      }
      inserted += batch.length
      setProgress({ current: inserted, total: rows.length, done: false, error: null })
    }

    // Log del batch
    await sb.from('upload_batches').insert({
      id:         batchId,
      filename:   fileInfo?.name,
      row_count:  rows.length,
      city,
    })

    setProgress({ current: rows.length, total: rows.length, done: true, error: null })
  }

  const handleClear = () => {
    setRows([])
    setPreview([])
    setProgress(null)
    setFileInfo(null)
  }

  return (
    <div className="upload-page">
      <h1>Cargar Data</h1>

      <div className="upload-meta">
        <label>Ciudad del archivo:</label>
        <select value={city} onChange={e => setCity(e.target.value)}>
          {CITIES.map(c => <option key={c}>{c}</option>)}
        </select>
        {fileInfo && (
          <span style={{ fontSize: 11, color: '#888' }}>
            {fileInfo.name} ({fileInfo.size})
            {' · '}{rows.length} filas parseadas
          </span>
        )}
      </div>

      {!rows.length && <DropZone onFile={handleFile} />}

      {preview.length > 0 && <PreviewTable rows={preview} />}

      {progress && (
        <IngestProgress
          current={progress.current}
          total={progress.total}
          done={progress.done}
          error={progress.error}
        />
      )}

      {rows.length > 0 && (
        <div className="upload-actions">
          {!progress?.done && (
            <button
              className="btn-ingest"
              onClick={handleIngest}
              disabled={!!progress && !progress.done && !progress.error}
            >
              Insertar {rows.length} filas en Supabase
            </button>
          )}
          <button className="btn-clear" onClick={handleClear}>
            Limpiar
          </button>
        </div>
      )}
    </div>
  )
}
