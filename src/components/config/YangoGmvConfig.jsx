import { useState, useEffect, useMemo } from 'react'
import { sb } from '../../lib/supabase'
import { getCountryConfig } from '../../lib/constants'
import SaveStatusBanner from './SaveStatusBanner'
import { useConfirm } from '../ui/ConfirmDialog'
import { useCountry } from '../../context/CountryContext'
import { useI18n } from '../../context/LanguageContext'
import { Button } from '../ui/shadcn/button'
import { toISODate } from '../../lib/dateUtils'

// Editor del bono Yango por % de GMV (tabla yango_gmv_tiers, mig 116).
// Una fila = un peldaño. variant ∈ unbranded|branded|vip (VIP = Premier en Lima).
// mig 237: cada peldaño tiene vigencia (valid_from / valid_to). Editar en el
// lugar corrige la versión actual; "Nueva versión de la escalera" cierra la
// vigente e inserta los peldaños que ves como versión nueva (RPC atómica).
const VARIANTS = [
  { key: 'unbranded', labelKey: 'config.yango_gmv.variant_unbranded' },
  { key: 'branded', labelKey: 'config.yango_gmv.variant_branded' },
  { key: 'vip', labelKey: 'config.yango_gmv.variant_vip' },
]
// Día siguiente en ISO (para el mínimo del selector "nueva versión desde").
const nextDay = (iso) => {
  if (!iso) return undefined
  const d = new Date(`${iso}T00:00:00`)
  d.setDate(d.getDate() + 1)
  return toISODate(d)
}

