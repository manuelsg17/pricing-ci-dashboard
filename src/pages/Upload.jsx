import { useState } from 'react'
import * as XLSX from 'xlsx'
import { sb }              from '../lib/supabase'
import { getCountryConfig } from '../lib/constants'
import { computeEffectivePrice } from '../algorithms/indrive'
import { assignBracket }         from '../algorithms/brackets'
import DropZone            from '../components/upload/DropZone'
import PreviewTable        from '../components/upload/PreviewTable'
import IngestProgress      from '../components/upload/IngestProgress'
import BotUpload           from '../components/upload/BotUpload'
import BotConverter        from '../components/upload/BotConverter'
import OutlierReview          from '../components/upload/OutlierReview'
import { usePriceRules }      from '../hooks/usePriceRules'
import { useRushHourConfig }  from '../hooks/useRushHourConfig'
import '../styles/upload.css'

// Mapa: nombre de columna en Excel/CSV → nombre en BD
// Incluye variantes con "(for pivot)" usadas en ARQ, TRU, AIRPORT
const COL_MAP = {
  'Year':                           'year',
  'Rush Hour':                      'rush_hour',
  'Rush hour':                      'rush_hour',
  'Point A':                        'point_a',
  'Point B':                        'point_b',
  'Travel Distance (Km)':           'distance_km',
  'Travel Distance (km)':           'distance_km',
  'Category':                       'category',
  'Week':                           'week',
  'Week (for pivot)':               'week',
  'Timeslot':                       'timeslot',
  'Timeslot (for pivot)':           'timeslot',
  'Distance bracket':               'distance_bracket',
  'Distance Bracket':               'distance_bracket',
  'Distance bracket (for pivot)':   'distance_bracket',
  'Distance Bracket (for pivot)':   'distance_bracket',
  'Date':                           'observed_date',
  'Time':                           'observed_time',
  'Competition Name':               'competition_name',
  'Surge':                          'surge',
  'Travel Time(Min)':               'travel_time_min',
  'Travel Time (Min)':              'travel_time_min',
  'ETA(min)':                       'eta_min',
  'ETA (min)':                      'eta_min',
  'ETA (Min)':                      'eta_min',
  'Recommend Price':                'recommended_price',
  'Recommended Price':              'recommended_price',
  'Minimal bid':                    'minimal_bid',
  'Minimal Bid':                    'minimal_bid',
  'Price With Discount':            'price_with_discount',
  'PriceW/ODiscount':               'price_without_discount',
  'Price W/O Discount':             'price_without_discount',
  'Zone':                           'zone',
  'Bid 1':                          'bid_1',
  'Bid 2':                          'bid_2',
  'Bid 3':                          'bid_3',
  'Bid 4':                          'bid_4',
  'Bid 5':                          'bid_5',
  'Discount offer':                 'discount_offer',
  'Discount Offer':                 'discount_offer',
  'Diff(manualy calc)':             'diff',
  'Diff (manually calc)':           'diff',
  'Diff (manualy calc)':            'diff',
}

// Normalización de categorías: nombre UI del Excel → nombre canónico en BD
const CATEGORY_NORMALIZE = {
  'Comfort/Comfort+': 'Comfort',    // TRU/ARQ: nombre UI → nombre BD
  'Comfort+':         'Comfort',    // TRU/ARQ: variante corta
  'Comfort+/Premier': 'Premier',    // Lima/Airport: nombre UI → nombre BD
}

// Normalización de nombres de competidor
const COMPETITOR_NORMALIZE = {
  'Indrive':        'InDrive',
  'Yango premier':  'YangoPremier',
  'Yango  premier': 'YangoPremier',
  'DiDi':           'Didi',
}

// ── Helpers de parseo ──────────────────────────────────────

function excelSerialToDate(serial) {
  const date = new Date((serial - 25569) * 86400 * 1000)
  return date.toISOString().slice(0, 10)
}

