import { useState, useEffect, useMemo } from 'react'
import { BRACKETS, BRACKET_LABELS, getCountryConfig } from '../../lib/constants'
import SaveStatusBanner from './SaveStatusBanner'
import UnsavedChangesBanner from './UnsavedChangesBanner'
import { dbErrorText } from '../../lib/dbErrorText'
import { useConfirm } from '../ui/ConfirmDialog'
import { useCountry } from '../../context/CountryContext'
import { useI18n } from '../../context/LanguageContext'
import { sb } from '../../lib/supabase'
import { Button } from '../ui/shadcn/button'

export default function ThresholdsTable({ thresholds, onSave, saving, country }) {
  const { dbConfigs } = useCountry()
  const config = getCountryConfig(country, dbConfigs)
  const { t } = useI18n()

  const [selectedCity, setSelectedCity] = useState(config.dbCities[0])
  const [selectedCat, setSelectedCat] = useState(
    config.categoriesByCity?.[config.dbCities[0]]?.[0] || ''
  )

  // Reseteo si cambia país
  useEffect(() => {
    if (!config.dbCities.includes(selectedCity)) {
      const newCity = config.dbCities[0]
      setSelectedCity(newCity)
      setSelectedCat(config.categoriesByCity?.[newCity]?.[0] || '')
    }
  }, [country, config.dbCities, config.categoriesByCity, selectedCity])

  const [local, setLocal] = useState({})
  const [saveMsg, setSaveMsg] = useState(null) // { type: 'ok'|'warn'|'err', text } | null

  const getKey = (city, cat, bracket) => `${city}|||${cat}|||${bracket}`

  const getDbValue = (bracket) => {
    const row = thresholds.find(
      (th) => th.city === selectedCity && th.category === selectedCat && th.bracket === bracket
    )
    return row ? (row.max_km ?? '') : ''
  }

  const getValue = (bracket) => {
    const key = getKey(selectedCity, selectedCat, bracket)
    if (key in local) return local[key]
    return getDbValue(bracket)
  }

  // ¿El input del bracket actual está sucio (distinto del valor de BD)?
  const isDirty = (bracket) => {
    const key = getKey(selectedCity, selectedCat, bracket)
    if (!(key in local)) return false
    const localVal = String(local[key] ?? '')
    const dbVal = String(getDbValue(bracket) ?? '')
    return localVal !== dbVal
  }

  // Hay al menos un input modificado en la ciudad+categoría actual
  const hasUnsavedChanges = BRACKETS.some((b) => isDirty(b))

  // Validación monotónica: cada bracket debe ser estrictamente mayor al anterior.
  // El último bracket puede ser vacío (∞).
  const validationErrors = useMemo(() => {
    const errs = []
    let prev = null
    BRACKETS.forEach((b, i) => {
      const raw = getValue(b)
      const isLast = i === BRACKETS.length - 1
      if (raw === '' || raw === null || raw === undefined) {
        if (!isLast) errs.push({ bracket: b, msg: t('config.thresholds.err_missing') })
        return
      }
      const num = Number(raw)
      if (!isFinite(num) || num <= 0) {
        errs.push({ bracket: b, msg: t('config.thresholds.err_positive') })
        return
      }
      if (prev != null && num <= prev) {
        errs.push({ bracket: b, msg: t('config.thresholds.err_greater', { prev }) })
      }
      prev = num
    })
    return errs
    // getValue no está memoizado pero sus únicas dependencias reales
    // (local/thresholds/selectedCity/selectedCat) ya están en este array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [local, thresholds, selectedCity, selectedCat])

  const hasErrors = validationErrors.length > 0

  const handleChange = (bracket, val) => {
    setSaveMsg(null)
    setLocal((prev) => ({ ...prev, [getKey(selectedCity, selectedCat, bracket)]: val }))
  }

  const handleDiscard = () => {
    setSaveMsg(null)
    setLocal((prev) => {
      const next = { ...prev }
      BRACKETS.forEach((b) => delete next[getKey(selectedCity, selectedCat, b)])
      return next
    })
  }

  const confirm = useConfirm()

  // Núcleo de save — recibe withSnapshot para decidir si crear hard copy
  const doSave = async (withSnapshot) => {
    setSaveMsg(null)
    if (hasErrors) {
      setSaveMsg({
        type: 'err',
        text: t('config.thresholds.validation_error', {
          n: validationErrors.length,
          count: validationErrors.length,
        }),
      })
      return
    }

    const ok = await confirm({
      title: withSnapshot
        ? t('config.thresholds.confirm_snapshot_title')
        : t('config.thresholds.confirm_nosnapshot_title'),
      message: withSnapshot
        ? t('config.thresholds.confirm_snapshot_message')
        : t('config.thresholds.confirm_nosnapshot_message'),
      confirmText: withSnapshot
        ? t('config.thresholds.confirm_snapshot_btn')
        : t('config.thresholds.confirm_nosnapshot_btn'),
      cancelText: t('app.cancel'),
      danger: withSnapshot,
    })
    if (!ok) return

    if (withSnapshot) {
      const { error: snapErr } = await sb.rpc('freeze_pricing_wa', {
        p_country: country,
        p_label: t('config.thresholds.snapshot_label', { date: new Date().toISOString() }),
      })
      if (snapErr) {
        setSaveMsg({
          type: 'err',
          text: t('config.thresholds.snapshot_error', { msg: dbErrorText(t, snapErr) }),
        })
        return
      }
    }

    const rows = BRACKETS.map((b) => ({
      city: selectedCity,
      category: selectedCat,
      bracket: b,
      max_km: getValue(b) === '' ? null : Number(getValue(b)),
    }))
    try {
      const result = await onSave(rows)
      const recomputed = result?.recomputedCount ?? 0
      const rpcError = result?.rpcError
      const snapNote = withSnapshot
        ? t('config.thresholds.saved_with_snapshot_suffix')
        : t('config.thresholds.saved_without_snapshot_suffix')

      if (recomputed > 0) {
        setSaveMsg({
          type: 'ok',
          text: t('config.thresholds.saved_recomputed', {
            snap: snapNote,
            n: recomputed.toLocaleString(),
          }),
        })
      } else if (rpcError) {
        setSaveMsg({
          type: 'warn',
          text: t('config.thresholds.saved_rpc_warn', {
            city: selectedCity,
            category: selectedCat,
            snap: snapNote,
            err: rpcError,
          }),
        })
      } else {
        setSaveMsg({
          type: 'ok',
          text: t('config.thresholds.saved_no_rows', {
            city: selectedCity,
            category: selectedCat,
            snap: snapNote,
          }),
        })
      }
      setLocal((prev) => {
        const next = { ...prev }
        BRACKETS.forEach((b) => delete next[getKey(selectedCity, selectedCat, b)])
        return next
      })
    } catch (e) {
      setSaveMsg({
        type: 'err',
        text: t('config.thresholds.save_error', { msg: dbErrorText(t, e) }),
      })
    }
  }

  const handleSave = () => doSave(true)
  const handleSaveNoSnapshot = () => doSave(false)

  return (
    <div className="config-section">
      <h2>{t('config.thresholds.title')}</h2>
      <p style={{ fontSize: 11, color: '#888', marginBottom: 10 }}>
        {t('config.thresholds.subtitle')}
      </p>

      <div className="threshold-selector">
        <label>{t('filter.city')}</label>
        <select
          value={selectedCity}
          onChange={(e) => {
            setSelectedCity(e.target.value)
            setSelectedCat(config.categoriesByCity?.[e.target.value]?.[0] || '')
          }}
        >
          {config.dbCities.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>

        <label>{t('filter.category')}</label>
        <select value={selectedCat} onChange={(e) => setSelectedCat(e.target.value)}>
          {(config.categoriesByCity?.[selectedCity] || []).map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </div>

      {/* Aviso inline de cambios pendientes */}
      {hasUnsavedChanges && (
        <UnsavedChangesBanner onDiscard={handleDiscard}>
          {t('config.thresholds.unsaved_prefix')}{' '}
          <strong>
            {selectedCity} — {selectedCat}
          </strong>
        </UnsavedChangesBanner>
      )}

      <table className="config-table">
        <thead>
          <tr>
            <th style={{ textAlign: 'left' }}>{t('config.thresholds.col_bracket')}</th>
            <th scope="col">{t('config.thresholds.col_max_km')}</th>
            <th style={{ textAlign: 'left', fontSize: 9 }}>
              {t('config.thresholds.col_description')}
            </th>
          </tr>
        </thead>
        <tbody>
          {BRACKETS.map((b, i) => {
            const dirty = isDirty(b)
            const err = validationErrors.find((e) => e.bracket === b)
            const inputCls = err ? 'config-dirty--error' : dirty ? 'config-dirty' : undefined
            return (
              <tr key={b}>
                <td>{BRACKET_LABELS[b]}</td>
                <td>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder={i === BRACKETS.length - 1 ? '∞' : '0.00'}
                    value={getValue(b)}
                    onChange={(e) => handleChange(b, e.target.value)}
                    className={inputCls}
                    title={
                      err
                        ? err.msg
                        : dirty
                          ? t('config.thresholds.db_value_hint', {
                              value: getDbValue(b) || t('config.thresholds.no_limit'),
                            })
                          : undefined
                    }
                  />
                  {err && (
                    <div style={{ fontSize: 10, color: '#b91c1c', marginTop: 2 }}>{err.msg}</div>
                  )}
                </td>
                <td style={{ textAlign: 'left', fontSize: 10, color: '#888', paddingLeft: 8 }}>
                  {i === 0 && t('config.thresholds.desc_first', { km: getValue(b) || '?' })}
                  {i > 0 &&
                    i < BRACKETS.length - 1 &&
                    t('config.thresholds.desc_middle', {
                      min: getValue(BRACKETS[i - 1]) || '?',
                      max: getValue(b) || '?',
                    })}
                  {i === BRACKETS.length - 1 && t('config.thresholds.desc_last')}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <div
        className="config-footer"
        style={{ marginTop: 14, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}
      >
        {/* Primario: sin snapshot — el usuario lo usa frecuentemente */}
        <Button
          onClick={handleSaveNoSnapshot}
          disabled={saving || !hasUnsavedChanges || hasErrors}
          title={
            hasErrors
              ? t('config.thresholds.fix_errors_title')
              : !hasUnsavedChanges
                ? t('config.semaforo.no_changes_title')
                : t('config.thresholds.save_no_snapshot_title')
          }
        >
          {saving ? t('account.saving') : t('config.thresholds.save_no_snapshot_btn')}
        </Button>
        {/* Secundario: con snapshot — para cambios que afectan data histórica significativa */}
        <Button
          variant="outline"
          className="border-slate-300 text-slate-600"
          onClick={handleSave}
          disabled={saving || !hasUnsavedChanges || hasErrors}
          title={t('config.thresholds.save_snapshot_title')}
        >
          📸 {t('config.thresholds.save_snapshot_btn')}
        </Button>

        <SaveStatusBanner status={saveMsg} onDismiss={() => setSaveMsg(null)} />
      </div>
    </div>
  )
}
