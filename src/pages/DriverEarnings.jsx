import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip as RechartTooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts'
// jspdf (~390 KB) carga dinámicamente solo al hacer click en "Generar PDF".
import { fetchAllObservations } from '../lib/fetchAllObservations'
import { useAuth } from '../lib/auth'
import { COMPETITOR_COLORS, getCompetitors, resolveDbParams } from '../lib/constants'
import { normalizeCompetitorName } from '../lib/normalize'
import { resolveBonusWeekly, describeBonus, effectiveCommission } from '../lib/competitorBonus'
import { getISOYearWeek } from '../lib/dateUtils'
import { useCompetitorCommissions } from '../hooks/useCompetitorCommissions'
import { useCompetitorBonuses } from '../hooks/useCompetitorBonuses'
import { useEarningsScenarios } from '../hooks/useEarningsScenarios'
import CommissionsConfig from '../components/config/CommissionsConfig'
import BonusesConfig from '../components/config/BonusesConfig'
import { useI18n } from '../context/LanguageContext'
import { Button } from '../components/ui/shadcn/button'
import '../styles/driver-earnings.css'

// (city/category constants are derived dynamically from COUNTRY_CONFIG via props)

// ── Helpers ─────────────────────────────────────────────────────────────────
function formatWeekLabel(year, week) {
  return `Sem ${week} / ${year}`
}

// ── Currency formatter ──────────────────────────────────────────────────────
function makeFmt(currency) {
  return (n) => {
    if (n == null || isNaN(n)) return '—'
    return `${currency} ${n.toFixed(2)}`
  }
}

import { useCountry } from '../context/CountryContext'

