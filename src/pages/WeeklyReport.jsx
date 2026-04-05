import { useState, useMemo } from 'react'
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import { sb }              from '../lib/supabase'
import { useAuth }         from '../lib/auth'
import { BRACKETS, BRACKET_LABELS } from '../lib/constants'
import '../styles/weekly-report.css'

// ── Mappings ───────────────────────────────────────────────────────────────
const UI_CITIES = ['Lima', 'Trujillo', 'Arequipa', 'Aeropuerto', 'Corp']
const DB_CITY_MAP = {
  Lima: 'Lima', Trujillo: 'Trujillo', Arequipa: 'Arequipa',
  Aeropuerto: 'Airport', Corp: 'Corp',
}
const CATEGORIES_BY_DB_CITY = {
  Lima:     ['Economy', 'Comfort', 'Comfort+/Premier', 'TukTuk', 'XL'],
  Trujillo: ['Economy', 'Comfort/Comfort+'],
  Arequipa: ['Economy', 'Comfort/Comfort+'],
  Airport:  ['Economy', 'Comfort', 'Comfort+/Premier'],
  Corp:     ['Corp'],
}
const UI_CAT_TO_DB = {
  'Economy': 'Economy', 'Comfort': 'Comfort', 'Comfort+/Premier': 'Premier',
  'Comfort/Comfort+': 'Comfort', 'TukTuk': 'TukTuk', 'XL': 'XL', 'Corp': 'Corp',
}

// ── Semaforo ───────────────────────────────────────────────────────────────
// Returns 'green' | 'yellow' | 'red' | 'none' based on delta %
function getSemaforoClass(delta) {
  if (delta == null || isNaN(delta)) return 'none'
  const abs = Math.abs(delta)
  if (abs <= 5)  return 'green'
  if (abs <= 15) return 'yellow'
  return 'red'
}

// ── ISO week helper ────────────────────────────────────────────────────────
function getISOYearWeek(date = new Date()) {
  const d   = new Date(date)
  const day = d.getDay() || 7
  d.setDate(d.getDate() + 4 - day)
  const jan1 = new Date(d.getFullYear(), 0, 1)
  const week = Math.ceil(((d - jan1) / 86400000 + 1) / 7)
  return { year: d.getFullYear(), week }
}

function fmt(n) {
  if (n == null || isNaN(n)) return '—'
  return `S/ ${Number(n).toFixed(2)}`
}

function fmtPct(n) {
  if (n == null || isNaN(n)) return '—'
  return `${n > 0 ? '+' : ''}${Number(n).toFixed(1)}%`
}