function parseExcelDate(val) {
  if (val === null || val === undefined || val === '') return null

  // Número serial de Excel (como número o como string numérico puro, ej: "45659")
  if (typeof val === 'number') return excelSerialToDate(Math.floor(val))
  if (typeof val === 'string' && /^\d{4,6}$/.test(val.trim())) {
    return excelSerialToDate(parseInt(val.trim(), 10))
  }

  if (typeof val === 'string') {
    const s = val.trim()
    // Formato DD/MM/YYYY → YYYY-MM-DD
    if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) {
      const [d, m, y] = s.split('/')
      return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`
    }
    // Formato DD-MM-YYYY
    if (/^\d{1,2}-\d{1,2}-\d{4}$/.test(s)) {
      const [d, m, y] = s.split('-')
      return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`
    }
    // Ya en formato YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
    return null
  }

  if (val instanceof Date) return val.toISOString().slice(0, 10)
  return null
}

function parseExcelTime(val) {
  if (val === null || val === undefined || val === '') return null
  if (typeof val === 'string') {
    const s = val.trim()
    if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(s)) return s
    return null
  }
  if (typeof val === 'number') {
    const fraction    = val % 1
    const totalSeconds = Math.round(fraction * 86400)
    const h = Math.floor(totalSeconds / 3600)
    const m = Math.floor((totalSeconds % 3600) / 60)
    const s = totalSeconds % 60
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
  }
  if (val instanceof Date) return val.toTimeString().slice(0, 8)
  return null
}

// Columnas que deben ser números en la BD
const NUMERIC_COLS = new Set([
  'distance_km','travel_time_min','eta_min','recommended_price','minimal_bid',
  'price_with_discount','price_without_discount','bid_1','bid_2','bid_3',
  'bid_4','bid_5','discount_offer','diff',
])

// Columnas que deben ser enteros
const INT_COLS = new Set(['year', 'week'])

// Columnas de fecha/hora — necesitan el valor RAW (no convertido a string)
const RAW_COLS = new Set(['observed_date', 'observed_time'])

function toNumeric(val) {
  if (val === null || val === undefined || val === '') return null
  if (typeof val === 'number') return isNaN(val) ? null : val
  // Quitar prefijo de moneda (ej: "S/.9.00" → "9.00", "$8.50" → "8.50")
  // y normalizar coma decimal ("13,2" → "13.2")
  const s = String(val).trim().replace(/^[^\d-]+/, '').replace(',', '.')
  const n = parseFloat(s)
  return isNaN(n) ? null : n
}

function toInt(val) {
  const n = toNumeric(val)
  return n === null ? null : Math.round(n)
}

function parseBool(val) {
  if (val === null || val === undefined || val === '') return null
  if (typeof val === 'boolean') return val
  if (typeof val === 'number') return val !== 0
  const s = String(val).trim().toLowerCase()
  if (s === '' || s === 'null' || s === 'n/a') return null
  return s === 'si' || s === 'sí' || s === 'yes' || s === '1' || s === 'true' || s === 'rush hour'
}

function cleanStr(val) {
  if (val === null || val === undefined) return null
  return String(val).trim() || null
}

