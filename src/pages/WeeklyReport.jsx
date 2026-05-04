import { useState, useMemo, useEffect } from 'react'
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import { sb }              from '../lib/supabase'
import { useAuth }         from '../lib/auth'
import { BRACKETS, BRACKET_LABELS, getCompetitors, getCountryConfig, resolveDbParams } from '../lib/constants'
import { getISOYearWeek } from '../lib/dateUtils'
import { useI18n }       from '../context/LanguageContext'
import '../styles/weekly-report.css'

// ── Helpers ────────────────────────────────────────────────────────────────
// Misma lógica que src/algorithms/semaforo.js — Verde 5-10%, Amarillo 1-5% ó 10-12%
function getSemaforoClass(delta) {
  if (delta == null || isNaN(delta)) return 'none'
  const d = Number(delta)
  if (d >= 5 && d <= 10)                         return 'green'
  if ((d >= 1 && d < 5) || (d > 10 && d <= 12))  return 'yellow'
  return 'red'
}

function makeFmt(currency) {
  return (n) => {
    if (n == null || isNaN(n)) return '—'
    return `${currency} ${Number(n).toFixed(2)}`
  }
}

function fmtPct(n) {
  if (n == null || isNaN(n)) return '—'
  return `${n > 0 ? '+' : ''}${Number(n).toFixed(1)}%`
}