// ── Main component ──────────────────────────────────────────────────────────
export default function DriverEarnings() {
  const { session } = useAuth()
  const userEmail = session?.user?.email || ''
  const { t, locale } = useI18n()
  const { country, countryConfig, dbConfigs } = useCountry()
  const uiCities = countryConfig.cities

  const [uiCity, setUiCity] = useState(uiCities[0] || 'Lima')
  const [uiCat, setUiCat] = useState(
    countryConfig.categoriesByCity[uiCities[0] || 'Lima']?.[0] || 'Economy'
  )
  const [refYear, setRefYear] = useState(() => getISOYearWeek().year)
  const [refWeek, setRefWeek] = useState(() => getISOYearWeek().week)
  const [hoursPerWeek, setHoursPerWeek] = useState(40)
  const [tripScale, setTripScale] = useState([10, 20, 30, 40, 50])
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState(null)
  const [showBonuses, setShowBonuses] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [showConfigPanel, setShowConfigPanel] = useState(false)
  const [configTab, setConfigTab] = useState('commissions')

  // Loaded from DB
  const [avgPrices, setAvgPrices] = useState({}) // comp → {avg, count}
  const [priceEdits, setPriceEdits] = useState({}) // comp → overridden value
  const [loadingPrices, setLoadingPrices] = useState(false)

  // Cascada: reseteo cuando cambia el país
  useEffect(() => {
    const firstCity = countryConfig.cities[0]
    setUiCity(firstCity)
    const newCategories = countryConfig.categoriesByCity[firstCity] || []
    setUiCat(newCategories[0] || 'Economy')
  }, [country, countryConfig])

  const fmt = useMemo(() => makeFmt(countryConfig.currency), [countryConfig])
  const { currency } = countryConfig
  const { dbCity, dbCategory: dbCat } = useMemo(
    () => resolveDbParams(uiCity, uiCat, null, country, dbConfigs),
    [uiCity, uiCat, country, dbConfigs]
  )
  const categories = countryConfig.categoriesByCity[uiCity] || []

  const { commissions, allRows: commRows } = useCompetitorCommissions(dbCity, country)
  const { bonuses } = useCompetitorBonuses(dbCity, country)
  const {
    scenarios,
    loading: loadingHist,
    saveScenario,
    deleteScenario,
  } = useEarningsScenarios(dbCity, dbCat, country)

  // ── Load avg prices ────────────────────────────────────────────────────
  const loadPrices = useCallback(async () => {
    setLoadingPrices(true)
    setPriceEdits({})
    // Paginado: sin esto, el promedio de precios se calcularía sobre las
    // primeras 1000 obs (cap silencioso de la API) y los escenarios de
    // rentabilidad partirían de números truncados. Ver fetchAllObservations.
    const data = await fetchAllObservations('competition_name, price_without_discount', (q) =>
      q
        .eq('country', country)
        .eq('city', dbCity)
        .eq('category', dbCat)
        .eq('year', refYear)
        .eq('week', refWeek)
        .not('price_without_discount', 'is', null)
    )
    // Defense-in-depth: normalizar al competition_name al agregar para que
    // data legacy con variantes pegadas no quede en buckets fantasma fuera
    // del catálogo (ver getCompetitors abajo).
    const grouped = {}
    for (const row of data || []) {
      const comp =
        normalizeCompetitorName(row.competition_name, { city: dbCity }) || row.competition_name
      if (!grouped[comp]) grouped[comp] = { sum: 0, count: 0 }
      grouped[comp].sum += parseFloat(row.price_without_discount)
      grouped[comp].count += 1
    }
    const result = {}
    for (const [comp, { sum, count }] of Object.entries(grouped)) {
      result[comp] = { avg: sum / count, count }
    }
    setAvgPrices(result)
    setLoadingPrices(false)
  }, [country, dbCity, dbCat, refYear, refWeek])

  useEffect(() => {
    loadPrices()
  }, [loadPrices])

  // Reset city/category when country changes
  useEffect(() => {
    const firstCity = countryConfig.cities[0]
    setUiCity(firstCity)
    const cats = countryConfig.categoriesByCity[firstCity] || []
    setUiCat(cats[0] || 'Economy')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [country])

  // Reset category when city changes
  useEffect(() => {
    const cats = countryConfig.categoriesByCity[uiCity] || []
    setUiCat(cats[0] || 'Economy')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uiCity])

  // ── Effective price per competitor ─────────────────────────────────────
  const effectivePrices = useMemo(() => {
    const result = {}
    for (const [comp, data] of Object.entries(avgPrices)) {
      result[comp] = {
        price: priceEdits[comp] !== undefined ? parseFloat(priceEdits[comp]) : data.avg,
        count: data.count,
        edited: priceEdits[comp] !== undefined,
      }
    }
    return result
  }, [avgPrices, priceEdits])

  // ── Competitors to show (base = expected list from constants, plus any extras from data/commissions) ─
  const competitors = useMemo(() => {
    const fromConstants = getCompetitors(uiCity, uiCat, null, country, dbConfigs)
    const fromData = Object.keys(effectivePrices)
    const fromComms = commRows
      .filter((r) => !r.city || r.city === dbCity)
      .map((r) => r.competitor_name)
    return [...new Set([...fromConstants, ...fromData, ...fromComms])].sort()
  }, [effectivePrices, commRows, dbCity, uiCity, uiCat, country, dbConfigs])

  // ── Calculation ────────────────────────────────────────────────────────
  function calcCell(comp, n) {
    const priceData = effectivePrices[comp]
    if (!priceData || isNaN(priceData.price)) return null
    const commPct = commissions[comp] ?? 20
    // Comisión efectiva tras descuento de ventana (InDrive 1%); share default 0.25
    // (Ganancias no tiene arquetipo). Sin filas comm_discount → effComm == commPct.
    const effComm = effectiveCommission(commPct, bonuses[comp], 0.25, { dbCategory: dbCat })
    const netRides = priceData.price * n * (1 - effComm / 100)

    // Motor único (peldaño-máximo + mecanismos). Sustituye la suma plana anterior.
    const { total: totalBonus, applied: appliedBonuses } = resolveBonusWeekly(bonuses[comp], {
      trips: n,
      hours: hoursPerWeek,
      dbCategory: dbCat,
      fare: priceData.price,
      commPct,
    })
    return {
      netRides,
      totalBonus,
      total: netRides + totalBonus,
      commPct: effComm,
      pricePerTrip: priceData.price,
      appliedBonuses,
    }
  }

  // ── Chart data ─────────────────────────────────────────────────────────
  const chartData = useMemo(() => {
    const sortedScale = [...tripScale].sort((a, b) => a - b)
    return sortedScale.map((n) => {
      const point = { n }
      for (const comp of competitors) {
        const cell = calcCell(comp, n)
        point[comp] = cell ? parseFloat(cell.total.toFixed(2)) : null
      }
      return point
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripScale, competitors, effectivePrices, commissions, bonuses, hoursPerWeek])

  // ── Trip scale management ──────────────────────────────────────────────
  function updateScale(i, val) {
    const n = parseInt(val, 10)
    if (isNaN(n)) return
    setTripScale((prev) => {
      const next = [...prev]
      next[i] = n
      return next
    })
  }

  function addScalePoint() {
    if (tripScale.length >= 8) return
    const max = Math.max(...tripScale, 0)
    setTripScale((prev) => [...prev, max + 10])
  }

  function removeScalePoint(i) {
    if (tripScale.length <= 1) return
    setTripScale((prev) => prev.filter((_, j) => j !== i))
  }

  // ── Save scenario ──────────────────────────────────────────────────────
  async function handleSave() {
    if (!competitors.length) {
      setSaveMsg({ type: 'err', text: 'No hay datos de precios para guardar.' })
      return
    }
    setSaving(true)
    setSaveMsg(null)

    const resultsSnapshot = {}
    for (const comp of competitors) {
      resultsSnapshot[comp] = {}
      for (const n of tripScale) {
        const cell = calcCell(comp, n)
        resultsSnapshot[comp][n] = cell ? parseFloat(cell.total.toFixed(2)) : null
      }
    }

    const payload = {
      city: dbCity,
      category: dbCat,
      ref_year: refYear,
      ref_week: refWeek,
      trip_scale: tripScale,
      hours_per_week: hoursPerWeek,
      avg_prices: Object.fromEntries(
        competitors.map((c) => [c, effectivePrices[c]?.price ?? null])
      ),
      commissions: Object.fromEntries(competitors.map((c) => [c, commissions[c] ?? null])),
      bonuses: competitors.flatMap((c) =>
        (bonuses[c] || []).map((b) => ({
          competitor: c,
          mechanism: b.mechanism || 'flat',
          bonus_type: b.bonus_type,
          threshold: b.threshold,
          amount: b.bonus_amount,
          tiers: b.tiers || null,
          cap_amount: b.cap_amount ?? null,
          mult_pct: b.mult_pct ?? null,
          streak_spec: b.streak_spec || null,
          comm_pct: b.comm_pct ?? null,
          share_in_window: b.share_in_window ?? null,
          segment: b.segment,
          recurring: b.recurring,
          description: b.description,
        }))
      ),
      results: resultsSnapshot,
      notes: notes || null,
      user_email: userEmail,
    }

    const ok = await saveScenario(payload)
    if (ok) {
      setSaveMsg({ type: 'ok', text: '✓ Escenario guardado.' })
      setNotes('')
    } else {
      setSaveMsg({ type: 'err', text: 'Error al guardar.' })
    }
    setSaving(false)
  }

  // Helper: ¿este competidor es una variante de Yango?
  // Definido arriba de generateEarningsPDF para evitar TDZ si la función
  // se invoca antes de que el const sea evaluado.
  const isYango = (comp) => comp.startsWith('Yango') || comp.startsWith('yango')

  // ── Generate PDF ─────────────────────────────────────────────────────
  async function generateEarningsPDF() {
    // Dynamic import: ~390 KB diferidos hasta este click.
    const { default: jsPDF } = await import('jspdf')
    const { default: autoTable } = await import('jspdf-autotable')
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
    const ss = [...tripScale].sort((a, b) => a - b)

    // Title
    doc.setFontSize(14)
    doc.setFont('helvetica', 'bold')
    doc.text(`Comparador de Ganancias — ${uiCity} · ${uiCat}`, 14, 16)
    doc.setFontSize(9)
    doc.setFont('helvetica', 'normal')
    doc.setTextColor(100)
    doc.text(
      `${formatWeekLabel(refYear, refWeek)}   ·   Generado: ${new Date().toLocaleString('es-PE')}   ·   ${userEmail}`,
      14,
      22
    )
    doc.setTextColor(0)

    // Results matrix
    doc.setFontSize(11)
    doc.setFont('helvetica', 'bold')
    doc.text(`Ganancia Semanal Neta (${countryConfig.currency})`, 14, 30)
    autoTable(doc, {
      startY: 34,
      head: [['App', ...ss.map((n) => `${n} viajes`)]],
      body: competitors.map((comp) => {
        const row = [comp]
        for (const n of ss) {
          const cell = calcCell(comp, n)
          row.push(cell ? `${fmt(cell.total)}${cell.totalBonus > 0 ? ' ✦' : ''}` : '—')
        }
        return row
      }),
      styles: { fontSize: 9, cellPadding: 3 },
      headStyles: { fillColor: [229, 57, 53], textColor: 255, fontStyle: 'bold' },
      columnStyles: { 0: { fontStyle: 'bold', cellWidth: 36 } },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      didParseCell: (data) => {
        if (data.section === 'body' && data.column.index === 0) {
          const comp = data.cell.text[0]?.replace(' ✦', '')
          if (comp && isYango(comp)) data.cell.styles.fillColor = [254, 226, 226]
        }
      },
    })

    // Reference prices
    const refY = doc.lastAutoTable.finalY + 10
    doc.setFontSize(11)
    doc.setFont('helvetica', 'bold')
    doc.text('Precios de Referencia', 14, refY)
    autoTable(doc, {
      startY: refY + 4,
      head: [
        [
          'Competidor',
          `Precio prom. / viaje (${countryConfig.currency})`,
          '# Observaciones',
          'Comisión %',
        ],
      ],
      body: competitors.map((comp) => {
        const data = avgPrices[comp]
        const ep = effectivePrices[comp]
        return [
          comp,
          ep ? `${fmt(ep.price)}${priceEdits[comp] !== undefined ? ' (editado)' : ''}` : '—',
          data ? `${data.count} obs.` : '— sin datos',
          `${commissions[comp] ?? '—'} %`,
        ]
      }),
      styles: { fontSize: 9, cellPadding: 3 },
      headStyles: { fillColor: [71, 85, 105], textColor: 255, fontStyle: 'bold' },
      columnStyles: { 0: { fontStyle: 'bold', cellWidth: 40 } },
      alternateRowStyles: { fillColor: [248, 250, 252] },
    })

    // Bonuses
    const bonusRows = competitors.flatMap((comp) =>
      (bonuses[comp] || [])
        .filter((b) => !b.category || b.category === dbCat)
        .map((b) => [comp, describeBonus(b, countryConfig.currency), b.description || '—'])
    )
    if (bonusRows.length > 0) {
      const bonusY = doc.lastAutoTable.finalY + 10
      doc.setFontSize(11)
      doc.setFont('helvetica', 'bold')
      doc.text('Bonos de Referencia', 14, bonusY)
      autoTable(doc, {
        startY: bonusY + 4,
        head: [['Competidor', 'Bono', 'Descripción']],
        body: bonusRows,
        styles: { fontSize: 9, cellPadding: 3 },
        headStyles: { fillColor: [37, 99, 235], textColor: 255, fontStyle: 'bold' },
        columnStyles: { 0: { fontStyle: 'bold', cellWidth: 36 } },
        alternateRowStyles: { fillColor: [248, 250, 252] },
      })
    }

    if (notes) {
      const notesY = doc.lastAutoTable.finalY + 6
      doc.setFontSize(9)
      doc.setFont('helvetica', 'italic')
      doc.setTextColor(100)
      doc.text(`Notas: ${notes}`, 14, notesY)
    }

    doc.save(`ganancias-${uiCity}-${uiCat}-sem${refWeek}-${refYear}.pdf`.replace(/\//g, '-'))
  }

  // ── Sorted trip scale for display ─────────────────────────────────────
  const sortedScale = [...tripScale].sort((a, b) => a - b)

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="earn-page">
      <h1>{t('earnings.title')}</h1>
      <p className="earn-page__desc">{t('earnings.title')}</p>

      {/* ── Params ── */}
      <div className="earn-panel">
        <div className="earn-panel__header">
          <span className="earn-panel__title">{t('earnings.params')}</span>
        </div>
        <div className="earn-panel__body">
          {/* City tabs */}
          <div className="earn-city-tabs">
            {uiCities.map((c) => (
              <Button
                key={c}
                variant={uiCity === c ? 'default' : 'outline'}
                size="sm"
                className="rounded-full"
                onClick={() => setUiCity(c)}
              >
                {c}
              </Button>
            ))}
          </div>

          <div className="earn-controls">
            {/* Category */}
            <label className="earn-ctrl">
              <span className="earn-ctrl__label">{t('filter.category')}</span>
              <select value={uiCat} onChange={(e) => setUiCat(e.target.value)}>
                {categories.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>

            {/* Week reference */}
            <label className="earn-ctrl">
              <span className="earn-ctrl__label">{t('earnings.year')}</span>
              <input
                type="number"
                value={refYear}
                min="2020"
                max="2030"
                style={{ width: 72 }}
                onChange={(e) => setRefYear(Number(e.target.value))}
              />
            </label>

            <label className="earn-ctrl">
              <span className="earn-ctrl__label">{t('earnings.week')}</span>
              <input
                type="number"
                value={refWeek}
                min="1"
                max="53"
                style={{ width: 62 }}
                onChange={(e) => setRefWeek(Number(e.target.value))}
              />
            </label>

            {/* Hours/week */}
            <label className="earn-ctrl">
              <span className="earn-ctrl__label">{t('earnings.hours_per_week')}</span>
              <input
                type="number"
                value={hoursPerWeek}
                min="1"
                max="80"
                style={{ width: 66 }}
                onChange={(e) => setHoursPerWeek(Number(e.target.value))}
              />
            </label>
          </div>

          {/* Scale chips */}
          <div style={{ marginTop: 12 }}>
            <div className="earn-scale">
              <span className="earn-scale__label">{t('earnings.trip_scale')}</span>
              {tripScale.map((n, i) => (
                <div key={i} className="earn-chip">
                  <input
                    type="number"
                    value={n}
                    min="1"
                    onChange={(e) => updateScale(i, e.target.value)}
                  />
                  {tripScale.length > 1 && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-[18px] w-[18px] rounded-full p-0 text-[10px] text-muted hover:bg-red-100 hover:text-red-600"
                      onClick={() => removeScalePoint(i)}
                    >
                      ✕
                    </Button>
                  )}
                </div>
              ))}
              <Button
                variant="outline"
                className="h-auto rounded-full border-dashed border-yango bg-transparent px-3 py-1 text-xs font-bold text-yango hover:bg-yango/10"
                onClick={addScalePoint}
                disabled={tripScale.length >= 8}
              >
                {t('earnings.add')}
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* ── Reference prices ── */}
      <div className="earn-panel">
        <div className="earn-panel__header">
          <span className="earn-panel__title">
            {t('earnings.ref_prices')} — {uiCity} · {uiCat} · {formatWeekLabel(refYear, refWeek)}
          </span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          {loadingPrices ? (
            <div className="earn-no-data">{t('earnings.loading')}</div>
          ) : (
            <>
              {Object.keys(avgPrices).length === 0 && (
                <div className="earn-no-data" style={{ marginBottom: 8 }}>
                  No hay datos CI para{' '}
                  <strong>
                    {uiCity} · {uiCat} · {formatWeekLabel(refYear, refWeek)}
                  </strong>
                  . Puedes ingresar precios manualmente en las celdas de abajo.
                </div>
              )}
              <table className="earn-ref-table">
                <thead>
                  <tr>
                    <th>{t('earnings.col_competitor')}</th>
                    <th>{t('earnings.col_avg_price_trip')}</th>
                    <th>{t('earnings.col_observations')}</th>
                    <th>{t('earnings.col_commission_pct')}</th>
                  </tr>
                </thead>
                <tbody>
                  {competitors.map((comp) => {
                    const data = avgPrices[comp]
                    const displayVal =
                      priceEdits[comp] !== undefined
                        ? priceEdits[comp]
                        : data
                          ? data.avg.toFixed(2)
                          : ''
                    return (
                      <tr key={comp} className={!data ? 'earn-ref-row--nodata' : ''}>
                        <td>
                          <strong>{comp}</strong>
                        </td>
                        <td>
                          <input
                            type="number"
                            className={`earn-ref-input${priceEdits[comp] !== undefined ? ' earn-ref-input--edited' : ''}${!data ? ' earn-ref-input--manual' : ''}`}
                            value={displayVal}
                            min="0"
                            step="0.01"
                            placeholder={data ? undefined : 'Ingresa precio…'}
                            onChange={(e) =>
                              setPriceEdits((prev) => ({ ...prev, [comp]: e.target.value }))
                            }
                          />
                        </td>
                        <td>
                          <span className="earn-ref-count">
                            {data ? `${data.count} obs.` : '— sin datos'}
                          </span>
                        </td>
                        <td>
                          <span className="earn-ref-count">{commissions[comp] ?? '—'} %</span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>

      {/* ── Results ── */}
      {competitors.length > 0 && (
        <div className="earn-panel">
          <div className="earn-panel__header">
            <span className="earn-panel__title">
              {t('earnings.weekly_earnings')} ({countryConfig.currency})
            </span>
          </div>
          <div className="earn-panel__body">
            {/* Matrix */}
            <div className="earn-matrix-wrap">
              <table className="earn-matrix">
                <thead>
                  <tr>
                    <th>App</th>
                    {sortedScale.map((n) => (
                      <th key={n}>{n} viajes</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {competitors.map((comp) => (
                    <tr key={comp} className={isYango(comp) ? 'earn-row--yango' : ''}>
                      <td>{comp}</td>
                      {sortedScale.map((n) => {
                        const cell = calcCell(comp, n)
                        if (!cell)
                          return (
                            <td key={n} className="earn-cell--empty">
                              —
                            </td>
                          )
                        return (
                          <td key={n}>
                            <div className="earn-cell-wrap">
                              <div className="earn-cell">
                                <span className="earn-cell__amount">{fmt(cell.total)}</span>
                                {cell.totalBonus > 0 && (
                                  <span
                                    className="earn-cell__bonus"
                                    title={t('earnings.includes_bonus')}
                                  >
                                    ✦
                                  </span>
                                )}
                              </div>
                              {/* Tooltip */}
                              <div className="earn-tooltip">
                                <div className="earn-tooltip__row">
                                  <span className="earn-tooltip__label">
                                    {t('earnings.price_per_trip')}
                                  </span>
                                  <span className="earn-tooltip__val">
                                    {fmt(cell.pricePerTrip)}
                                  </span>
                                </div>
                                <div className="earn-tooltip__row">
                                  <span className="earn-tooltip__label">× {n} viajes</span>
                                  <span className="earn-tooltip__val">
                                    {fmt(cell.pricePerTrip * n)}
                                  </span>
                                </div>
                                <div className="earn-tooltip__row">
                                  <span className="earn-tooltip__label">
                                    − Comisión {cell.commPct}%
                                  </span>
                                  <span className="earn-tooltip__val">
                                    − {fmt((cell.pricePerTrip * n * cell.commPct) / 100)}
                                  </span>
                                </div>
                                {cell.totalBonus > 0 && (
                                  <div className="earn-tooltip__row">
                                    <span className="earn-tooltip__label">
                                      + {t('earnings.bonus')}
                                    </span>
                                    <span className="earn-tooltip__val">
                                      + {fmt(cell.totalBonus)}
                                    </span>
                                  </div>
                                )}
                                <div className="earn-tooltip__row earn-tooltip__total">
                                  <span className="earn-tooltip__label">
                                    {t('earnings.net_total')}
                                  </span>
                                  <span className="earn-tooltip__val">{fmt(cell.total)}</span>
                                </div>
                              </div>
                            </div>
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Chart */}
            <div className="earn-chart-wrap">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="n" tickFormatter={(v) => `${v} viajes`} tick={{ fontSize: 10 }} />
                  <YAxis
                    tickFormatter={(v) => `${currency} ${v}`}
                    tick={{ fontSize: 10 }}
                    width={60}
                  />
                  <RechartTooltip
                    formatter={(val, name) => [`${currency} ${val?.toFixed(2) ?? '—'}`, name]}
                    labelFormatter={(v) => `${v} viajes/semana`}
                  />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  {competitors.map((comp) => (
                    <Line
                      key={comp}
                      dataKey={comp}
                      stroke={COMPETITOR_COLORS[comp] || '#94a3b8'}
                      strokeWidth={isYango(comp) ? 2.5 : 1.5}
                      dot={{ r: 3 }}
                      connectNulls={false}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* Bonuses summary */}
            <div className="earn-bonuses-section">
              <button className="earn-bonuses-toggle" onClick={() => setShowBonuses((p) => !p)}>
                {showBonuses ? '▲' : '▼'} Bonos aplicados
              </button>

              {showBonuses && (
                <div className="earn-bonuses-list">
                  {competitors.map((comp) => {
                    const compBonuses = (bonuses[comp] || []).filter(
                      (b) => !b.category || b.category === dbCat
                    )
                    if (!compBonuses.length) return null
                    return (
                      <div key={comp} style={{ marginBottom: 6 }}>
                        <strong style={{ fontSize: 12 }}>{comp}</strong>
                        <div style={{ marginTop: 4 }}>
                          {compBonuses.map((b, i) => (
                            <span
                              key={i}
                              className={`earn-bonus-chip earn-bonus-chip--${b.mechanism || b.bonus_type}`}
                            >
                              {describeBonus(b, currency)}
                              {b.description && ` · ${b.description}`}
                            </span>
                          ))}
                        </div>
                      </div>
                    )
                  })}
                  {competitors.every(
                    (c) =>
                      !(bonuses[c] || []).filter((b) => !b.category || b.category === dbCat).length
                  ) && (
                    <span style={{ fontSize: 12, color: 'var(--color-muted)' }}>
                      No hay bonos configurados. Agrega bonos en Config → Bonos.
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="earn-footer">
              <input
                className="earn-notes-input"
                type="text"
                placeholder={t('earnings.notes_placeholder')}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
              <Button
                variant="outline"
                className="hover:border-blue-500 hover:bg-blue-50 hover:text-blue-500"
                onClick={generateEarningsPDF}
              >
                {t('earnings.download_pdf')}
              </Button>
              <Button
                className="bg-green-800 hover:bg-green-900"
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? t('app.loading') : t('earnings.save_scenario')}
              </Button>
              {saveMsg && (
                <span className={saveMsg.type === 'ok' ? 'earn-msg--ok' : 'earn-msg--err'}>
                  {saveMsg.text}
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Inline config panel ── */}
      <div className="earn-config-panel">
        <button className="earn-config-panel__toggle" onClick={() => setShowConfigPanel((p) => !p)}>
          {showConfigPanel ? '▲' : '▼'} {t('earnings.config_panel')}
        </button>
        {showConfigPanel && (
          <div className="earn-config-panel__body">
            <div className="earn-config-tabs">
              <button
                className={`earn-config-tab${configTab === 'commissions' ? ' active' : ''}`}
                onClick={() => setConfigTab('commissions')}
              >
                {t('earnings.commissions')}
              </button>
              <button
                className={`earn-config-tab${configTab === 'bonuses' ? ' active' : ''}`}
                onClick={() => setConfigTab('bonuses')}
              >
                {t('earnings.bonuses')}
              </button>
            </div>
            {configTab === 'commissions' && <CommissionsConfig country={country} />}
            {configTab === 'bonuses' && <BonusesConfig country={country} />}
          </div>
        )}
      </div>

      {/* ── History ── */}
      <div>
        <button className="earn-history-toggle" onClick={() => setShowHistory((p) => !p)}>
          {showHistory ? '▲' : '▼'} Historial de escenarios ({scenarios.length})
        </button>

        {showHistory &&
          (loadingHist ? (
            <div style={{ fontSize: 12, color: 'var(--color-muted)', padding: '10px 0' }}>
              {t('app.loading')}
            </div>
          ) : scenarios.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--color-muted)', padding: '10px 0' }}>
              No hay escenarios guardados.
            </div>
          ) : (
            <div style={{ overflowX: 'auto', marginTop: 10 }}>
              <table className="earn-history-table">
                <thead>
                  <tr>
                    <th>{t('earnings.col_date')}</th>
                    <th>{t('earnings.col_ref_week')}</th>
                    <th>{t('earnings.col_scale')}</th>
                    <th>{t('earnings.col_notes')}</th>
                    <th>{t('earnings.col_user')}</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {scenarios.map((s) => (
                    <tr key={s.id}>
                      <td>{new Date(s.created_at).toLocaleDateString(locale)}</td>
                      <td>{formatWeekLabel(s.ref_year, s.ref_week)}</td>
                      <td>{(s.trip_scale || []).join(', ')}</td>
                      <td>{s.notes || '—'}</td>
                      <td style={{ color: 'var(--color-muted)' }}>{s.user_email || '—'}</td>
                      <td style={{ display: 'flex', gap: 4 }}>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-auto rounded-sm border-[#f5c6c6] bg-transparent px-2 py-0.5 text-[11px] text-[#dc3545] hover:border-[#dc3545] hover:bg-[var(--sem-red-bg)]"
                          onClick={() => deleteScenario(s.id)}
                        >
                          ✕
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
      </div>
    </div>
  )
}