function parseRows(sheetData, city) {
  if (!sheetData.length) return []

  // Encontrar la fila de cabeceras: la primera que contenga al menos una columna conocida en COL_MAP
  // (ignora filas de metadata como "colocar lista de eleccion", "InDrive", "All exc. InDrive"…)
  const headerRowIdx = sheetData.findIndex(r =>
    r && r.some(c => COL_MAP[String(c || '').trim()])
  )
  if (headerRowIdx === -1) return []
  const headers = sheetData[headerRowIdx]

  const mappedRows = sheetData.slice(headerRowIdx + 1).map(row => {
    // Ignorar filas completamente vacías
    if (!row || row.every(c => c === null || c === '')) return null

    const obj = { city }
    headers.forEach((h, i) => {
      const dbCol = COL_MAP[String(h || '').trim()]
      if (!dbCol) return
      const raw = row[i] ?? null
      if (RAW_COLS.has(dbCol))        obj[dbCol] = raw              // fecha/hora: conservar número original
      else if (NUMERIC_COLS.has(dbCol)) obj[dbCol] = toNumeric(raw)
      else if (INT_COLS.has(dbCol))     obj[dbCol] = toInt(raw)
      else                              obj[dbCol] = cleanStr(raw)
    })

    // Fecha y hora
    obj.observed_date = parseExcelDate(obj.observed_date)
    obj.observed_time = parseExcelTime(obj.observed_time)

    // Booleans — forzar true/false/null sin excepción
    const rawSurge    = obj.surge
    const rawRushHour = obj.rush_hour

    obj.surge = typeof rawSurge === 'boolean'
      ? rawSurge
      : parseBool(rawSurge)

    obj.rush_hour = typeof rawRushHour === 'string'
      ? (rawRushHour.toLowerCase().includes('rush') ? true : rawRushHour.toLowerCase().includes('valley') ? false : null)
      : typeof rawRushHour === 'boolean'
        ? rawRushHour
        : parseBool(rawRushHour)

    // Red de seguridad final: si algo raro llegó, forzar null
    if (obj.surge    !== null && typeof obj.surge    !== 'boolean') obj.surge    = null
    if (obj.rush_hour !== null && typeof obj.rush_hour !== 'boolean') obj.rush_hour = null

    // Limpiar nombres clave (sin espacios extra, sin saltos de línea)
    obj.competition_name = cleanStr(obj.competition_name)
    obj.category         = cleanStr(obj.category)
    obj.distance_bracket = cleanStr(obj.distance_bracket)

    // Normalizar categorías y competidores a nombres canónicos en BD
    if (obj.category)         obj.category         = CATEGORY_NORMALIZE[obj.category]         ?? obj.category
    if (obj.competition_name) obj.competition_name = COMPETITOR_NORMALIZE[obj.competition_name] ?? obj.competition_name

    return obj
  })

  // Fill-down: hereda competition_name, observed_date y category de la fila anterior
  // cuando la celda llega null (patrón de celdas combinadas en Excel).
  // Se resetea en filas completamente vacías (null) para no cruzar secciones.
  let lastDate       = null
  let lastCompetitor = null
  let lastCategory   = null
  const filled = []
  for (const r of mappedRows) {
    if (!r) {
      lastDate = null; lastCompetitor = null; lastCategory = null
      filled.push(r)
      continue
    }
    if (r.observed_date)     lastDate       = r.observed_date
    else if (lastDate)       r.observed_date = lastDate

    if (r.competition_name)  lastCompetitor = r.competition_name
    else if (lastCompetitor) r.competition_name = lastCompetitor

    if (r.category)          lastCategory   = r.category
    else if (lastCategory)   r.category     = lastCategory

    filled.push(r)
  }

  // Contar descartadas para diagnóstico visible en la UI
  let droppedNoDate = 0
  let droppedNoCompetitor = 0
  const rows = filled.filter(r => {
    if (!r) return false
    if (!r.observed_date)    { droppedNoDate++;       return false }
    if (!r.competition_name) { droppedNoCompetitor++; return false }
    return true
  })

  return { rows, droppedNoDate, droppedNoCompetitor }
}

// Detecta la ciudad a partir del nombre de la pestaña o archivo
const SHEET_CITY_MAP = {
  lima_pricing_ci_corp_final:   'Corp',
  lima_pricing_ci_corp:         'Corp',
  lima_corp:                    'Corp',
  lima_pricing_ci_final:        'Lima',
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
  // Fallback por palabras clave (corp antes de lima para evitar falso match)
  const lowerPattern = key.toLowerCase()
  if (lowerPattern.includes('corp'))      return 'Corp'
  if (lowerPattern.includes('lima'))      return 'Lima'
  if (lowerPattern.includes('tru') || lowerPattern.includes('trujillo')) return 'Trujillo'
  if (lowerPattern.includes('arq') || lowerPattern.includes('arequipa')) return 'Arequipa'
  if (lowerPattern.includes('airport') || lowerPattern.includes('aero')) return 'Airport'
  if (lowerPattern.includes('bog'))       return 'Bogota'
  if (lowerPattern.includes('med'))       return 'Medellin'
  if (lowerPattern.includes('cali'))      return 'Cali'
  return null
}