function aggregate(rows) {
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

function buildMatrices(catItem) {
  const { currAgg, prevAgg, competitors } = catItem
  const activeBrackets = BRACKETS.filter(b =>
    competitors.some(c => currAgg[c]?.[b] || prevAgg[c]?.[b])
  )
  const priceRows = activeBrackets.map(bracket => {
    const row = { bracket }
    for (const comp of competitors) row[comp] = currAgg[comp]?.[bracket]?.avg ?? null
    return row
  })
  const deltaRows = activeBrackets.map(bracket => {
    const row = { bracket }
    for (const comp of competitors) {
      const c = currAgg[comp]?.[bracket]?.avg
      const p = prevAgg[comp]?.[bracket]?.avg
      row[comp] = (c != null && p != null && p !== 0) ? ((c - p) / p) * 100 : null
    }
    return row
  })
  return { priceRows, deltaRows }
}

import { useCountry } from '../context/CountryContext'

// ── Main component ──────────────────────────────────────────────────────────
export default function WeeklyReport() {
  const { session }  = useAuth()
  const userEmail    = session?.user?.email || ''
  const now          = getISOYearWeek()
  const { t, locale } = useI18n()
  const { country, countryConfig } = useCountry()
  const uiCities = countryConfig.cities

  const [uiCity,   setUiCity]   = useState(uiCities[0] || 'Lima')
  const [uiCat,    setUiCat]    = useState(countryConfig.categoriesByCity[uiCities[0] || 'Lima']?.[0] || 'Economy')
  const [refYear,  setRefYear]  = useState(now.year)
  const [refWeek,  setRefWeek]  = useState(now.week)
  const [compareYear, setCompareYear] = useState(now.week > 1 ? now.year : now.year - 1)
  const [compareWeek, setCompareWeek] = useState(now.week > 1 ? now.week - 1 : 52)

  // reportDataList is always an array of { cat, currAgg, prevAgg, competitors }
  const [reportDataList, setReportDataList] = useState(null)
  const [loading,        setLoading]        = useState(false)
  const [generatingPdf,  setGeneratingPdf]  = useState(false)

  const { currency } = countryConfig

  // Reset city+category when country changes
  useEffect(() => {
    const firstCity = countryConfig.cities[0]
    setUiCity(firstCity)
    const cats = countryConfig.categoriesByCity[firstCity] || []
    setUiCat(cats[0] || 'Economy')
    setReportDataList(null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [country])

  // Reset category when city changes
  useEffect(() => {
    const cats = countryConfig.categoriesByCity[uiCity] || []
    setUiCat(cats[0] || 'Economy')
    setReportDataList(null)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uiCity])
  const fmt           = useMemo(() => makeFmt(countryConfig.currency), [countryConfig])
  const { dbCity }    = useMemo(() => resolveDbParams(uiCity, uiCat, null, country), [uiCity, uiCat, country])
  const baseCats      = countryConfig.categoriesByCity[uiCity] || []
  const categories    = ['Todos', ...baseCats]

  // ── Fetch single category ───────────────────────────────────────────────
  async function fetchCat(cat) {
    const { dbCategory: dbCat } = resolveDbParams(uiCity, cat, null, country)
    const [{ data: curr }, { data: prev }] = await Promise.all([
      sb.from('pricing_observations')
        .select('competition_name, distance_bracket, price_without_discount')
        .eq('country', country)
        .eq('city', dbCity).eq('category', dbCat)
        .eq('year', refYear).eq('week', refWeek)
        .not('price_without_discount', 'is', null),
      sb.from('pricing_observations')
        .select('competition_name, distance_bracket, price_without_discount')
        .eq('country', country)
        .eq('city', dbCity).eq('category', dbCat)
        .eq('year', compareYear).eq('week', compareWeek)
        .not('price_without_discount', 'is', null),
    ])
    const currAgg = aggregate(curr)
    const prevAgg = aggregate(prev)
    const baseComps = getCompetitors(uiCity, cat, null, country)
    const competitors = [
      ...new Set([...baseComps, ...Object.keys(currAgg), ...Object.keys(prevAgg)]),
    ].sort()
    return { cat, currAgg, prevAgg, competitors }
  }

  // ── Load report data ────────────────────────────────────────────────────
  async function loadReportData() {
    setLoading(true)
    setReportDataList(null)
    const catsToLoad = uiCat === 'Todos' ? baseCats : [uiCat]
    const results = await Promise.all(catsToLoad.map(cat => fetchCat(cat)))
    setReportDataList(results)
    setLoading(false)
  }

  // ── Computed matrices per category ──────────────────────────────────────
  const catMatrices = useMemo(() => {
    if (!reportDataList) return []
    return reportDataList.map(item => ({ ...item, ...buildMatrices(item) }))
  }, [reportDataList])

  // ── Generate PDF ────────────────────────────────────────────────────────
  function generatePDF() {
    if (!catMatrices.length) return
    setGeneratingPdf(true)
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })

    // Title page
    doc.setFontSize(14); doc.setFont('helvetica', 'bold')
    doc.text(`Reporte CI Semanal — ${uiCity}${uiCat !== 'Todos' ? ` — ${uiCat}` : ' — Todas las categorías'}`, 14, 18)
    doc.setFontSize(10); doc.setFont('helvetica', 'normal'); doc.setTextColor(100)
    doc.text(
      `Semana ${refWeek}/${refYear}  vs  Semana ${compareWeek}/${compareYear}   ·   Generado: ${new Date().toLocaleString('es-PE')}   ·   ${userEmail}`,
      14, 25,
    )
    doc.setTextColor(0)

    let startY = 34

    for (const { cat, competitors, priceRows, deltaRows } of catMatrices) {
      if (!competitors.length) continue

      // Category header
      doc.setFontSize(12); doc.setFont('helvetica', 'bold')
      doc.text(cat, 14, startY)

      // Price matrix
      doc.setFontSize(10); doc.setFont('helvetica', 'bold')
      doc.text(`Precios Promedio por Bracket (${currency})`, 14, startY + 6)
      autoTable(doc, {
        startY: startY + 10,
        head:   [['Bracket', ...competitors]],
        body:   priceRows.map(row => [
          BRACKET_LABELS[row.bracket] || row.bracket,
          ...competitors.map(c => row[c] != null ? fmt(row[c]) : '—'),
        ]),
        styles:       { fontSize: 9, cellPadding: 3 },
        headStyles:   { fillColor: [229, 57, 53], textColor: 255, fontStyle: 'bold' },
        columnStyles: { 0: { fontStyle: 'bold', cellWidth: 30 } },
        alternateRowStyles: { fillColor: [248, 250, 252] },
      })

      // Delta matrix
      const deltaY = doc.lastAutoTable.finalY + 6
      doc.setFontSize(10); doc.setFont('helvetica', 'bold')
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
        styles:     { fontSize: 9, cellPadding: 3 },
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

      startY = doc.lastAutoTable.finalY + 16

      // Add new page if needed for next category (but not for last)
      if (catMatrices.indexOf(catMatrices.find(m => m.cat === cat)) < catMatrices.length - 1) {
        if (startY > 160) { doc.addPage(); startY = 20 }
      }
    }

    doc.save(`reporte-ci-${uiCity}-${uiCat === 'Todos' ? 'todas' : uiCat}-semana${refWeek}-${refYear}.pdf`.replace(/\//g, '-'))
    setGeneratingPdf(false)
  }

  // ── Render ─────────────────────────────────────────────────────────────
  const hasData = catMatrices.some(m => m.competitors.length > 0)

  return (
    <div className="report-page">
      <h1>{t('report.title')}</h1>

      {/* ── Filters ── */}
      <div className="report-filters">
        <label className="report-ctrl">
          <span className="report-ctrl__label">{t('filter.city')}</span>
          <select value={uiCity} onChange={e => {
            setUiCity(e.target.value)
            setUiCat('Todos')
            setReportDataList(null)
          }}>
            {uiCities.map(c => <option key={c}>{c}</option>)}
          </select>
        </label>

        <label className="report-ctrl">
          <span className="report-ctrl__label">{t('filter.category')}</span>
          <select value={uiCat} onChange={e => { setUiCat(e.target.value); setReportDataList(null) }}>
            {categories.map(c => <option key={c}>{c}</option>)}
          </select>
        </label>

        <label className="report-ctrl">
          <span className="report-ctrl__label">{t('report.week_current')}</span>
          <input type="number" value={refWeek} min="1" max="53" style={{ width: 54 }} onChange={e => setRefWeek(Number(e.target.value))} />
          <span style={{ fontSize: 11, color: 'var(--color-muted)' }}>/</span>
          <input type="number" value={refYear} min="2020" max="2030" style={{ width: 70 }} onChange={e => setRefYear(Number(e.target.value))} />
        </label>

        <label className="report-ctrl">
          <span className="report-ctrl__label">{t('report.week_compare')}</span>
          <input type="number" value={compareWeek} min="1" max="53" style={{ width: 54 }} onChange={e => setCompareWeek(Number(e.target.value))} />
          <span style={{ fontSize: 11, color: 'var(--color-muted)' }}>/</span>
          <input type="number" value={compareYear} min="2020" max="2030" style={{ width: 70 }} onChange={e => setCompareYear(Number(e.target.value))} />
        </label>

        <button className="report-btn-generate" onClick={loadReportData} disabled={loading}>
          {loading ? t('app.loading') : t('report.load')}
        </button>
      </div>

      {/* ── Preview ── */}
      {loading && <div className="report-loading">{t('app.loading')}</div>}

      {!loading && catMatrices.length > 0 && !hasData && (
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
            <button className="report-btn-pdf" onClick={generatePDF} disabled={generatingPdf}>
              {generatingPdf ? t('report.generating') : t('report.download_pdf')}
            </button>
          </div>

          <div className="report-preview__body">
            {catMatrices.map(({ cat, competitors, priceRows, deltaRows }) => (
              <div key={cat}>
                {uiCat === 'Todos' && (
                  <div className="report-cat-header">{cat}</div>
                )}

                {competitors.length === 0 ? (
                  <div className="report-empty" style={{ marginBottom: 16 }}>
                    Sin datos para {cat} en Sem {refWeek}/{refYear}.
                  </div>
                ) : (
                  <>
                    {/* Summary cards */}
                    <div className="report-summary">
                      <div className="report-card">
                        <div className="report-card__label">Competidores</div>
                        <div className="report-card__value">{competitors.length}</div>
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
                      <div className="report-section__title">Precios Promedio ({currency})</div>
                      <div className="report-table-wrap">
                        <table className="report-table">
                          <thead>
                            <tr>
                              <th>Bracket</th>
                              {competitors.map(c => <th key={c}>{c}</th>)}
                            </tr>
                          </thead>
                          <tbody>
                            {priceRows.map(row => (
                              <tr key={row.bracket}>
                                <td>{BRACKET_LABELS[row.bracket] || row.bracket}</td>
                                {competitors.map(c => <td key={c}>{fmt(row[c])}</td>)}
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
                              {competitors.map(c => <th key={c}>{c}</th>)}
                            </tr>
                          </thead>
                          <tbody>
                            {deltaRows.map(row => (
                              <tr key={row.bracket}>
                                <td>{BRACKET_LABELS[row.bracket] || row.bracket}</td>
                                {competitors.map(c => {
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
                  </>
                )}
              </div>
            ))}

            <div className="report-footer">
              {userEmail || 'user'} · {new Date().toLocaleString(locale)}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
