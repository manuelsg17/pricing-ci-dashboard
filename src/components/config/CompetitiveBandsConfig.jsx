import { useState, useMemo, useEffect } from 'react'
import { Percent, Plus, Trash2, Save } from 'lucide-react'
import { useCompetitiveBands } from '../../hooks/useCompetitiveBands'
import { useCompetitiveBandAnalysis } from '../../hooks/useCompetitiveBandAnalysis'
import { useConfigContext } from '../../context/ConfigProvider'
import { useCountry } from '../../context/CountryContext'
import { getCountryConfig, COMPETITOR_COLORS } from '../../lib/constants'
import { Combobox } from '../ui/shadcn/combobox'
import SaveStatusBanner from './SaveStatusBanner'
import { useConfirm } from '../ui/ConfirmDialog'
import { useI18n } from '../../context/LanguageContext'
import { Button } from '../ui/shadcn/button'

const DIRTY_STYLE = {
  background: '#fef3c7',
  borderColor: '#f59e0b',
  fontWeight: 600,
  boxShadow: '0 0 0 2px rgba(245, 158, 11, 0.2)',
}
// Sin boxShadow (ver BotRulesTable/CommissionsConfig): el boxShadow inline
// estático tapa el anillo de :focus-visible de los triggers Combobox.
const DIRTY_TRIGGER_STYLE = {
  background: DIRTY_STYLE.background,
  borderColor: DIRTY_STYLE.borderColor,
  fontWeight: DIRTY_STYLE.fontWeight,
}

// Preview en vivo: mientras el usuario tipea min/max%, muestra qué % de las
// cotizaciones reales caería "dentro de banda" hoy — sin necesidad de
// guardar primero (la RPC recibe min/max como parámetro).
function BandPreviewCell({ country, competitorName, category, minPct, maxPct }) {
  const [debounced, setDebounced] = useState({ minPct, maxPct })
  const { t } = useI18n()
  useEffect(() => {
    const timer = setTimeout(() => setDebounced({ minPct, maxPct }), 400)
    return () => clearTimeout(timer)
  }, [minPct, maxPct])

  // includeBreakdown=false: el preview solo necesita el resumen, no vale la
  // pena pedir el desglose ciudad×bracket (la RPC más cara de las dos) por
  // cada una de las N filas de la tabla en cada carga de la página.
  const { summary, loading } = useCompetitiveBandAnalysis({
    country,
    competitorName,
    category,
    minPct: debounced.minPct,
    maxPct: debounced.maxPct,
    includeBreakdown: false,
  })

  if (!competitorName || !category) {
    return (
      <span style={{ color: '#9ca3af', fontSize: 11 }}>{t('config.bands.preview_choose')}</span>
    )
  }
  if (loading && !summary)
    return (
      <span style={{ color: '#9ca3af', fontSize: 11 }}>
        {t('config.bands.preview_calculating')}
      </span>
    )
  if (!summary || !summary.total_observations) {
    return (
      <span style={{ color: '#9ca3af', fontSize: 11 }}>{t('config.bands.preview_no_data')}</span>
    )
  }
  const withinPct = Number(summary.within_pct)
  const color = withinPct >= 50 ? '#166534' : withinPct >= 25 ? '#92400e' : '#991b1b'
  return (
    <span
      style={{ fontSize: 12, fontWeight: 700, color }}
      title={t('config.bands.preview_tooltip', {
        n: summary.total_observations,
        below: summary.below_pct,
        above: summary.above_pct,
      })}
    >
      {t('config.bands.preview_within', { pct: withinPct })}
    </span>
  )
}

