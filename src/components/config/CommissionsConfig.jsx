import { useMemo, useState } from 'react'
import { Percent, Plus, Trash2, Save } from 'lucide-react'
import { useCompetitorCommissions } from '../../hooks/useCompetitorCommissions'
import { dbErrorText } from '../../lib/dbErrorText'
import {
  getCountryConfig,
  COMPETITOR_COLORS,
  CANONICAL_COMPETITOR_NAMES,
} from '../../lib/constants'
import { Combobox } from '../ui/shadcn/combobox'
import SaveStatusBanner from './SaveStatusBanner'
import { useConfirm } from '../ui/ConfirmDialog'
import { useCountry } from '../../context/CountryContext'
import { useI18n } from '../../context/LanguageContext'
import { Button } from '../ui/shadcn/button'

// Sin las formas legacy con espacio ('Yango Comfort'): en prod convivían con
// 'YangoComfort' y Rentabilidad las mostraba como dos competidores (mig 239).
const ALL_COMPETITORS = CANONICAL_COMPETITOR_NAMES

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

  // Filas, edits por fila y live-sync viven en el hook (useConfigTable):
  // guardar una fila ya no pisa lo tipeado en otra.
  const {
    allRows,
    loading,
    error: loadError,
    saving,
    saveCommission,
    deleteCommission,
    addRow,
    reload,
    getField,
    setField: setFieldRaw,
    isDirty,
    isNew,
  } = useCompetitorCommissions(null, country)
  const [msg, setMsg] = useState(null)

  function setField(id, field, val) {
    setMsg(null)
    setFieldRaw(id, field, val)
  }

  async function handleSave(row) {
    setMsg(null)
    // `row` ya viene con los edits aplicados (tbl.rows).
    const merged = row
    const { ok, code, error } = await saveCommission(merged)
    if (ok) {
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
              : `${t('config.commissions.save_error')} — ${dbErrorText(t, error)}`,
      })
    }
  }

  async function handleDelete(row) {
    if (!isNew(row)) {
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
    else if (!isNew(row)) setMsg({ type: 'ok', text: t('config.commissions.delete_success') })
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

      {loadError && (
        <SaveStatusBanner
          status={{ type: 'err', text: t('config.load_error', { msg: dbErrorText(t, loadError) }) }}
          onDismiss={reload}
        />
      )}
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
            const dirty = isDirty(row.id)
            const cls = dirty ? 'config-dirty' : undefined
            const triggerCls = dirty ? 'text-xs config-dirty--soft' : 'text-xs'
            return (
              <tr key={row.id} className={dirty ? 'config-row--dirty' : undefined}>
                <td style={{ textAlign: 'left', minWidth: 170 }}>
                  <Combobox
                    items={competitorItems}
                    value={getField(row, 'competitor_name') || ''}
                    onValueChange={(v) => setField(row.id, 'competitor_name', v)}
                    placeholder={t('config.commissions.select_placeholder')}
                    searchPlaceholder={t('config.commissions.search_competitor')}
                    emptyText={t('config.commissions.no_results')}
                    triggerClassName={triggerCls}
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
                    triggerClassName={triggerCls}
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
                    className={cls}
                    style={{ width: 80, textAlign: 'right' }}
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
        onClick={() => {
          setMsg(null)
          addRow()
        }}
      >
        <Plus size={13} />
        {t('config.commissions.add_btn')}
      </Button>
    </div>
  )
}