// ── Main component ──────────────────────────────────────────────────────────
export default function WeeklyReport() {
  const { session }  = useAuth()
  const userEmail    = session?.user?.email || ''
  const now          = getISOYearWeek()

  const [uiCity,   setUiCity]   = useState('Lima')
  const [uiCat,    setUiCat]    = useState('Economy')
  const [refYear,  setRefYear]  = useState(now.year)
  const [refWeek,  setRefWeek]  = useState(now.week)
  const [compareYear, setCompareYear] = useState(now.week > 1 ? now.year : now.year - 1)
  const [compareWeek, setCompareWeek] = useState(now.week > 1 ? now.week - 1 : 52)

  const [reportData,  setReportData]  = useState(null)
  const [loading,     setLoading]     = useState(false)
  const [generatingPdf, setGeneratingPdf] = useState(false)

  const dbCity = DB_CITY_MAP[uiCity]
  const dbCat  = UI_CAT_TO_DB[uiCat] || uiCat
  const categories = CATEGORIES_BY_DB_CITY[dbCity] || []

  // ── Load report data ────────────────────────────────────────────────────
  async function loadReportData() {
    setLoading(true)
    setReportData(null)

    // Fetch current week
    const { data: curr } = await sb
      .from('pricing_observations')
      .select('competition_name, distance_bracket, price_without_discount')
      .eq('city',     dbCity)
      .eq('category', dbCat)
      .eq('year',     refYear)
      .eq('week',     refWeek)
      .not('price_without_discount', 'is', null)

    // Fetch comparison week
    const { data: prev } = await sb
      .from('pricing_observations')
      .select('competition_name, distance_bracket, price_without_discount')
      .eq('city',     dbCity)
      .eq('category', dbCat)
      .eq('year',     compareYear)
      .eq('week',     compareWeek)
      .not('price_without_discount', 'is', null)

    function aggregate(rows) {
      // Returns: { [competitor]: { [bracket]: { avg, count } } }
      const result = {}
      for (const row of (rows || [])) {
        const comp    = row.competition_name
        const bracket = row.distance_bracket
        if (!result[comp]) result[comp] = {}
        if (!result[comp][bracket]) result[comp][bracket] = { sum: 0, count: 0 }
        result[comp][bracket].sum   += parseFloat(row.price_without_discount)
        result[comp][bracket].count += 1
      }
      for (const comp of Object.keys(result)) {
        for (const bracket of Object.keys(result[comp])) {
          const { sum, count } = result[comp][bracket]
          result[comp][bracket].avg = sum / count
        }
      }
      return result
    }

    const currAgg = aggregate(curr)
    const prevAgg = aggregate(prev)

    const competitors = [...new Set([
      ...Object.keys(currAgg),
      ...Object.keys(prevAgg),
    ])].sort()

    setReportData({ currAgg, prevAgg, competitors })
    setLoading(false)
  }

  // ── Computed matrices ───────────────────────────────────────────────────
  const { priceRows, deltaRows } = useMemo(() => {
    if (!reportData) return { priceRows: [], deltaRows: [] }
    const { currAgg, prevAgg, competitors } = reportData
    const activeBrackets = BRACKETS.filter(b =>
      competitors.some(c => currAgg[c]?.[b] || prevAgg[c]?.[b])
    )

    const priceRows = activeBrackets.map(bracket => {
      const row = { bracket }
      for (const comp of competitors) {
        row[comp] = currAgg[comp]?.[bracket]?.avg ?? null
      }
      return row
    })

    const deltaRows = activeBrackets.map(bracket => {
      const row = { bracket }
      for (const comp of competitors) {
        const curr = currAgg[comp]?.[bracket]?.avg
        const prev = prevAgg[comp]?.[bracket]?.avg
        if (curr != null && prev != null && prev !== 0) {
          row[comp] = ((curr - prev) / prev) * 100
        } else {
          row[comp] = null
        }
      }
      return row
    })

    return { priceRows, deltaRows }
  }, [reportData])

  // ── Generate PDF ────────────────────────────────────────────────────────
  function generatePDF() {
    if (!reportData) return
    setGeneratingPdf(true)

    const { competitors } = reportData
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })

    // Title
    doc.setFontSize(14)
    doc.setFont('helvetica', 'bold')
    doc.text(`Reporte CI Semanal — ${uiCity} — ${uiCat}`, 14, 18)
    doc.setFontSize(10)
    doc.setFont('helvetica', 'normal')
    doc.setTextColor(100)
    doc.text(
      `Semana ${refWeek}/${refYear}  vs  Semana ${compareWeek}/${compareYear}   ·   Generado: ${new Date().toLocaleString('es-PE')}   ·   ${userEmail}`,
      14, 25,
    )
    doc.setTextColor(0)

    // Price matrix
    doc.setFontSize(11)
    doc.setFont('helvetica', 'bold')
    doc.text('Precios Promedio por Bracket (S/)', 14, 34)

    autoTable(doc, {
      startY: 38,
      head:   [['Bracket', ...competitors]],
      body:   priceRows.map(row => [
        BRACKET_LABELS[row.bracket] || row.bracket,
        ...competitors.map(c => row[c] != null ? `S/ ${Number(row[c]).toFixed(2)}` : '—'),
      ]),
      styles:       { fontSize: 9, cellPadding: 3 },
      headStyles:   { fillColor: [229, 57, 53], textColor: 255, fontStyle: 'bold' },
      columnStyles: { 0: { fontStyle: 'bold', cellWidth: 30 } },
      alternateRowStyles: { fillColor: [248, 250, 252] },
    })

    // Delta matrix
    const deltaY = doc.lastAutoTable.finalY + 10
    doc.setFontSize(11)
    doc.setFont('helvetica', 'bold')
    doc.text(`Variación % vs Semana ${compareWeek}/${compareYear}`, 14, deltaY)

    autoTable(doc, {
      startY: deltaY + 4,
      head:   [['Bracket', ...competitors]],
      body:   deltaRows.map(row => [
        BRACKET_LABELS[row.bracket] || row.bracket,
        ...competitors.map(c => {
          const v = row[c]
          if (v == null || isNaN(v)) return '—'
          return `${v > 0 ? '+' : ''}${v.toFixed(1)}%`
        }),
      ]),
      styles: { fontSize: 9, cellPadding: 3 },
      headStyles: { fillColor: [71, 85, 105], textColor: 255, fontStyle: 'bold' },
      columnStyles: { 0: { fontStyle: 'bold', cellWidth: 30 } },
      didParseCell: (data) => {
        if (data.section === 'body' && data.column.index > 0) {
          const val = deltaRows[data.row.index]?.[competitors[data.column.index - 1]]
          if (val == null || isNaN(val)) return
          const abs = Math.abs(val)
          if (abs <= 5)       data.cell.styles.fillColor = [212, 237, 218]
          else if (abs <= 15) data.cell.styles.fillColor = [255, 243, 205]
          else                data.cell.styles.fillColor = [248, 215, 218]
        }
      },
    })

    doc.save(`reporte-ci-${uiCity}-${uiCat}-semana${refWeek}-${refYear}.pdf`.replace(/\//g, '-'))
    setGeneratingPdf(false)
  }

  // ── Render ─────────────────────────────────────────────────────────────
  const hasData = reportData && reportData.competitors.length > 0

  return (
    <div className="report-page">
      <h1>Reporte Gerencial</h1>
      <p className="report-page__desc">
        Genera un PDF con la matriz de precios por bracket y la variación respecto a la semana anterior.
      </p>

      {/* ── Filters ── */}
      <div className="report-filters">
        <label className="report-ctrl">
          <span className="report-ctrl__label">Ciudad</span>
          <select value={uiCity} onChange={e => { setUiCity(e.target.value); setUiCat(CATEGORIES_BY_DB_CITY[DB_CITY_MAP[e.target.value]]?.[0] || 'Economy') }}>
            {UI_CITIES.map(c => <option key={c}>{c}</option>)}
          </select>
        </label>

        <label className="report-ctrl">
          <span className="report-ctrl__label">Categoría</span>
          <select value={uiCat} onChange={e => setUiCat(e.target.value)}>
            {categories.map(c => <option key={c}>{c}</option>)}
          </select>
        </label>

        <label className="report-ctrl">
          <span className="report-ctrl__label">Semana ref.</span>
          <input type="number" value={refWeek} min="1" max="53" style={{ width: 54 }} onChange={e => setRefWeek(Number(e.target.value))} />
          <span style={{ fontSize: 11, color: 'var(--color-muted)' }}>/</span>
          <input type="number" value={refYear} min="2020" max="2030" style={{ width: 70 }} onChange={e => setRefYear(Number(e.target.value))} />
        </label>

        <label className="report-ctrl">
          <span className="report-ctrl__label">Comparar con</span>
          <input type="number" value={compareWeek} min="1" max="53" style={{ width: 54 }} onChange={e => setCompareWeek(Number(e.target.value))} />
          <span style={{ fontSize: 11, color: 'var(--color-muted)' }}>/</span>
          <input type="number" value={compareYear} min="2020" max="2030" style={{ width: 70 }} onChange={e => setCompareYear(Number(e.target.value))} />
        </label>

        <button
          className="report-btn-generate"
          onClick={loadReportData}
          disabled={loading}
        >
          {loading ? 'Cargando…' : '🔍 Generar preview'}
        </button>
      </div>

      {/* ── Preview ── */}
      {loading && <div className="report-loading">Cargando datos…</div>}

      {!loading && reportData && !hasData && (
        <div className="report-empty">
          No hay datos CI para <strong>{uiCity} · {uiCat} · Sem {refWeek}/{refYear}</strong>.
          Ingresa datos en la pestaña "Ingresar CI" primero.
        </div>
      )}

      {!loading && hasData && (
        <div className="report-preview">
          <div className="report-preview__header">
            <span className="report-preview__title">
              {uiCity} · {uiCat} · Sem {refWeek}/{refYear}
            </span>
            <button
              className="report-btn-pdf"
              onClick={generatePDF}
              disabled={generatingPdf}
            >
              {generatingPdf ? 'Generando…' : '⬇️ Descargar PDF'}
            </button>
          </div>

          <div className="report-preview__body">
            {/* Summary cards */}
            <div className="report-summary">
              <div className="report-card">
                <div className="report-card__label">Competidores</div>
                <div className="report-card__value">{reportData.competitors.length}</div>
              </div>
              <div className="report-card">
                <div className="report-card__label">Brackets activos</div>
                <div className="report-card__value">{priceRows.length}</div>
              </div>
              <div className="report-card">
                <div className="report-card__label">Semana ref.</div>
                <div className="report-card__value">{refWeek}</div>
                <div className="report-card__sub">Año {refYear}</div>
              </div>
              <div className="report-card">
                <div className="report-card__label">Comparación</div>
                <div className="report-card__value">{compareWeek}</div>
                <div className="report-card__sub">Año {compareYear}</div>
              </div>
            </div>

            {/* Price matrix */}
            <div className="report-section">
              <div className="report-section__title">Precios Promedio (S/)</div>
              <div className="report-table-wrap">
                <table className="report-table">
                  <thead>
                    <tr>
                      <th>Bracket</th>
                      {reportData.competitors.map(c => <th key={c}>{c}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {priceRows.map(row => (
                      <tr key={row.bracket}>
                        <td>{BRACKET_LABELS[row.bracket] || row.bracket}</td>
                        {reportData.competitors.map(c => (
                          <td key={c}>{fmt(row[c])}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Delta matrix */}
            <div className="report-section">
              <div className="report-section__title">
                Variación % vs Sem {compareWeek}/{compareYear}
              </div>
              <div className="report-table-wrap">
                <table className="report-table">
                  <thead>
                    <tr>
                      <th>Bracket</th>
                      {reportData.competitors.map(c => <th key={c}>{c}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {deltaRows.map(row => (
                      <tr key={row.bracket}>
                        <td>{BRACKET_LABELS[row.bracket] || row.bracket}</td>
                        {reportData.competitors.map(c => {
                          const cls = getSemaforoClass(row[c])
                          return (
                            <td key={c} className={`report-cell--${cls}`}>
                              {fmtPct(row[c])}
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="report-footer">
              Generado por {userEmail || 'usuario'} · {new Date().toLocaleString('es-PE')}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
