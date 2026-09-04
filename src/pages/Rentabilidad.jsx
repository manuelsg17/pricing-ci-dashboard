import { useState, useEffect, useMemo } from 'react'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip as RechartTooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
  LabelList,
} from 'recharts'
import { COMPETITOR_COLORS, resolveDbParams } from '../lib/constants'
import { useConfigContext } from '../context/ConfigProvider'
import { getISOYearWeek, isoWeekMonday, toISODate } from '../lib/dateUtils'
import { isYangoBrand } from '../lib/normalize'
import { useCompetitorCommissions } from '../hooks/useCompetitorCommissions'
import { useCompetitorBonuses } from '../hooks/useCompetitorBonuses'
import { useCountry } from '../context/CountryContext'
import { useI18n } from '../context/LanguageContext'
import { useRentabilidadPrices } from '../hooks/useRentabilidadPrices'
import { useRentabilidadCompetitors } from '../hooks/useRentabilidadCompetitors'
import { useRentabilidadEngine } from '../hooks/useRentabilidadEngine'
import { useRentabilidadAnalysis } from '../hooks/useRentabilidadAnalysis'
import {
  DEFAULT_TOOLS_STATE,
  YANGO_TOOLS,
  YANGO_PARTNER_PCT,
  MI_ZONA_MAX_PCT,
  yangoScenarioCommission,
} from '../lib/yangoTools'
import { yangoGmvDetail, hasYangoGmvTable } from '../lib/yangoGmvBonus'
import MiZonaMap from '../components/rentabilidad/MiZonaMap'
import CollapsibleSection from '../components/market/CollapsibleSection'
import BonusSummaryByCity from '../components/dashboard/BonusSummaryByCity'
import { Button } from '../components/ui/shadcn/button'
import '../styles/rentabilidad.css'

// ── Helpers ─────────────────────────────────────────────────────────────────
// isYango: única implementación en lib/normalize (antes había 5 copias).
const isYango = isYangoBrand

function formatWeekLabel(year, week) {
  return `Sem ${week} / ${year}`
}

