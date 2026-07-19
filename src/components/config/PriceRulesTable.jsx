import { useState, useEffect, useMemo } from 'react'
import { sb } from '../../lib/supabase'
import { getCountryConfig } from '../../lib/constants'
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

  const [rules, setRules] = useState([])
  const [original, setOriginal] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState(null)

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [country])

  // Live-sync: si otra sesión modifica price_validation_rules, recargamos
  // preservando dirty rows. Mismo patrón que AirportMarkersTable.
  useEffect(() => {
    function onChange(e) {
      if (e?.detail?.table === 'price_validation_rules') loadPreservingDirty()
    }
    window.addEventListener('config:changed', onChange)
    return () => window.removeEventListener('config:changed', onChange)
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [country])

  async function load() {
    setLoading(true)
    const { data } = await sb
      .from('price_validation_rules')
      .select('*')
      .eq('country', country)
      .in('city', config.dbCities)
      .order('city')
      .order('category')
      .order('competition')
    setRules(data || [])
    setOriginal((data || []).map((r) => ({ ...r })))
    setLoading(false)
  }

  // Recarga server pero preserva filas dirty (en edición o _new) para no
  // pisar el trabajo del usuario cuando otra sesión escribe.
  async function loadPreservingDirty() {
    const { data } = await sb
      .from('price_validation_rules')
      .select('*')
      .eq('country', country)
      .in('city', config.dbCities)
      .order('city')
      .order('category')
      .order('competition')
    const fresh = data || []
    setRules((prev) => {
      const dirtyRows = prev.filter(isRowDirty)
      const dirtyIds = new Set(dirtyRows.map((r) => r.id))
      const cleanFromServer = fresh.filter((s) => !dirtyIds.has(s.id))
      return [...cleanFromServer, ...dirtyRows]
    })
    setOriginal(fresh.map((r) => ({ ...r })))
  }

  function updateRule(id, field, val) {
    setMsg(null)
    setRules((prev) => prev.map((r) => (r.id === id ? { ...r, [field]: val } : r)))
  }

  function addRule() {
    const tempId = `new_${Date.now()}`
    setMsg(null)
    // Default a maxPrice del país (PEN=120, COP=120000, NPR=2000, etc.).
    // Si config.maxPrice no está seteado, fallback a 120 (Peru-equivalent).
    const defaultMax = Number(config.maxPrice) || 120
    setRules((prev) => [
      ...prev,
      {
        id: tempId,
        city: defaultCity,
        category: 'all',
        competition: 'all',
        max_price: defaultMax,
        _new: true,
      },
    ])
  }

  const isRowDirty = (r) => {
    if (r._new) return true
    const orig = original.find((o) => o.id === r.id)
    if (!orig) return true
    return (
      r.city !== orig.city ||
      r.category !== orig.category ||
      r.competition !== orig.competition ||
      String(r.max_price) !== String(orig.max_price)
    )
  }

  async function saveRule(rule) {
    setSaving(true)
    setMsg(null)
    const payload = {
      country,
      city: rule.city,
      category: rule.category || 'all',
      competition: rule.competition || 'all',
      max_price: parseFloat(rule.max_price) || Number(config.maxPrice) || 120,
    }
    let err
    if (rule._new) {
      ;({ error: err } = await sb.from('price_validation_rules').insert(payload))
    } else {
      ;({ error: err } = await sb
        .from('price_validation_rules')
        .update({ ...payload, updated_at: new Date().toISOString() })
        .eq('id', rule.id))
    }
    if (err) {
      setMsg({ type: 'err', text: t('config.pricerules.save_error', { msg: err.message }) })
    } else {
      setMsg({
        type: 'ok',
        text: t('config.pricerules.saved_toast', {
          city: payload.city,
          category: payload.category,
          competition: payload.competition,
          currency: config.currency,
          price: payload.max_price,
        }),
      })
      await load()
    }
    setSaving(false)
  }

  async function deleteRule(id) {
    if (String(id).startsWith('new_')) {
      setRules((prev) => prev.filter((r) => r.id !== id))
      return
    }
    const ok = await confirm({
      title: t('config.pricerules.delete_confirm_title'),
      message: t('config.pricerules.delete_confirm_message'),
      danger: true,
      confirmText: t('app.delete'),
    })
    if (!ok) return
    const { error } = await sb.from('price_validation_rules').delete().eq('id', id)
    if (!error) {
      setMsg({ type: 'ok', text: t('config.pricerules.delete_success') })
      await load()
    } else {
      setMsg({ type: 'err', text: t('config.pricerules.delete_error', { msg: error.message }) })
    }
  }

  if (loading) return <div className="config-loading">{t('config.pricerules.loading')}</div>

  const dirtyCellStyle = {
    background: '#fef3c7',
    borderColor: '#f59e0b',
    fontWeight: 600,
    boxShadow: '0 0 0 2px rgba(245, 158, 11, 0.2)',
  }

  return (
    <div className="config-section">
      <h2>{t('config.pricerules.title')}</h2>
      <p style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 12 }}>
        {t('config.pricerules.description')}
      </p>

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
          {rules.map((rule) => {
            const dirty = isRowDirty(rule)
            return (
              <tr key={rule.id} style={dirty ? { background: '#fffbeb' } : undefined}>
                <td>
                  <select
                    value={rule.city}
                    onChange={(e) => updateRule(rule.id, 'city', e.target.value)}
                    style={dirty ? dirtyCellStyle : undefined}
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
                    style={dirty ? dirtyCellStyle : undefined}
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
                    style={dirty ? dirtyCellStyle : undefined}
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
                    style={{ width: 80, ...(dirty ? dirtyCellStyle : {}) }}
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
        onClick={addRule}
      >
        + {t('config.pricerules.add_btn')}
      </Button>
    </div>
  )
}