export default function CompetitiveBandsConfig({ country }) {
  const { dbConfigs } = useCountry()
  const config = getCountryConfig(country, dbConfigs)
  const confirm = useConfirm()
  const {
    allRows,
    loading,
    error: loadError,
    saveBand,
    deleteBand,
    addRow,
  } = useCompetitiveBands(country)
  const { refresh: refreshConfig } = useConfigContext()
  const { t } = useI18n()
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState(null)
  const [edits, setEdits] = useState({})

  // Competidores válidos = NUNCA sub-marcas de Yango (constraint en BD).
  const competitorItems = useMemo(
    () =>
      Object.keys(COMPETITOR_COLORS)
        .filter((c) => !c.toLowerCase().startsWith('yango') && !c.includes(' '))
        .sort()
        .map((c) => ({ value: c, label: c, color: COMPETITOR_COLORS[c] })),
    []
  )
  // Categorías del país, deduplicadas, excluyendo Corp (fuera de scope v1).
  const categoryItems = useMemo(() => {
    const cats = new Set()
    Object.values(config.categoriesByCity || {}).forEach((list) => list.forEach((c) => cats.add(c)))
    cats.delete('Corp')
    return Array.from(cats)
      .sort()
      .map((c) => ({ value: c, label: c }))
  }, [config])

  function getField(row, field) {
    return edits[row.id]?.[field] ?? row[field] ?? ''
  }
  function setField(id, field, val) {
    setMsg(null)
    setEdits((prev) => ({ ...prev, [id]: { ...prev[id], [field]: val } }))
  }
  const isDirty = (id) => !!edits[id] && Object.keys(edits[id]).length > 0
  const isNew = (row) => String(row.id).startsWith('new_')

  async function handleSave(row) {
    const merged = { ...row, ...edits[row.id] }
    if (!merged.competitor_name || !merged.category) {
      setMsg({ type: 'err', text: t('config.bands.choose_error') })
      return
    }
    if (Number(merged.min_pct) >= Number(merged.max_pct)) {
      setMsg({ type: 'err', text: t('config.bands.range_error') })
      return
    }
    setSaving(true)
    setMsg(null)
    const errMsg = await saveBand(merged)
    if (!errMsg) {
      setEdits((prev) => {
        const n = { ...prev }
        delete n[row.id]
        return n
      })
      setMsg({
        type: 'ok',
        text: t('config.bands.saved_toast', {
          competitor: merged.competitor_name,
          category: merged.category,
          min: merged.min_pct,
          max: merged.max_pct,
        }),
      })
      // Refresh inmediato: no depender solo del round-trip de live-sync
      // (audit_log → realtime → debounce 500ms) para que la propia sesión
      // vea el cambio reflejado al instante en Análisis → Competitividad.
      refreshConfig()
    } else {
      setMsg({ type: 'err', text: t('config.bands.save_error', { msg: errMsg }) })
    }
    setSaving(false)
  }

  async function handleDelete(row) {
    if (!isNew(row)) {
      const ok = await confirm({
        title: t('config.bands.delete_confirm_title'),
        message: t('config.bands.delete_confirm_message'),
        danger: true,
        confirmText: t('app.delete'),
      })
      if (!ok) return
    }
    const ok = await deleteBand(row.id)
    if (!ok) setMsg({ type: 'err', text: t('config.bands.delete_error') })
    else {
      if (!isNew(row)) setMsg({ type: 'ok', text: t('config.bands.delete_success') })
      refreshConfig()
    }
  }

  if (loading) return <div className="config-loading">{t('config.bands.loading')}</div>

  return (
    <div className="config-section">
      <h2 className="with-icon">
        <Percent size={15} />
        {t('config.bands.title')}
      </h2>
      <p style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 12 }}>
        {t('config.bands.description')}
      </p>

      {loadError && (
        <div className="state-box state-box--error">
          {t('app.error_prefix')}
          {loadError}
        </div>
      )}
      <SaveStatusBanner status={msg} onDismiss={() => setMsg(null)} />

      <table className="config-table config-table--modern" style={{ marginTop: 10 }}>
        <thead>
          <tr>
            <th scope="col">{t('config.commissions.col_competitor')}</th>
            <th scope="col">{t('filter.category')}</th>
            <th scope="col" title={t('config.bands.col_min_title')}>
              {t('config.bands.col_min')}
            </th>
            <th scope="col" title={t('config.bands.col_max_title')}>
              {t('config.bands.col_max')}
            </th>
            <th style={{ textAlign: 'left', minWidth: 160 }}>{t('config.semaforo.col_note')}</th>
            <th scope="col">{t('config.bands.col_active')}</th>
            <th scope="col" title={t('config.bands.col_today_title')}>
              {t('config.bands.col_today')}
            </th>
            <th scope="col"></th>
          </tr>
        </thead>
        <tbody>
          {allRows.map((row) => {
            const dirty = isDirty(row.id) || isNew(row)
            const minPct = Number(getField(row, 'min_pct'))
            const maxPct = Number(getField(row, 'max_pct'))
            return (
              <tr key={row.id} style={dirty ? { background: '#fffbeb' } : undefined}>
                <td style={{ textAlign: 'left', minWidth: 160 }}>
                  <Combobox
                    items={competitorItems}
                    value={getField(row, 'competitor_name') || ''}
                    onValueChange={(v) => setField(row.id, 'competitor_name', v)}
                    placeholder={t('config.bands.select_placeholder')}
                    searchPlaceholder={t('config.commissions.search_competitor')}
                    emptyText={t('config.commissions.no_results')}
                    triggerClassName="text-xs"
                    style={dirty ? DIRTY_TRIGGER_STYLE : undefined}
                  />
                </td>
                <td style={{ textAlign: 'left', minWidth: 150 }}>
                  <Combobox
                    items={categoryItems}
                    value={getField(row, 'category') || ''}
                    onValueChange={(v) => setField(row.id, 'category', v)}
                    placeholder={t('config.bands.select_placeholder')}
                    searchPlaceholder={t('config.bands.search_category')}
                    emptyText={t('config.commissions.no_results')}
                    triggerClassName="text-xs"
                    style={dirty ? DIRTY_TRIGGER_STYLE : undefined}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    step="0.5"
                    value={getField(row, 'min_pct')}
                    onChange={(e) => setField(row.id, 'min_pct', e.target.value)}
                    style={{ width: 70, textAlign: 'right', ...(dirty ? DIRTY_STYLE : {}) }}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    step="0.5"
                    value={getField(row, 'max_pct')}
                    onChange={(e) => setField(row.id, 'max_pct', e.target.value)}
                    style={{ width: 70, textAlign: 'right', ...(dirty ? DIRTY_STYLE : {}) }}
                  />
                </td>
                <td>
                  <input
                    type="text"
                    value={getField(row, 'note')}
                    onChange={(e) => setField(row.id, 'note', e.target.value)}
                    placeholder={t('config.bands.note_placeholder')}
                    style={{ width: '100%', ...(dirty ? DIRTY_STYLE : {}) }}
                  />
                </td>
                <td style={{ textAlign: 'center' }}>
                  <label
                    className="toggle-switch"
                    title={
                      getField(row, 'is_active') !== false
                        ? t('config.bands.active_title')
                        : t('config.bands.inactive_title')
                    }
                  >
                    <input
                      type="checkbox"
                      checked={getField(row, 'is_active') !== false}
                      onChange={(e) => setField(row.id, 'is_active', e.target.checked)}
                    />
                    <span className="toggle-track" />
                  </label>
                </td>
                <td style={{ textAlign: 'center' }}>
                  <BandPreviewCell
                    country={country}
                    competitorName={getField(row, 'competitor_name')}
                    category={getField(row, 'category')}
                    minPct={Number.isFinite(minPct) ? minPct : null}
                    maxPct={Number.isFinite(maxPct) ? maxPct : null}
                  />
                </td>
                <td style={{ display: 'flex', gap: 6 }}>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => handleSave(row)}
                    disabled={saving || !dirty}
                    title={!dirty ? t('config.commissions.no_changes_title') : undefined}
                  >
                    <Save size={11} />
                    {isNew(row) ? t('config.commissions.create_btn') : t('app.save')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="border-red-300 text-red-600 hover:bg-red-100"
                    aria-label={t('app.delete')}
                    title={t('app.delete')}
                    onClick={() => handleDelete(row)}
                  >
                    <Trash2 size={12} />
                  </Button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-2.5 border-dashed border-border text-muted hover:border-yango hover:text-yango"
        onClick={addRow}
      >
        <Plus size={13} />
        {t('config.bands.add_btn')}
      </Button>
    </div>
  )
}