// ── Página: Rentabilidad (Unit Economics por tier) ──────────────────────────
// Build 1: barras de ganancia neta por tier (todas las categorías a la vez),
// Yango vs competidores, con la ganancia encima de cada barra. Escala de viajes
// configurable (segmentos + slider) y selector por viaje / por semana.
// Reusa el motor de DriverEarnings (precios CI + competitor_commissions/bonuses).
// Build 2: comisión de Yango apilable (base ciudad + partner + Mi Casa/Mis
// Destinos/Flex/Mi Zona, ver lib/yangoTools.js) + matriz E1/E4 + notas de fórmulas.
//
// Fase 1.2: el motor de pricing (precios, competidores, comisión apilable,
// análisis derivado) vive en 4 hooks dedicados (hooks/useRentabilidad*.js) —
// esta page es el orquestador + todo el render. Extracción preservando
// comportamiento: el JSX no cambió, solo de dónde vienen los valores.
export default function Rentabilidad() {
  const { t } = useI18n()
  const { country, countryConfig, dbConfigs } = useCountry()
  const { weights: dbWeights, yangoGmvTiers } = useConfigContext()
  const uiCities = countryConfig.cities
  const { currency } = countryConfig

  const [uiCity, setUiCity] = useState(uiCities[0] || 'Lima')
  const [refYear, setRefYear] = useState(() => getISOYearWeek().year)
  const [refWeek, setRefWeek] = useState(() => getISOYearWeek().week)
  const [hoursPerWeek, setHoursPerWeek] = useState(40)
  const [segments, setSegments] = useState([60, 90])
  const [liveTrips, setLiveTrips] = useState(70)
  const [metric, setMetric] = useState('trip') // 'trip' | 'week'
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [refTierCat, setRefTierCat] = useState(null) // tier de referencia elegido (null = auto)
  const [tools, setTools] = useState(DEFAULT_TOOLS_STATE) // herramientas Yango
  // Arquetipo de driver: define a quién se evalúan los bonos (segmento) y los
  // parámetros de ventana/racha (alimentan comm_discount InDrive, surge y streak Didi).
  const [archetype, setArchetype] = useState({ segment: 'active', sharePeak: 0.25, streakDays: 3 })
  const [branded, setBranded] = useState(false) // bono Yango GMV: con/sin brandeo (default sin)
  const [showDetail, setShowDetail] = useState(false) // tabla composición: columnas extra (comisión, % bonos)

  // Reset ciudad solo si la actual ya no existe en el país. Idempotente: así
  // un re-fetch de config (mount o edición de otro usuario vía realtime) que
  // cambia la identidad de countryConfig NO pisa la ciudad que el usuario eligió.
  useEffect(() => {
    if (!countryConfig.cities.includes(uiCity)) {
      setUiCity(countryConfig.cities[0] || 'Lima')
    }
  }, [country, countryConfig, uiCity])

  // Categorías UI de la ciudad + mapeo a (dbCity, dbCategory)
  const categories = useMemo(
    () => countryConfig.categoriesByCity[uiCity] || [],
    [countryConfig, uiCity]
  )
  const catMap = useMemo(
    () =>
      categories.map((uiCat) => {
        const { dbCity, dbCategory } = resolveDbParams(uiCity, uiCat, null, country, dbConfigs)
        return { uiCat, dbCity, dbCategory }
      }),
    [categories, uiCity, country, dbConfigs]
  )
  const dbCity = catMap[0]?.dbCity || uiCity
  const dbCategories = useMemo(() => [...new Set(catMap.map((c) => c.dbCategory))], [catMap])

  // Ventana de VIGENCIA de bonos y escaleras (mig 237): la semana elegida
  // completa (lunes → domingo). Un bono rige en la semana si SOLAPA con ella,
  // así uno cargado el jueves ya cuenta. Al mirar una semana pasada, los bonos
  // son los que regían entonces — antes eran siempre los de hoy.
  const asOf = useMemo(() => {
    const monday = isoWeekMonday(refYear, refWeek)
    const sunday = new Date(monday)
    sunday.setDate(monday.getDate() + 6)
    return { from: toISODate(monday), to: toISODate(sunday) }
  }, [refYear, refWeek])

  const { commissions, allRows: commRows } = useCompetitorCommissions(dbCity, country)
  const {
    bonuses,
    allRows: bonusRows,
    loading: bonusesLoading,
  } = useCompetitorBonuses(dbCity, country, asOf)
  const bonusCount = useMemo(
    () => Object.values(bonuses).reduce((s, rows) => s + rows.length, 0),
    [bonuses]
  )

  const { pricesByCat, loading } = useRentabilidadPrices({
    dbCity,
    dbCategories,
    country,
    refYear,
    refWeek,
    dbWeights,
  })

  const { shownCompetitors, visibleCompetitors, toggleComp } = useRentabilidadCompetitors({
    catMap,
    uiCity,
    dbCity,
    country,
    dbConfigs,
    pricesByCat,
    commRows,
    setRefTierCat,
  })

  const {
    yangoBasePct,
    isLima,
    miZonaRatio,
    miZonaPct,
    yangoExtraPct,
    yangoCommission,
    netFor,
    yangoNetAt,
    yangoKeyFor,
    netPerTrip,
    netParts,
  } = useRentabilidadEngine({
    dbCity,
    country,
    tools,
    archetype,
    hoursPerWeek,
    commissions,
    bonuses,
    pricesByCat,
    metric,
    branded,
    yangoGmvTiers,
    asOf,
  })

  const hasData = Object.keys(pricesByCat).length > 0

  const {
    chartDataFor,
    panels,
    tiersWithData,
    refTier,
    rivalCols,
    tierComparison,
    winSummary,
    toolCosts,
    breakEvens,
    oneOffs,
    breakdown,
    breakdownStats,
    hero,
  } = useRentabilidadAnalysis({
    catMap,
    visibleCompetitors,
    netFor,
    segments,
    liveTrips,
    pricesByCat,
    country,
    dbCity,
    refTierCat,
    yangoKeyFor,
    metric,
    tools,
    miZonaPct,
    yangoExtraPct,
    netPerTrip,
    bonuses,
    hoursPerWeek,
    commissions,
    archetype,
    hasData,
    asOf,
    netParts,
  })

  // ── Manejo de segmentos ────────────────────────────────────────────────
  function updateSegment(i, val) {
    const n = parseInt(val, 10)
    setSegments((prev) => prev.map((x, j) => (j === i ? (isNaN(n) ? x : n) : x)))
  }
  function addSegment() {
    if (segments.length >= 5) return
    setSegments((prev) => [...prev, Math.max(...prev, 0) + 30])
  }
  function removeSegment(i) {
    if (segments.length <= 1) return
    setSegments((prev) => prev.filter((_, j) => j !== i))
  }

  const fmt = (n) =>
    n == null || isNaN(n) ? '—' : `${currency} ${n.toFixed(metric === 'trip' ? 2 : 0)}`
  // Formateador a 2 decimales para la tabla "espejo del Excel" (siempre semanal).
  const fmt2 = (n) => (n == null || isNaN(n) ? '—' : `${currency} ${n.toFixed(2)}`)

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div className="rent-page" style={{ padding: '16px 20px', maxWidth: 1820 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 2 }}>{t('rentabilidad.title')}</h1>
      <p style={{ color: 'var(--color-muted)', fontSize: 13, marginBottom: 16 }}>
        {t('rentabilidad.subtitle')}
      </p>

      {/* ── RESULTADO (hero): la respuesta primero ── */}
      {hero && (
        <div
          style={{
            background: 'var(--color-panel, #fff)',
            border: '1px solid var(--color-border, #e2e8f0)',
            borderLeft: `4px solid ${hero.delta != null && hero.delta >= 0 ? '#16A34A' : '#DC2626'}`,
            borderRadius: 10,
            boxShadow: 'var(--shadow-sm)',
            padding: '14px 18px',
            marginBottom: 16,
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: 'var(--color-muted)',
              textTransform: 'uppercase',
              letterSpacing: 0.5,
            }}
          >
            📊 {refTier.uiCat} · {liveTrips} viajes/sem ·{' '}
            {metric === 'trip' ? t('rentabilidad.per_trip') : t('rentabilidad.per_week')}
          </div>
          <div
            style={{
              display: 'flex',
              gap: 24,
              flexWrap: 'wrap',
              alignItems: 'baseline',
              marginTop: 8,
            }}
          >
            <div>
              <span style={{ fontSize: 13, color: 'var(--color-muted)' }}>Yango </span>
              <span style={{ fontSize: 24, fontWeight: 800, color: 'var(--color-yango, #E53935)' }}>
                {fmt(hero.yNet)}
              </span>
            </div>
            {hero.bestComp && (
              <div>
                <span style={{ fontSize: 13, color: 'var(--color-muted)' }}>
                  vs {hero.bestComp}{' '}
                </span>
                <span style={{ fontSize: 20, fontWeight: 700 }}>{fmt(hero.bestNet)}</span>
              </div>
            )}
            {hero.delta != null && (
              <div
                style={{
                  fontSize: 20,
                  fontWeight: 800,
                  color: hero.delta >= 0 ? '#16A34A' : '#DC2626',
                }}
              >
                {hero.delta >= 0 ? '▲ +' : '▼ −'}
                {fmt(Math.abs(hero.delta))}
              </div>
            )}
          </div>
          {hero.total > 0 && (
            <div style={{ fontSize: 13, marginTop: 6 }}>
              Yango gana en{' '}
              <strong>
                {hero.won} de {hero.total}
              </strong>{' '}
              categorías a este volumen.
            </div>
          )}
        </div>
      )}

      {/* ── Parámetros ── */}
      <div className="rent-panel">
        {/* ── Controles principales ── */}
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label={t('filter.city')}>
            <select
              value={uiCity}
              onChange={(e) => setUiCity(e.target.value)}
              className="rent-select"
            >
              {uiCities.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Field>

          <Field label={t('rentabilidad.week')}>
            <input
              type="number"
              value={refWeek}
              min="1"
              max="53"
              className="rent-input"
              onChange={(e) => {
                const v = Number(e.target.value)
                if (v) setRefWeek(v)
              }}
            />
          </Field>

          {/* Qué bonos está usando el cálculo: los vigentes en la semana elegida (mig 237) */}
          <div
            style={{
              fontSize: 11,
              color: bonusCount === 0 && !bonusesLoading ? '#b45309' : 'var(--color-muted)',
              alignSelf: 'flex-end',
              paddingBottom: 6,
            }}
            title={t('rentabilidad.bonuses_as_of', { date: asOf.from })}
          >
            {t('rentabilidad.bonuses_as_of', { date: asOf.from })} ·{' '}
            {bonusCount === 0 && !bonusesLoading
              ? t('rentabilidad.no_bonuses_city', { city: uiCity })
              : t('rentabilidad.bonuses_count', { n: bonusCount })}
          </div>

          <Field label={t('rentabilidad.metric')}>
            <div
              style={{
                display: 'inline-flex',
                border: '1px solid var(--color-border, #e2e8f0)',
                borderRadius: 8,
                overflow: 'hidden',
              }}
            >
              <button onClick={() => setMetric('trip')} style={toggleStyle(metric === 'trip')}>
                {t('rentabilidad.per_trip')}
              </button>
              <button onClick={() => setMetric('week')} style={toggleStyle(metric === 'week')}>
                {t('rentabilidad.per_week')}
              </button>
            </div>
          </Field>

          <button
            type="button"
            onClick={() => setShowAdvanced((s) => !s)}
            className="rent-adv-toggle"
          >
            ⚙ Avanzado {showAdvanced ? '▴' : '▾'}
          </button>
        </div>

        {/* ── Avanzado: año, horas, segmentos (oculto por defecto) ── */}
        {showAdvanced && (
          <div
            style={{
              marginTop: 12,
              padding: 12,
              borderRadius: 8,
              background: 'var(--color-bg, #f8fafc)',
              border: '1px solid var(--color-border, #e2e8f0)',
              display: 'flex',
              gap: 18,
              flexWrap: 'wrap',
              alignItems: 'flex-end',
            }}
          >
            <Field label={t('rentabilidad.year')}>
              <input
                type="number"
                value={refYear}
                min="2020"
                max="2030"
                className="rent-input"
                onChange={(e) => {
                  const v = Number(e.target.value)
                  if (v) setRefYear(v)
                }}
              />
            </Field>
            <Field label={t('rentabilidad.hours_per_week')}>
              <input
                type="number"
                value={hoursPerWeek}
                min="1"
                max="80"
                className="rent-input"
                onChange={(e) => {
                  const v = Number(e.target.value)
                  if (v) setHoursPerWeek(v)
                }}
              />
            </Field>
            <Field label={t('rentabilidad.segments')}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                {segments.map((n, i) => (
                  <div key={i} className="rent-chip">
                    <input
                      type="number"
                      value={n}
                      min="1"
                      style={{ width: 52, border: 'none', background: 'transparent' }}
                      onChange={(e) => updateSegment(i, e.target.value)}
                    />
                    {segments.length > 1 && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-4 w-4 rounded-full p-0 text-[11px] text-slate-400 hover:bg-red-100 hover:text-red-600"
                        onClick={() => removeSegment(i)}
                      >
                        ✕
                      </Button>
                    )}
                  </div>
                ))}
                <Button
                  variant="outline"
                  size="sm"
                  className="h-auto rounded-md border-dashed border-border bg-transparent px-2 py-1 text-xs font-normal text-muted hover:bg-accent"
                  onClick={addSegment}
                  disabled={segments.length >= 5}
                >
                  + {t('rentabilidad.add_segment')}
                </Button>
              </div>
            </Field>
          </div>
        )}

        {/* Slider "en vivo" */}
        <div style={{ marginTop: 12, display: 'flex', gap: 12, alignItems: 'center' }}>
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--color-muted)',
              whiteSpace: 'nowrap',
            }}
          >
            {t('rentabilidad.live_trips')}
          </span>
          <input
            type="range"
            min="0"
            max="200"
            step="5"
            value={liveTrips}
            onChange={(e) => setLiveTrips(Number(e.target.value))}
            style={{ flex: 1, maxWidth: 420, accentColor: 'var(--color-yango, #E53935)' }}
          />
          <input
            type="number"
            min="0"
            max="400"
            value={liveTrips}
            className="rent-input"
            onChange={(e) => setLiveTrips(Number(e.target.value) || 0)}
          />
          <span style={{ fontSize: 12, color: 'var(--color-muted)' }}>
            {t('rentabilidad.trips_per_week_short')}
          </span>
        </div>

        {/* Selector de competidores — chips toggleables, label visible en cada barra */}
        {shownCompetitors.length > 0 && (
          <div
            style={{
              marginTop: 14,
              display: 'flex',
              gap: 6,
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-muted)' }}>
              {t('rentabilidad.competitors')}
            </span>
            {shownCompetitors.map((c) => {
              const active = visibleCompetitors.includes(c)
              const color = COMPETITOR_COLORS[c] || '#94a3b8'
              return (
                <Button
                  key={c}
                  type="button"
                  variant="outline"
                  className="h-auto gap-1.5 rounded-full px-2.5 py-0.5 text-xs"
                  style={{
                    border: '1px solid ' + (active ? color : 'var(--color-border, #e2e8f0)'),
                    background: active ? color : '#fff',
                    color: active ? '#fff' : 'var(--color-muted)',
                    fontWeight: active ? 600 : 400,
                    opacity: active ? 1 : 0.6,
                  }}
                  onClick={() => toggleComp(c)}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 999,
                      background: active ? '#fff' : color,
                      display: 'inline-block',
                    }}
                  />
                  {c}
                </Button>
              )
            })}
          </div>
        )}
      </div>

      {/* ── Herramientas Yango (comisión apilable) ── */}
      <CollapsibleSection
        id="rent-tools"
        title={t('rentabilidad.yango_tools')}
        subtitle={`${t('rentabilidad.total_commission')}: ${yangoCommission.toFixed(1)}% (${yangoBasePct}% ${t('rentabilidad.base_city')} + ${YANGO_PARTNER_PCT}% partner${yangoExtraPct > 0 ? ` + ${yangoExtraPct.toFixed(1)}% ${t('rentabilidad.tools_extra')}` : ''})`}
        defaultOpen={false}
      >
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <ToolToggle
            active={tools.mi_casa}
            onClick={() => setTools((s) => ({ ...s, mi_casa: !s.mi_casa }))}
            label={`${YANGO_TOOLS.mi_casa.label} +${YANGO_TOOLS.mi_casa.pct}%`}
          />
          <ToolToggle
            active={tools.mis_destinos}
            onClick={() => setTools((s) => ({ ...s, mis_destinos: !s.mis_destinos }))}
            label={`${YANGO_TOOLS.mis_destinos.label} +${YANGO_TOOLS.mis_destinos.pct}%`}
          />
          <ToolToggle
            active={tools.mi_zona.on}
            onClick={() =>
              setTools((s) => ({ ...s, mi_zona: { ...s.mi_zona, on: !s.mi_zona.on } }))
            }
            label={`Mi Zona +${miZonaPct.toFixed(1)}%`}
          />
          <ToolToggle
            active={branded}
            onClick={() => setBranded((b) => !b)}
            label={t('rentabilidad.branded')}
          />
        </div>

        {/* Readout del bono Yango por % de GMV (cash aditivo, no comisión) */}
        {hasYangoGmvTable(dbCity, yangoGmvTiers, asOf) &&
          refTier &&
          (() => {
            const fare = pricesByCat[refTier.dbCategory]?.[yangoKeyFor(refTier.dbCategory)]?.avg
            const d = yangoGmvDetail(
              dbCity,
              refTier.dbCategory,
              branded,
              fare,
              liveTrips,
              yangoGmvTiers,
              asOf
            )
            return (
              <div style={{ marginTop: 10, fontSize: 12, color: 'var(--color-muted)' }}>
                {t('rentabilidad.gmv_bonus')} (
                {branded ? t('rentabilidad.branded') : t('rentabilidad.unbranded')}) ·{' '}
                {refTier.uiCat} · {liveTrips} {t('rentabilidad.trips_week')}:{' '}
                {d ? (
                  <strong style={{ color: 'var(--color-yango, #E53935)' }}>
                    +{fmt(d.bono)} ({d.pct}% GMV, tope {currency} {d.cap})
                  </strong>
                ) : (
                  '—'
                )}
              </div>
            )
          })()}

        {/* Mi Zona — Lima: mapa de zonas clickeable (Fase 3); provincias: slider. */}
        {tools.mi_zona.on && isLima && (
          <div
            style={{
              marginTop: 12,
              display: 'flex',
              gap: 16,
              flexWrap: 'wrap',
              alignItems: 'flex-start',
            }}
          >
            <div style={{ flex: '0 1 460px', minWidth: 280 }}>
              <MiZonaMap
                selected={tools.mi_zona.zones}
                onToggle={(id) =>
                  setTools((s) => {
                    const set = new Set(s.mi_zona.zones)
                    if (set.has(id)) set.delete(id)
                    else set.add(id)
                    return { ...s, mi_zona: { ...s.mi_zona, zones: [...set] } }
                  })
                }
              />
            </div>
            <div style={{ fontSize: 13, minWidth: 200, flex: '1 1 200px' }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                {t('rentabilidad.mi_zona_select')}
              </div>
              <div style={{ color: 'var(--color-muted)' }}>
                {tools.mi_zona.zones.length} {t('rentabilidad.zones_selected')}
              </div>
              {tools.mi_zona.zones.length < 2 ? (
                <div style={{ color: '#DC2626', marginTop: 8 }}>
                  {t('rentabilidad.mi_zona_min2')}
                </div>
              ) : (
                <div style={{ marginTop: 8, lineHeight: 1.7 }}>
                  {t('rentabilidad.gmv_inside')}:{' '}
                  <strong>{Math.round((miZonaRatio ?? 1) * 100)}%</strong>
                  <br />
                  {t('rentabilidad.tools_extra')}:{' '}
                  <strong style={{ color: 'var(--color-yango, #E53935)', fontSize: 15 }}>
                    +{miZonaPct.toFixed(1)}%
                  </strong>{' '}
                  {t('rentabilidad.col_commission').toLowerCase()}
                </div>
              )}
              {tools.mi_zona.zones.length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-auto rounded-md border-dashed border-border bg-transparent px-2 py-1 text-xs font-normal text-muted hover:bg-accent"
                  style={{ marginTop: 10 }}
                  onClick={() => setTools((s) => ({ ...s, mi_zona: { ...s.mi_zona, zones: [] } }))}
                >
                  {t('rentabilidad.clear')}
                </Button>
              )}
            </div>
          </div>
        )}
        {tools.mi_zona.on && !isLima && (
          <div
            style={{
              marginTop: 12,
              display: 'flex',
              gap: 12,
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
          >
            <span
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: 'var(--color-muted)',
                whiteSpace: 'nowrap',
              }}
            >
              {t('rentabilidad.mi_zona_coverage')}
            </span>
            <input
              type="range"
              min="0.25"
              max="1"
              step="0.01"
              value={tools.mi_zona.ratio}
              onChange={(e) =>
                setTools((s) => ({
                  ...s,
                  mi_zona: { ...s.mi_zona, ratio: Number(e.target.value) },
                }))
              }
              style={{ flex: 1, maxWidth: 360, accentColor: 'var(--color-yango, #E53935)' }}
            />
            <span style={{ fontSize: 12, color: 'var(--color-muted)' }}>
              {Math.round(tools.mi_zona.ratio * 100)}% GMV →{' '}
              <strong style={{ color: 'var(--color-yango, #E53935)' }}>
                +{miZonaPct.toFixed(1)}%
              </strong>
            </span>
            <span style={{ fontSize: 11, color: 'var(--color-muted)', fontStyle: 'italic' }}>
              {t('rentabilidad.mi_zona_lima_only')}
            </span>
          </div>
        )}
      </CollapsibleSection>

      {/* ── Arquetipo de driver ── */}
      <CollapsibleSection
        id="rent-archetype"
        title={t('rentabilidad.archetype')}
        subtitle={`${archetype.segment} · ${t('rentabilidad.archetype_meta', {
          peak: Math.round(archetype.sharePeak * 100),
          streak: archetype.streakDays,
        })}`}
        defaultOpen={false}
      >
        <div
          style={{ fontSize: 12, color: 'var(--color-text)', marginBottom: 12, lineHeight: 1.5 }}
        >
          {t('rentabilidad.archetype_help')}
        </div>
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div>
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-muted)' }}>
              {t('rentabilidad.segment')}
            </span>
            <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
              {[
                ['active', 'seg_active'],
                ['new', 'seg_new'],
                ['reactivated', 'seg_reactivated'],
                ['all', 'seg_all'],
              ].map(([v, k]) => (
                <button
                  key={v}
                  onClick={() => setArchetype((s) => ({ ...s, segment: v }))}
                  style={toggleStyle(archetype.segment === v)}
                >
                  {t('rentabilidad.' + k)}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 10, color: 'var(--color-muted)', marginTop: 4 }}>
              filtra qué bonos aplican · todos los competidores
            </div>
          </div>
          <Field label={`${t('rentabilidad.share_peak')} · InDrive / surge`}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={archetype.sharePeak}
                onChange={(e) => setArchetype((s) => ({ ...s, sharePeak: Number(e.target.value) }))}
                style={{ width: 160, accentColor: 'var(--color-yango, #E53935)' }}
              />
              <span style={{ fontSize: 12, color: 'var(--color-muted)', minWidth: 34 }}>
                {Math.round(archetype.sharePeak * 100)}%
              </span>
            </div>
          </Field>
          <Field label={`${t('rentabilidad.streak_days')} · Didi`}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="range"
                min="0"
                max="7"
                step="1"
                value={archetype.streakDays}
                onChange={(e) =>
                  setArchetype((s) => ({ ...s, streakDays: Number(e.target.value) }))
                }
                style={{ width: 120, accentColor: 'var(--color-yango, #E53935)' }}
              />
              <span style={{ fontSize: 12, color: 'var(--color-muted)', minWidth: 28 }}>
                {archetype.streakDays}/7
              </span>
            </div>
          </Field>
        </div>
        <div
          style={{ fontSize: 11, color: 'var(--color-muted)', marginTop: 8, fontStyle: 'italic' }}
        >
          {t('rentabilidad.archetype_hint')}
        </div>
      </CollapsibleSection>

      <div style={{ fontSize: 12, color: 'var(--color-muted)', margin: '4px 2px 12px' }}>
        {t('rentabilidad.chart_help')}
      </div>

      {/* ── Gráficos (small multiples) ── */}
      {loading ? (
        <div className="rent-empty">{t('app.loading')}</div>
      ) : !hasData ? (
        <div className="rent-empty">
          {t('rentabilidad.no_data')}{' '}
          <strong>
            {uiCity} · {formatWeekLabel(refYear, refWeek)}
          </strong>
          .
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(680px, 1fr))',
            gap: 18,
          }}
        >
          {panels.map((p) => (
            <div
              key={p.key}
              className="rent-panel"
              style={{
                borderColor: p.live ? 'var(--color-yango, #E53935)' : undefined,
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
                {p.live ? `${t('rentabilidad.live_trips')}: ` : ''}
                {p.trips} {t('rentabilidad.trips_week')}
                <span style={{ fontWeight: 400, color: 'var(--color-muted)', marginLeft: 6 }}>
                  · {metric === 'trip' ? t('rentabilidad.per_trip') : t('rentabilidad.per_week')}
                </span>
              </div>
              <div style={{ width: '100%', height: 340 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={chartDataFor(p.trips)}
                    margin={{ top: 24, right: 8, left: 0, bottom: 0 }}
                    barCategoryGap="22%"
                  >
                    <CartesianGrid vertical={false} stroke="#eef2f7" />
                    <XAxis
                      dataKey="tier"
                      tick={{ fontSize: 11, fill: '#64748b' }}
                      interval={0}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      tickFormatter={(v) => `${currency} ${v}`}
                      tick={{ fontSize: 10, fill: '#94a3b8' }}
                      width={54}
                      axisLine={false}
                      tickLine={false}
                    />
                    <RechartTooltip
                      formatter={(val, name) => [fmt(val), name]}
                      labelFormatter={(l) => l}
                      cursor={{ fill: 'rgba(15, 23, 42, 0.04)' }}
                      contentStyle={{
                        borderRadius: 8,
                        border: '1px solid #e2e8f0',
                        boxShadow: '0 4px 14px rgba(0,0,0,0.08)',
                        fontSize: 12,
                      }}
                    />
                    <Legend wrapperStyle={{ fontSize: 11, paddingTop: 6 }} iconType="circle" />
                    {visibleCompetitors.map((comp) => (
                      <Bar
                        key={comp}
                        dataKey={comp}
                        fill={COMPETITOR_COLORS[comp] || '#94a3b8'}
                        radius={[4, 4, 0, 0]}
                        maxBarSize={46}
                      >
                        <LabelList
                          dataKey={comp}
                          position="top"
                          formatter={(v) => (v != null ? v.toFixed(metric === 'trip' ? 1 : 0) : '')}
                          style={{
                            fontSize: 10,
                            fontWeight: isYango(comp) ? 700 : 400,
                            fill: COMPETITOR_COLORS[comp] || '#64748b',
                          }}
                        />
                      </Bar>
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Desglose de ganancia (tarifa vs bonos) ── */}
      {breakdown.length > 0 && (
        <div className="rent-panel">
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 12,
              flexWrap: 'wrap',
              marginBottom: 4,
            }}
          >
            <span style={{ fontSize: 14, fontWeight: 700 }}>
              {t('rentabilidad.breakdown_title')}
            </span>
            <select
              value={refTier?.dbCategory || ''}
              onChange={(e) => setRefTierCat(e.target.value)}
              className="rent-select"
              style={{ minWidth: 130 }}
            >
              {tiersWithData.map((c) => (
                <option key={c.dbCategory} value={c.dbCategory}>
                  {c.uiCat}
                </option>
              ))}
            </select>
            {breakdownStats.yangoRank && (
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: breakdownStats.yangoRank === 1 ? '#16A34A' : 'var(--color-muted)',
                }}
              >
                {breakdownStats.yangoRank === 1 ? '🏆 ' : ''}Yango: {breakdownStats.yangoRank}º de{' '}
                {breakdown.length} en rentabilidad
              </span>
            )}
            <Button
              variant="outline"
              className="ml-auto h-auto rounded-full px-2.5 py-0.5 text-[11px] font-semibold"
              style={{
                background: showDetail ? 'var(--color-yango-light, #fff5f5)' : '#fff',
                color: showDetail ? 'var(--color-yango, #E53935)' : 'var(--color-muted)',
              }}
              onClick={() => setShowDetail((s) => !s)}
              title={t('rentabilidad.toggle_detail_tooltip')}
            >
              {showDetail ? `− ${t('rentabilidad.detail')}` : `+ ${t('rentabilidad.detail')}`}
            </Button>
          </div>
          <div style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 10 }}>
            {t('rentabilidad.breakdown_help', { trips: liveTrips })}
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="rent-matrix">
              <thead>
                <tr>
                  <th className="rent-th">{t('rentabilidad.col_trips')}</th>
                  <th className="rent-th">{t('rentabilidad.col_competitor')}</th>
                  <th className="rent-th">{t('rentabilidad.col_avg_fare')}</th>
                  <th className="rent-th">GMV</th>
                  <th className="rent-th">{t('rentabilidad.col_gmv_net')}</th>
                  <th className="rent-th">{t('rentabilidad.col_incentives')}</th>
                  <th className="rent-th">{t('rentabilidad.col_total')}</th>
                  <th className="rent-th">{t('rentabilidad.col_per_trip')}</th>
                  <th className="rent-th">{t('rentabilidad.col_rank')}</th>
                  {showDetail && (
                    <th className="rent-th">{t('rentabilidad.col_effective_commission')}</th>
                  )}
                  {showDetail && <th className="rent-th">{t('rentabilidad.col_bonus_pct')}</th>}
                </tr>
              </thead>
              <tbody>
                {breakdown.map((b) => {
                  const isBest = b.totalWeek === breakdownStats.bestTotal
                  const rank = breakdownStats.ranks[b.comp]
                  const pctBonus =
                    b.totalWeek > 0 && b.incentiveWeek > 0.005
                      ? Math.round((b.incentiveWeek / b.totalWeek) * 100)
                      : null
                  return (
                    <tr key={b.comp} style={{ background: isBest ? '#f0fdf4' : undefined }}>
                      <td className="rent-td">{b.trips}</td>
                      <td className="rent-td" style={{ fontWeight: 600 }}>
                        <span style={{ color: COMPETITOR_COLORS[b.comp] || '#64748b' }}>●</span>{' '}
                        {b.comp}
                        {isBest && (
                          <span style={{ color: '#16A34A', fontWeight: 700 }}>
                            {' '}
                            · {t('rentabilidad.most_profitable')}
                          </span>
                        )}
                      </td>
                      <td className="rent-td">{fmt2(b.avgFare)}</td>
                      <td className="rent-td">{fmt2(b.gmvGross)}</td>
                      <td className="rent-td">{fmt2(b.gmvNet)}</td>
                      <td
                        className="rent-td"
                        style={{
                          fontWeight: 600,
                          color: b.incentiveWeek > 0.005 ? '#16A34A' : 'var(--color-muted)',
                        }}
                      >
                        {b.incentiveWeek > 0.005 ? `+ ${fmt2(b.incentiveWeek)}` : '—'}
                      </td>
                      <td
                        className="rent-td"
                        style={{
                          fontWeight: 700,
                          color: isBest ? '#16A34A' : undefined,
                        }}
                      >
                        {fmt2(b.totalWeek)}
                      </td>
                      <td className="rent-td">{fmt2(b.perTrip)}</td>
                      <td className="rent-td" style={{ fontWeight: 600 }}>
                        {rank ? `${rank === 1 ? '🏆 ' : ''}${rank}º` : '—'}
                      </td>
                      {showDetail && <td className="rent-td">{b.comm.toFixed(1)}%</td>}
                      {showDetail && (
                        <td className="rent-td">{pctBonus != null ? `${pctBonus}%` : '—'}</td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 6, fontSize: 11, color: 'var(--color-muted)' }}>
            Los bonos de competidores salen de Config → Bonos. El de Yango es el bono por % de GMV
            (editable en Config → Bonos → “Bono Yango (% GMV)”). Si una fila muestra “—” en bonos,
            ese competidor no tiene bono cargado para este segmento/volumen.
          </div>
        </div>
      )}

      {/* ── Resumen de bonos mapeados para la ciudad activa (solo lectura) ── */}
      {hasData && (
        <BonusSummaryByCity
          dbCity={dbCity}
          currency={currency}
          yangoGmvTiers={yangoGmvTiers}
          bonusRows={bonusRows}
          loading={bonusesLoading}
        />
      )}

      {/* ── Matriz de escenarios Yango (E1 mejor / E4 peor) ── */}
      {hasData && refTier && (
        <div className="rent-panel">
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: 8,
              marginBottom: 8,
            }}
          >
            <span style={{ fontSize: 14, fontWeight: 700 }}>{t('rentabilidad.scenarios')}</span>
            <span style={{ fontSize: 12, color: 'var(--color-muted)' }}>
              {t('rentabilidad.ref_tier')}: <strong>{refTier.uiCat}</strong> · {liveTrips}{' '}
              {t('rentabilidad.trips_week')} ·{' '}
              {metric === 'trip' ? t('rentabilidad.per_trip') : t('rentabilidad.per_week')}
            </span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="rent-matrix">
              <thead>
                <tr>
                  <th className="rent-th">{t('rentabilidad.col_scenario')}</th>
                  <th className="rent-th">{t('rentabilidad.col_my_zone')}</th>
                  <th className="rent-th">{t('rentabilidad.col_commission')}</th>
                  <th className="rent-th">{t('rentabilidad.col_net')}</th>
                  {rivalCols.map((c) => (
                    <th key={c} className="rent-th">
                      vs {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[
                  {
                    key: 'best',
                    label: t('rentabilidad.scenario_best'),
                    comm: yangoScenarioCommission(dbCity, 'best'),
                    zona: '0%',
                    accent: '#16A34A',
                  },
                  {
                    key: 'current',
                    label: t('rentabilidad.scenario_current'),
                    comm: yangoCommission,
                    zona: tools.mi_zona.on ? `${miZonaPct.toFixed(1)}%` : '—',
                    accent: 'var(--color-yango, #E53935)',
                  },
                  {
                    key: 'worst',
                    label: t('rentabilidad.scenario_worst'),
                    comm: yangoScenarioCommission(dbCity, 'worst'),
                    zona: `${MI_ZONA_MAX_PCT}%`,
                    accent: '#DC2626',
                  },
                ].map((row) => {
                  const yNet = yangoNetAt(refTier.dbCategory, liveTrips, row.comm)
                  return (
                    <tr key={row.key}>
                      <td className="rent-td" style={{ fontWeight: 600 }}>
                        <span style={{ color: row.accent }}>●</span> {row.label}
                      </td>
                      <td className="rent-td">{row.zona}</td>
                      <td className="rent-td" style={{ fontWeight: 700 }}>
                        {row.comm.toFixed(1)}%
                      </td>
                      <td className="rent-td">{fmt(yNet)}</td>
                      {rivalCols.map((c) => {
                        const rNet = netFor(refTier.dbCategory, c, liveTrips)
                        const delta = yNet != null && rNet != null ? yNet - rNet : null
                        return (
                          <td
                            key={c}
                            className="rent-td"
                            style={{
                              color: delta == null ? 'inherit' : delta >= 0 ? '#16A34A' : '#DC2626',
                              fontWeight: 600,
                            }}
                          >
                            {delta == null
                              ? '—'
                              : `${delta >= 0 ? '+' : '-'}${fmt(Math.abs(delta))}`}
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 6, fontSize: 11, color: 'var(--color-muted)' }}>
            {t('rentabilidad.scenarios_hint')}
          </div>
        </div>
      )}

      {/* ── Notas: fórmulas de cálculo ── */}
      <div className="rent-panel">
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>
          {t('rentabilidad.formulas')}
        </div>
        <div style={{ display: 'grid', gap: 10 }}>
          <div className="rent-formula-card">
            <div className="rent-formula-label">{t('rentabilidad.formula_competitor')}</div>
            <div className="rent-formula-expr">{t('rentabilidad.formula_net_week')}</div>
            <div className="rent-formula-expr">{t('rentabilidad.formula_net_trip')}</div>
          </div>
          <div className="rent-formula-card">
            <div className="rent-formula-label">Yango — {t('rentabilidad.formula_stacked')}</div>
            <div className="rent-formula-expr">
              comisión_total = base_ciudad + partner(3%) + Σ herramientas
            </div>
            <div
              className="rent-formula-expr"
              style={{
                color: 'var(--color-yango, #E53935)',
                fontWeight: 700,
                fontSize: 14,
              }}
            >
              = {yangoBasePct}% ({dbCity}) + {YANGO_PARTNER_PCT}% + {yangoExtraPct.toFixed(1)}% ={' '}
              {yangoCommission.toFixed(1)}%
            </div>
            <div
              className="rent-formula-expr"
              style={{ color: 'var(--color-muted)', fontSize: 11 }}
            >
              herramientas: Mi Casa +5% · Mis Destinos +5% · Mi Zona 9·(1 − t^1.087)% · t =
              (cobertura_GMV − 0.251) / 0.749
            </div>
          </div>
          <div style={{ fontSize: 11, color: 'var(--color-muted)' }}>
            {t('rentabilidad.formula_note')}
          </div>
        </div>
      </div>

      {/* ── Análisis auto-generado (Build 3) ── */}
      {hasData && refTier && (
        <div className="rent-panel">
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>
            {t('rentabilidad.analysis')}
          </div>
          <div style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 12 }}>
            {liveTrips} {t('rentabilidad.trips_week')} ·{' '}
            {metric === 'trip' ? t('rentabilidad.per_trip') : t('rentabilidad.per_week')} ·{' '}
            {t('rentabilidad.total_commission')} {yangoCommission.toFixed(1)}%
            {winSummary.total > 0 && (
              <>
                {' · '}
                <strong
                  style={{
                    color: winSummary.wins * 2 >= winSummary.total ? '#16A34A' : '#DC2626',
                  }}
                >
                  Yango {t('rentabilidad.wins_in')} {winSummary.wins}/{winSummary.total}{' '}
                  {t('rentabilidad.comparisons')}
                </strong>
              </>
            )}
          </div>

          {/* Bonos one-off (gancho de una sola vez, no entran al recurrente) */}
          {oneOffs.length > 0 && (
            <div style={{ fontSize: 12, marginBottom: 10 }}>
              <span style={{ fontWeight: 600 }}>{t('rentabilidad.one_off')}:</span>{' '}
              {oneOffs.map((o) => (
                <span key={o.comp} style={{ marginRight: 12 }}>
                  {o.comp} <strong style={{ color: '#D97706' }}>+{fmt(o.oneOff)}</strong>{' '}
                  <span style={{ fontSize: 10, color: 'var(--color-muted)' }}>1×</span>
                </span>
              ))}
            </div>
          )}

          {/* 1. Yango vs competidores por tier */}
          <div style={{ fontSize: 13, fontWeight: 600, margin: '4px 0 6px' }}>
            {t('rentabilidad.vs_competitors_tier')}
          </div>
          <div style={{ overflowX: 'auto', marginBottom: 18 }}>
            <table className="rent-matrix">
              <thead>
                <tr>
                  <th className="rent-th">{t('rentabilidad.col_tier')}</th>
                  <th className="rent-th">Yango</th>
                  {rivalCols.map((c) => (
                    <th key={c} className="rent-th">
                      vs {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tierComparison.map((row) => (
                  <tr key={row.uiCat}>
                    <td className="rent-td" style={{ fontWeight: 600 }}>
                      {row.uiCat}
                    </td>
                    <td className="rent-td">{fmt(row.yNet)}</td>
                    {row.cells.map((c) => (
                      <td
                        key={c.comp}
                        className="rent-td"
                        style={{
                          color: c.delta == null ? 'inherit' : c.delta >= 0 ? '#16A34A' : '#DC2626',
                          fontWeight: 600,
                        }}
                      >
                        {c.delta == null
                          ? '—'
                          : `${c.delta >= 0 ? '+' : '-'}${fmt(Math.abs(c.delta))}`}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 2 + 3: costo de herramientas + break-even, lado a lado */}
          <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
            {toolCosts && (
              <div style={{ flex: '1 1 320px' }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
                  {t('rentabilidad.tool_costs')}{' '}
                  <span style={{ fontWeight: 400, color: 'var(--color-muted)', fontSize: 11 }}>
                    · {refTier.uiCat}
                  </span>
                </div>
                <table className="rent-matrix">
                  <thead>
                    <tr>
                      <th className="rent-th">{t('rentabilidad.col_tool')}</th>
                      <th className="rent-th">+pp</th>
                      <th className="rent-th">{t('rentabilidad.cost')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {toolCosts.items.map((it) => (
                      <tr key={it.key} style={{ opacity: it.active ? 1 : 0.5 }}>
                        <td className="rent-td">
                          {it.label}
                          {it.active && (
                            <span style={{ color: '#16A34A', marginLeft: 4 }}>
                              ✓ {t('rentabilidad.active')}
                            </span>
                          )}
                        </td>
                        <td className="rent-td">+{it.pct.toFixed(it.key === 'mi_zona' ? 1 : 0)}</td>
                        <td className="rent-td" style={{ color: '#DC2626' }}>
                          −{fmt(it.cost)}
                        </td>
                      </tr>
                    ))}
                    <tr>
                      <td className="rent-td" style={{ fontWeight: 700 }}>
                        {t('rentabilidad.total_active')}
                      </td>
                      <td className="rent-td" style={{ fontWeight: 700 }}>
                        +{toolCosts.totalPct.toFixed(1)}
                      </td>
                      <td className="rent-td" style={{ fontWeight: 700, color: '#DC2626' }}>
                        −{fmt(toolCosts.totalCost)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}

            {breakEvens.length > 0 && (
              <div style={{ flex: '1 1 320px' }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
                  {t('rentabilidad.break_even')}{' '}
                  <span style={{ fontWeight: 400, color: 'var(--color-muted)', fontSize: 11 }}>
                    · {refTier.uiCat}
                  </span>
                </div>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.9 }}>
                  {breakEvens.map((be) => {
                    const map = {
                      always: { txt: t('rentabilidad.be_always'), color: '#16A34A' },
                      never: { txt: t('rentabilidad.be_never'), color: '#DC2626' },
                      from: {
                        txt: `${t('rentabilidad.be_from')} ${be.n} ${t('rentabilidad.trips_week')}`,
                        color: '#D97706',
                      },
                      until: {
                        txt: `${t('rentabilidad.be_until')} ${be.n} ${t('rentabilidad.trips_week')}`,
                        color: '#D97706',
                      },
                      nodata: { txt: t('rentabilidad.be_nodata'), color: 'var(--color-muted)' },
                    }
                    const v = map[be.type]
                    return (
                      <li key={be.comp}>
                        <strong>{be.comp}</strong>:{' '}
                        <span style={{ color: v.color, fontWeight: 600 }}>{v.txt}</span>
                      </li>
                    )
                  })}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// Toggle de herramienta Yango (estilo botón pill).
function ToolToggle({ active, onClick, label, sub }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 12px',
        borderRadius: 8,
        fontSize: 13,
        cursor: 'pointer',
        border:
          '1px solid ' + (active ? 'var(--color-yango, #E53935)' : 'var(--color-border, #e2e8f0)'),
        background: active ? 'var(--color-yango, #E53935)' : '#fff',
        color: active ? '#fff' : 'var(--color-muted)',
        fontWeight: active ? 600 : 400,
      }}
    >
      <span>{active ? '☑' : '☐'}</span>
      {label}
      {sub && <span style={{ fontSize: 10, opacity: 0.85, fontStyle: 'italic' }}>· {sub}</span>}
    </button>
  )
}

// ── Sub-componentes / estilos ───────────────────────────────────────────────
function Field({ label, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-muted)' }}>{label}</span>
      {children}
    </label>
  )
}

function toggleStyle(active) {
  return {
    padding: '7px 14px',
    fontSize: 12,
    cursor: 'pointer',
    border: 'none',
    background: active ? 'var(--color-yango, #E53935)' : '#fff',
    color: active ? '#fff' : 'var(--color-muted)',
    fontWeight: active ? 700 : 500,
    transition: 'background 0.12s',
  }
}
