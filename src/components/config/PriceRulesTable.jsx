import { useState, useMemo, useCallback } from 'react'
import { getCountryConfig } from '../../lib/constants'
import { dbErrorText } from '../../lib/dbErrorText'
import { useConfigTable, isNewId } from '../../hooks/useConfigTable'
import SaveStatusBanner from './SaveStatusBanner'
import { useConfirm } from '../ui/ConfirmDialog'
import { useCountry } from '../../context/CountryContext'
import { useI18n } from '../../context/LanguageContext'
import { Button } from '../ui/shadcn/button'

export default function PriceRulesTable({ country }) {
  const { dbConfigs } = useCountry()
  const config = getCountryConfig(country, dbConfigs)
  const confirm = useConfirm()
  const { t } = useI18n()
  const defaultCity = config.dbCities[0] || 'Lima'

  const allCategories = useMemo(() => {
    const cats = new Set()
    Object.values(config.categoriesByCity || {}).forEach((list) => list.forEach((c) => cats.add(c)))
    return ['all', ...Array.from(cats).sort()]
  }, [config])

  const allCompetitors = useMemo(() => {
    const comps = new Set()
    Object.values(config.competitorsByDbCityCategory || {}).forEach((byCat) =>
      Object.values(byCat).forEach((list) => list.forEach((c) => comps.add(c)))
    )
    return ['all', ...Array.from(comps).sort()]
  }, [config])

  const dbCities = config.dbCities
  const query = useCallback(
    (q) => q.in('city', dbCities).order('city').order('category').order('competition'),
    [dbCities]
  )

  const tbl = useConfigTable({
    table: 'price_validation_rules',
    country,
    query,
    // Default a maxPrice del país (PEN=120, COP=120000, NPR=2000, etc.).
    // Si config.maxPrice no está seteado, fallback a 120 (Peru-equivalent).
    newRow: () => ({
      city: defaultCity,
      category: 'all',
      competition: 'all',
      max_price: Number(config.maxPrice) || 120,
    }),
    toPayload: (rule) => ({
      country,
      city: rule.city,
      category: rule.category || 'all',
      competition: rule.competition || 'all',
      max_price: parseFloat(rule.max_price),
      ...(isNewId(rule.id) ? {} : { updated_at: new Date().toISOString() }),
    }),
  })
  const { rows, loading, saving, error: loadError } = tbl
  const [msg, setMsg] = useState(null)

  function updateRule(id, field, val) {
    setMsg(null)
    tbl.setField(id, field, val)
  }

  async function saveRule(rule) {
    // Antes `parseFloat(x) || fallback` convertía un 0 o un vacío en 120 en
    // silencio: ahora un tope inválido no se guarda.
    const maxPrice = parseFloat(rule.max_price)
    if (!Number.isFinite(maxPrice) || maxPrice <= 0) {
      setMsg({ type: 'err', text: t('config.pricerules.max_price_invalid') })
      return
    }
    setMsg(null)
    const { ok, error } = await tbl.saveRow(rule)
    if (!ok) {
      setMsg({
        type: 'err',
        text: t('config.pricerules.save_error', { msg: dbErrorText(t, error) }),
      })
      return
    }
    setMsg({
      type: 'ok',
      text: t('config.pricerules.saved_toast', {
        city: rule.city,
        category: rule.category || 'all',
        competition: rule.competition || 'all',
        currency: config.currency,
        price: maxPrice,
      }),
    })
  }

  async function deleteRule(id) {
    if (tbl.isNew(id)) {
      tbl.deleteRow(id)
      return
    }
    const ok = await confirm({
      title: t('config.pricerules.delete_confirm_title'),
      message: t('config.pricerules.delete_confirm_message'),
      danger: true,
      confirmText: t('app.delete'),
    })
    if (!ok) return
    const res = await tbl.deleteRow(id)
    if (res.ok) setMsg({ type: 'ok', text: t('config.pricerules.delete_success') })
    else
      setMsg({
        type: 'err',
        text: t('config.pricerules.delete_error', { msg: dbErrorText(t, res.error) }),
      })
  }

  if (loading) return <div className="config-loading">{t('config.pricerules.loading')}</div>

  return (
    <div className="config-section">
      <h2>{t('config.pricerules.title')}</h2>
      <p style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 12 }}>
        {t('config.pricerules.description')}
      </p>

      {loadError && (
        <SaveStatusBanner
          status={{ type: 'err', text: t('config.load_error', { msg: dbErrorText(t, loadError) }) }}
          onDismiss={tbl.reload}
        />
      )}
      <SaveStatusBanner status={msg} onDismiss={() => setMsg(null)} />

      <table className="config-table" style={{ marginTop: 10 }}>
        <thead>
          <tr>
            <th scope="col">{t('filter.city')}</th>
            <th scope="col">{t('filter.category')}</th>
            <th scope="col">{t('config.commissions.col_competitor')}</th>
            <th scope="col">
              {t('config.pricerules.col_max_price', { currency: config.currency })}
            </th>
            <th scope="col"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((rule) => {
            const dirty = tbl.isDirty(rule.id)
            const cls = dirty ? 'config-dirty' : undefined
            return (
              <tr key={rule.id} className={dirty ? 'config-row--dirty' : undefined}>
                <td>
                  <select
                    value={rule.city}
                    onChange={(e) => updateRule(rule.id, 'city', e.target.value)}
                    className={cls}
                  >
                    {config.dbCities.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <select
                    value={rule.category || 'all'}
                    onChange={(e) => updateRule(rule.id, 'category', e.target.value)}
                    className={cls}
                  >
                    {allCategories.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <select
                    value={rule.competition || 'all'}
                    onChange={(e) => updateRule(rule.id, 'competition', e.target.value)}
                    className={cls}
                  >
                    {allCompetitors.map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    type="number"
                    value={rule.max_price}
                    min="0"
                    step="1"
                    onChange={(e) => updateRule(rule.id, 'max_price', e.target.value)}
                    className={cls}
                    style={{ width: 80 }}
                  />
                </td>
                <td style={{ display: 'flex', gap: 6 }}>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => saveRule(rule)}
                    disabled={saving || !dirty}
                    title={!dirty ? t('config.commissions.no_changes_title') : undefined}
                  >
                    {rule._new ? t('config.commissions.create_btn') : t('app.save')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="border-red-300 text-red-600 hover:bg-red-100"
                    aria-label={t('app.delete')}
                    onClick={() => deleteRule(rule.id)}
                  >
                    ✕
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
          tbl.addRow()
        }}
      >
        + {t('config.pricerules.add_btn')}
      </Button>
    </div>
  )
}
