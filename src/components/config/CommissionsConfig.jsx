import { useMemo, useState } from 'react'
import { Percent, Plus, Trash2, Save } from 'lucide-react'
import { useCompetitorCommissions } from '../../hooks/useCompetitorCommissions'
import { getCountryConfig, COMPETITOR_COLORS } from '../../lib/constants'
import { Combobox } from '../ui/shadcn/combobox'
import SaveStatusBanner from './SaveStatusBanner'
import { useConfirm } from '../ui/ConfirmDialog'
import { useCountry } from '../../context/CountryContext'
import { useI18n } from '../../context/LanguageContext'
import { Button } from '../ui/shadcn/button'

const ALL_COMPETITORS = Object.keys(COMPETITOR_COLORS)

const DIRTY_STYLE = {
  background: '#fef3c7',
  borderColor: '#f59e0b',
  fontWeight: 600,
  boxShadow: '0 0 0 2px rgba(245, 158, 11, 0.2)',
}

// Variante sin boxShadow para triggers de Combobox: el boxShadow inline
// estático taparía siempre el anillo de :focus-visible (Tailwind, también
// box-shadow) — con esta variante el fondo/borde amarillo sigue marcando
// "dirty" pero el foco de teclado sigue siendo visible al tabular.
const DIRTY_TRIGGER_STYLE = {
  background: DIRTY_STYLE.background,
  borderColor: DIRTY_STYLE.borderColor,
  fontWeight: DIRTY_STYLE.fontWeight,
}

export default function CommissionsConfig({ country }) {
  const { dbConfigs } = useCountry()
  const config = getCountryConfig(country, dbConfigs)
  const confirm = useConfirm()
  const { t } = useI18n()

  const competitorItems = useMemo(
    () => ALL_COMPETITORS.map((c) => ({ value: c, label: c, color: COMPETITOR_COLORS[c] })),
    []
  )
  // Sentinel no-vacío para "Todas las ciudades": cmdk usa un chequeo de
  // truthiness sobre `value` para su búsqueda/typeahead — un CommandItem con
  // value:'' queda con score de búsqueda fijo en 0 (nunca aparece al filtrar)
  // y no puede marcarse como "resaltado" para navegación por teclado. `null`
  // (el valor real en BD) se traduce a este sentinel solo para el picker.
  const ALL_CITIES_SENTINEL = '__all__'
  const cityItems = useMemo(
    () => [
      { value: ALL_CITIES_SENTINEL, label: t('config.commissions.all_cities') },
      ...config.dbCities.map((c) => ({ value: c, label: c })),
    ],
    [config, t]
  )

  const { allRows, loading, saveCommission, deleteCommission, addRow } = useCompetitorCommissions(
    null,
    country
  )
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState(null)
  const [edits, setEdits] = useState({})

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
    setSaving(true)
    setMsg(null)
    const merged = { ...row, ...edits[row.id] }
    const { ok, code, error } = await saveCommission(merged)
    if (ok) {
      setEdits((prev) => {
        const n = { ...prev }
        delete n[row.id]
        return n
      })
      const cityLabel = merged.city || t('config.commissions.all_cities')
      setMsg({
        type: 'ok',
        text: t('config.commissions.saved_toast', {
          competitor: merged.competitor_name,
          city: cityLabel,
          pct: merged.commission_pct,
        }),
      })
    } else {
      setMsg({
        type: 'err',
        text:
          code === 'invalid_pct'
            ? t('config.commissions.pct_range_error')
            : code === 'invalid_competitor'
              ? t('config.commissions.competitor_required_error')
              : `${t('config.commissions.save_error')}${error ? ` — ${error}` : ''}`,
      })
    }
    setSaving(false)
  }

  async function handleDelete(row) {
    if (!String(row.id).startsWith('new_')) {
      const confirmed = await confirm({
        title: t('config.commissions.delete_confirm_title'),
        message: t('config.commissions.delete_confirm_message'),
        danger: true,
        confirmText: t('app.delete'),
      })
      if (!confirmed) return
    }
    const ok = await deleteCommission(row.id)
    if (!ok) setMsg({ type: 'err', text: t('config.commissions.delete_error') })
    else if (!String(row.id).startsWith('new_'))
      setMsg({ type: 'ok', text: t('config.commissions.delete_success') })
  }

  if (loading) return <div className="config-loading">{t('config.commissions.loading')}</div>

  return (
    <div className="config-section">
      <h2 className="with-icon">
        <Percent size={15} />
        {t('config.commissions.title')}
      </h2>
      <p style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 12 }}>
        {t('config.commissions.subtitle')}
      </p>

      <SaveStatusBanner status={msg} onDismiss={() => setMsg(null)} />

      <table className="config-table config-table--modern" style={{ marginTop: 10 }}>
        <thead>
          <tr>
            <th scope="col">{t('config.commissions.col_competitor')}</th>
            <th scope="col">{t('filter.city')}</th>
            <th scope="col">{t('config.commissions.col_pct')}</th>
            <th scope="col"></th>
          </tr>
        </thead>
        <tbody>
          {allRows.map((row) => {
            const dirty = isDirty(row.id) || isNew(row)
            const cellStyle = dirty ? DIRTY_STYLE : undefined
            const triggerStyle = dirty ? DIRTY_TRIGGER_STYLE : undefined
            return (
              <tr key={row.id} style={dirty ? { background: '#fffbeb' } : undefined}>
                <td style={{ textAlign: 'left', minWidth: 170 }}>
                  <Combobox
                    items={competitorItems}
                    value={getField(row, 'competitor_name') || ''}
                    onValueChange={(v) => setField(row.id, 'competitor_name', v)}
                    placeholder={t('config.commissions.select_placeholder')}
                    searchPlaceholder={t('config.commissions.search_competitor')}
                    emptyText={t('config.commissions.no_results')}
                    triggerClassName="text-xs"
                    style={triggerStyle}
                  />
                </td>
                <td style={{ textAlign: 'left', minWidth: 160 }}>
                  <Combobox
                    items={cityItems}
                    value={getField(row, 'city') || ALL_CITIES_SENTINEL}
                    onValueChange={(v) =>
                      setField(row.id, 'city', v === ALL_CITIES_SENTINEL ? null : v)
                    }
                    searchPlaceholder={t('config.commissions.search_city')}
                    emptyText={t('config.commissions.no_results')}
                    triggerClassName="text-xs"
                    style={triggerStyle}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.5"
                    value={getField(row, 'commission_pct')}
                    onChange={(e) => setField(row.id, 'commission_pct', e.target.value)}
                    style={{ width: 80, textAlign: 'right', ...(cellStyle || {}) }}
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
        {t('config.commissions.add_btn')}
      </Button>
    </div>
  )
}