export default function Upload({ country = 'Peru' }) {
  const config = getCountryConfig(country)
  const [sheets,    setSheets]    = useState([])
  const [preview,   setPreview]   = useState([])
  const [allRows,   setAllRows]   = useState([])
  const [progress,  setProgress]  = useState(null)
  const [parsing,   setParsing]   = useState(null)
  const [uploadTab, setUploadTab] = useState('manual')
  const [suspects,  setSuspects]  = useState(null)  // null | array de filas sospechosas

  const { checkOutliers }    = usePriceRules()
  const { isRushHour }       = useRushHourConfig()

  // Procesa un único archivo (File) y devuelve array de sheets
  const parseSingleFile = async (file) => {
    const buf = await file.arrayBuffer()
    const wb  = XLSX.read(buf, { type: 'array', cellDates: false })

    // Para CSV el sheet name suele ser "Sheet1" — usar nombre de archivo como contexto
    const fileCity = detectCity(file.name.replace(/\.[^.]+$/, ''))

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
      // Ciudad: primero intenta por nombre de pestaña, luego por nombre de archivo
      let city = detectCity(sheetName) ?? fileCity
      // Forzar que la ciudad detectada pertenezca al país activo
      if (city && !config.dbCities.includes(city)) {
          city = config.dbCities[0] 
      }
      if (!city) city = config.dbCities[0]

      const sheet = wb.Sheets[sheetName]
      const raw   = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null })
      const { rows, droppedNoDate, droppedNoCompetitor } = parseRows(raw, city)
      if (rows.length === 0 && droppedNoDate === 0 && droppedNoCompetitor === 0) continue

      // Etiqueta legible: usar nombre de archivo para CSV (una sola hoja)
      const label = wb.SheetNames.length === 1
        ? file.name.replace(/\.[^.]+$/, '')
        : sheetName

      parsed.push({ name: label, city, rowCount: rows.length, droppedNoDate, droppedNoCompetitor, rows })
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
      setParsing(`Procesando ${i + 1}/${files.length}: ${file.name}…`)
      // Dar un tick al navegador para que renderice el mensaje
      await new Promise(r => setTimeout(r, 0))

      const fileParsed = await parseSingleFile(file)
      allParsed.push(...fileParsed)
    }

    setParsing(null)

    const allRows = allParsed.flatMap(s => s.rows)
    setSheets(allParsed)
    setAllRows(allRows)
    setPreview(allRows.slice(0, 20).map(r => ({
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

  // Llamado cuando el usuario hace click en "Insertar N filas"
  // Primero valida outliers; si los hay muestra OutlierReview
  const handleIngestClick = () => {
    const { ok, suspects: found } = checkOutliers(allRows)
    if (found.length > 0) {
      setSuspects(found)  // muestra el panel de revisión
    } else {
      handleIngest(allRows)
    }
  }

  // Llamado desde OutlierReview cuando el usuario confirma
  const handleOutlierConfirm = (corrections) => {
    const finalRows = allRows.map((row, idx) => {
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
    setProgress({ current: 0, total: rowsToInsert.length, done: false, error: null })

    const batchId = crypto.randomUUID()

    // ── Paso 1: Calcular rangos fecha+ciudad para el DELETE ────────────────
    const cityDateRanges = {}
    for (const r of rowsToInsert) {
      if (!r.city || !r.observed_date) continue
      if (!cityDateRanges[r.city]) cityDateRanges[r.city] = { min: r.observed_date, max: r.observed_date }
      if (r.observed_date < cityDateRanges[r.city].min) cityDateRanges[r.city].min = r.observed_date
      if (r.observed_date > cityDateRanges[r.city].max) cityDateRanges[r.city].max = r.observed_date
    }
    const cityRanges = Object.entries(cityDateRanges).map(([city, { min, max }]) =>
      ({ city, min_date: min, max_date: max })
    )

    // ── Paso 2: Pre-computar campos calculados en cada fila ────────────────
    const finalRows = rowsToInsert.map(r => {
      let row = {
        ...r,
        country,
        data_source:     'manual',
        upload_batch_id: batchId,
        rush_hour: r.observed_time
          ? (isRushHour(r.observed_time, r.city) ?? r.rush_hour)
          : r.rush_hour,
      }
      // Para InDrive: calcular minimal_bid y price_without_discount desde bids
      // si las fórmulas de Excel no fueron evaluadas (llegan como 0 o null)
      if (row.competition_name === 'InDrive') {
        const bidVals = [row.bid_1, row.bid_2, row.bid_3, row.bid_4, row.bid_5]
          .map(b => parseFloat(b)).filter(n => !isNaN(n) && n > 0)
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

    // ── Paso 3: DELETE + INSERT atómico vía RPC ────────────────────────────
    // La función PL/pgSQL corre en una sola transacción: si el INSERT falla,
    // el DELETE se revierte y los datos originales quedan intactos.
    const { error } = await sb.rpc('upsert_pricing_batch', {
      p_rows:       finalRows,
      p_city_ranges: cityRanges,
      p_batch_id:   batchId,
      p_filename:   sheets.map(s => s.name).join(', '),
      p_row_count:  finalRows.length,
    })

    if (error) {
      setProgress(p => ({ ...p, error: error.message, done: false }))
      return
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
      <h1>Cargar Data</h1>

      {/* Sub-tabs */}
      <div className="upload-tabs">
        <button
          className={`upload-tab${uploadTab === 'manual' ? ' active' : ''}`}
          onClick={() => setUploadTab('manual')}
        >
          📋 Excel / CSV Manual
        </button>
        <button
          className={`upload-tab${uploadTab === 'bot' ? ' active' : ''}`}
          onClick={() => setUploadTab('bot')}
        >
          🤖 Bot Data
        </button>
        <button
          className={`upload-tab${uploadTab === 'convert' ? ' active' : ''}`}
          onClick={() => setUploadTab('convert')}
        >
          🔄 Bot → Excel
        </button>
      </div>

      {/* Bot upload to DB */}
      {uploadTab === 'bot' && <BotUpload country={country} />}

      {/* Bot → Excel converter */}
      {uploadTab === 'convert' && <BotConverter />}

      {/* Manual upload */}
      {uploadTab === 'manual' && <>
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
          <h2>Archivos detectados — verifica la ciudad asignada</h2>
          <table className="config-table">
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Archivo / Pestaña</th>
                <th style={{ textAlign: 'left' }}>Ciudad detectada</th>
                <th># Filas válidas</th>
                <th style={{ textAlign: 'left' }}>Descartadas</th>
              </tr>
            </thead>
            <tbody>
              {sheets.map((s, i) => {
                const dropped = (s.droppedNoDate || 0) + (s.droppedNoCompetitor || 0)
                return (
                  <tr key={i}>
                    <td style={{ textAlign: 'left', fontFamily: 'monospace', fontSize: 11 }}>{s.name}</td>
                    <td>
                      <select
                        value={s.city}
                        onChange={e => updateSheetCity(i, e.target.value)}
                        style={{ fontSize: 12, padding: '2px 4px' }}
                      >
                        {config.dbCities.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </td>
                    <td style={{ textAlign: 'right' }}>{s.rowCount.toLocaleString()}</td>
                    <td style={{ fontSize: 11, color: dropped > 0 ? '#dc2626' : '#9ca3af' }}>
                      {dropped > 0
                        ? `⚠ ${dropped} (${s.droppedNoDate} sin fecha · ${s.droppedNoCompetitor} sin competidor)`
                        : '—'}
                    </td>
                  </tr>
                )
              })}
              <tr style={{ background: '#f9fbe7', fontWeight: 700 }}>
                <td style={{ textAlign: 'left' }}>TOTAL</td>
                <td></td>
                <td style={{ textAlign: 'right' }}>{allRows.length.toLocaleString()}</td>
                <td></td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

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

      {allRows.length > 0 && (
        <div className="upload-actions">
          {!progress?.done && (
            <>
              <div className="upload-overwrite-notice">
                ⚠️ Al insertar se <strong>borrarán automáticamente</strong> las filas existentes
                del mismo rango de fechas y ciudad, luego se insertan las nuevas.
                Subir el mismo Excel dos veces no genera duplicados.
              </div>
              <button
                className="btn-ingest"
                onClick={handleIngestClick}
                disabled={!!progress && !progress.done && !progress.error}
              >
                Insertar {allRows.length.toLocaleString()} filas en Supabase
              </button>
            </>
          )}
          <button className="btn-clear" onClick={handleClear}>Limpiar</button>
        </div>
      )}
      </>}
    </div>
  )
}