export default function YangoGmvConfig({ country }) {
  const confirm = useConfirm()
  const { t } = useI18n()
  const { dbConfigs } = useCountry()
  // Ciudades del país (antes: Lima/Trujillo/Arequipa hardcodeadas).
  const CITIES = useMemo(
    () => getCountryConfig(country, dbConfigs).dbCities || [],
    [country, dbConfigs]
  )
  const [tiers, setTiers] = useState([])
  const [original, setOriginal] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState(null)
  const [city, setCity] = useState(CITIES[0] || 'Lima')
  const [variant, setVariant] = useState('unbranded')
  const [showHistory, setShowHistory] = useState(false)
  const today = toISODate(new Date()) // hora local, no UTC
  const [ladderFrom, setLadderFrom] = useState(today)

  useEffect(() => {
    if (CITIES.length && !CITIES.includes(city)) setCity(CITIES[0])
  }, [CITIES, city])

  useEffect(() => {
    load() /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [country])

  useEffect(() => {
    function onChange(e) {
      if (e?.detail?.table === 'yango_gmv_tiers') load()
    }
    window.addEventListener('config:changed', onChange)
    return () => window.removeEventListener('config:changed', onChange)
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [country])

  async function load() {
    setLoading(true)
    const { data, error } = await sb
      .from('yango_gmv_tiers')
      .select('*')
      .eq('country', country)
      .order('city')
      .order('variant')
      .order('valid_from')
      .order('min_trips')
    if (error) setMsg({ type: 'err', text: t('config.load_error', { msg: error.message }) })
    setTiers(data || [])
    setOriginal((data || []).map((r) => ({ ...r })))
    setLoading(false)
  }

  const isExpired = (r) => !!r.valid_to && String(r.valid_to) < today
  const isFuture = (r) => !!r.valid_from && String(r.valid_from) > today
  const allRows = tiers.filter((tier) => tier.city === city && tier.variant === variant)
  const rows = showHistory ? allRows : allRows.filter((r) => !isExpired(r))
  const expiredCount = allRows.length - allRows.filter((r) => !isExpired(r)).length
  // Peldaños de la versión VIGENTE HOY (ni vencida ni futura) — son los que se
  // copian al versionar. Antes incluía también versiones futuras: si ya había
  // una próxima cargada, "nueva versión" mezclaba dos escaleras y la RPC
  // rechazaba el peldaño duplicado (hallazgo #4, revisión adversarial 2026-09-03).
  const currentValidFrom = allRows
    .filter((r) => !isExpired(r) && !isFuture(r) && !r._new)
    .reduce((max, r) => (r.valid_from > (max ?? '') ? r.valid_from : max), null)
  const currentRows = allRows.filter((r) => r.valid_from === currentValidFrom)

  function update(id, field, val) {
    setMsg(null)
    setTiers((prev) => prev.map((tier) => (tier.id === id ? { ...tier, [field]: val } : tier)))
  }

  function addTier() {
    setMsg(null)
    setTiers((prev) => [
      ...prev,
      {
        id: `new_${Date.now()}`,
        country,
        city,
        variant,
        min_trips: 0,
        pct: 0,
        cap: 0,
        valid_from: today,
        valid_to: null,
        _new: true,
      },
    ])
  }

  const isDirty = (tier) => {
    if (tier._new) return true
    const o = original.find((x) => x.id === tier.id)
    if (!o) return true
    return (
      Number(tier.min_trips) !== Number(o.min_trips) ||
      Number(tier.pct) !== Number(o.pct) ||
      Number(tier.cap) !== Number(o.cap)
    )
  }

  async function saveTier(tier) {
    setSaving(true)
    setMsg(null)
    const payload = {
      country,
      city: tier.city,
      variant: tier.variant,
      min_trips: Number(tier.min_trips) || 0,
      pct: Number(tier.pct) || 0,
      cap: Number(tier.cap) || 0,
    }
    if (tier._new) {
      payload.valid_from = tier.valid_from || today
      payload.source_type = 'captura'
    }
    let err
    if (tier._new) {
      ;({ error: err } = await sb.from('yango_gmv_tiers').insert(payload))
    } else {
      ;({ error: err } = await sb.from('yango_gmv_tiers').update(payload).eq('id', tier.id))
    }
    if (err) {
      setMsg({ type: 'err', text: t('config.yango_gmv.save_error', { msg: err.message }) })
    } else {
      setMsg({
        type: 'ok',
        text: t('config.yango_gmv.saved_toast', {
          trips: payload.min_trips,
          pct: payload.pct,
          cap: payload.cap,
        }),
      })
      await load()
    }
    setSaving(false)
  }

  // mig 237 — versión nueva de toda la escalera (ciudad × variante) desde ladderFrom.
  async function newLadderVersion() {
    if (!currentRows.length) return
    if (ladderFrom <= currentValidFrom) {
      setMsg({ type: 'err', text: t('config.yango_gmv.new_ladder_date_error') })
      return
    }
    setSaving(true)
    setMsg(null)
    const { data, error } = await sb.rpc('yango_gmv_ladder_new_version', {
      p_country: country,
      p_city: city,
      p_variant: variant,
      p_valid_from: ladderFrom,
      p_tiers: currentRows.map((r) => ({
        min_trips: Number(r.min_trips) || 0,
        pct: Number(r.pct) || 0,
        cap: Number(r.cap) || 0,
      })),
      p_source_type: 'captura',
    })
    if (error) {
      setMsg({ type: 'err', text: t('config.yango_gmv.new_ladder_error', { msg: error.message }) })
    } else {
      setMsg({
        type: 'ok',
        text: t('config.yango_gmv.new_ladder_ok', { date: ladderFrom, n: data ?? 0 }),
      })
      await load()
    }
    setSaving(false)
  }

  async function deleteTier(tier) {
    if (String(tier.id).startsWith('new_')) {
      setTiers((prev) => prev.filter((x) => x.id !== tier.id))
      return
    }
    const ok = await confirm({
      title: t('config.yango_gmv.delete_confirm_title'),
      message: t('config.yango_gmv.delete_confirm_message'),
      danger: true,
      confirmText: t('app.delete'),
    })
    if (!ok) return
    const { error } = await sb.from('yango_gmv_tiers').delete().eq('id', tier.id)
    if (!error) {
      setMsg({ type: 'ok', text: t('config.yango_gmv.delete_success') })
      await load()
    } else {
      setMsg({ type: 'err', text: t('config.yango_gmv.delete_error', { msg: error.message }) })
    }
  }

  if (loading) return <div className="config-loading">{t('config.yango_gmv.loading')}</div>

  const dirtyCellStyle = { background: '#fef3c7', borderColor: '#f59e0b', fontWeight: 600 }

  return (
    <div className="config-section">
      <h2>{t('config.yango_gmv.title')}</h2>
      <p style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 12 }}>
        {t('config.yango_gmv.description')}
      </p>

      <div
        style={{
          display: 'flex',
          gap: 12,
          marginBottom: 12,
          flexWrap: 'wrap',
          alignItems: 'center',
        }}
      >
        <label>
          {t('filter.city')}{' '}
          <select value={city} onChange={(e) => setCity(e.target.value)}>
            {CITIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <div style={{ display: 'inline-flex', gap: 6 }}>
          {VARIANTS.map((v) => {
            const disabled = v.key === 'vip' && city !== 'Lima'
            return (
              <Button
                key={v.key}
                variant={variant === v.key ? 'default' : 'outline'}
                size="sm"
                onClick={() => setVariant(v.key)}
                disabled={disabled}
              >
                {t(v.labelKey)}
              </Button>
            )
          })}
        </div>
        <label
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
            color: 'var(--color-muted)',
          }}
        >
          <input
            type="checkbox"
            checked={showHistory}
            onChange={(e) => setShowHistory(e.target.checked)}
            style={{ accentColor: 'var(--color-yango)' }}
          />
          {t('config.yango_gmv.show_history')} ({expiredCount})
        </label>
      </div>

      <SaveStatusBanner status={msg} onDismiss={() => setMsg(null)} />

      <table className="config-table" style={{ marginTop: 10 }}>
        <thead>
          <tr>
            <th scope="col">{t('config.yango_gmv.col_trips')}</th>
            <th scope="col">{t('config.yango_gmv.col_pct')}</th>
            <th scope="col">{t('config.yango_gmv.col_cap')}</th>
            <th scope="col">{t('config.yango_gmv.col_validity')}</th>
            <th scope="col"></th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={5} style={{ color: 'var(--color-muted)' }}>
                {t('config.yango_gmv.empty', {
                  city,
                  variant: t(VARIANTS.find((v) => v.key === variant)?.labelKey),
                })}
              </td>
            </tr>
          )}
          {rows.map((tier) => {
            const dirty = isDirty(tier)
            const expired = isExpired(tier)
            return (
              <tr
                key={tier.id}
                style={dirty ? { background: '#fffbeb' } : expired ? { opacity: 0.6 } : undefined}
              >
                <td>
                  <input
                    type="number"
                    min="0"
                    value={tier.min_trips}
                    onChange={(e) => update(tier.id, 'min_trips', e.target.value)}
                    style={{ width: 80, ...(dirty ? dirtyCellStyle : {}) }}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    value={tier.pct}
                    onChange={(e) => update(tier.id, 'pct', e.target.value)}
                    style={{ width: 70, ...(dirty ? dirtyCellStyle : {}) }}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    min="0"
                    value={tier.cap}
                    onChange={(e) => update(tier.id, 'cap', e.target.value)}
                    style={{ width: 80, ...(dirty ? dirtyCellStyle : {}) }}
                  />
                </td>
                <td style={{ fontSize: 11, color: expired ? '#dc2626' : 'var(--color-muted)' }}>
                  {tier.valid_from}
                  {tier.valid_to ? ` → ${tier.valid_to}` : ' →'}
                </td>
                <td style={{ display: 'flex', gap: 6 }}>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => saveTier(tier)}
                    disabled={saving || !dirty}
                    title={
                      !dirty
                        ? t('config.commissions.no_changes_title')
                        : t('config.yango_gmv.save_title')
                    }
                  >
                    {tier._new ? t('config.commissions.create_btn') : t('app.save')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="border-red-300 text-red-600 hover:bg-red-100"
                    aria-label={t('app.delete')}
                    onClick={() => deleteTier(tier)}
                  >
                    ✕
                  </Button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <div
        style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 }}
      >
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="border-dashed border-border text-muted hover:border-yango hover:text-yango"
          onClick={addTier}
        >
          + {t('config.yango_gmv.add_btn')}
        </Button>
        {currentRows.length > 0 && (
          <span
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}
            title={t('config.yango_gmv.new_ladder_prompt')}
          >
            <input
              type="date"
              value={ladderFrom}
              min={nextDay(currentValidFrom)}
              style={{ width: 140 }}
              onChange={(e) => setLadderFrom(e.target.value)}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={saving}
              onClick={newLadderVersion}
            >
              {t('config.yango_gmv.new_ladder_btn')}
            </Button>
          </span>
        )}
      </div>
    </div>
  )
}
