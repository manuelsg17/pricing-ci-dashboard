import { useState, useEffect } from 'react'
import { sb } from '../../lib/supabase'
import { getCountryConfig } from '../../lib/constants'
import { useCountry } from '../../context/CountryContext'
import SaveStatusBanner from './SaveStatusBanner'
import { useConfirm } from '../ui/ConfirmDialog'
import { useI18n } from '../../context/LanguageContext'
import { Button } from '../ui/shadcn/button'

export default function RushHourConfig({ country }) {
  const { dbConfigs } = useCountry()
  const config = getCountryConfig(country, dbConfigs)
  const confirm = useConfirm()
  const { t } = useI18n()
  const allCities = ['all', ...config.dbCities]

  const [windows, setWindows] = useState([])
  const [original, setOriginal] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState(null)

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [country])

  // Live-sync: si otra sesión modifica rush_hour_windows, recargamos
  // preservando dirty rows. Mismo patrón que AirportMarkersTable.
  useEffect(() => {
    function onChange(e) {
      if (e?.detail?.table === 'rush_hour_windows') loadPreservingDirty()
    }
    window.addEventListener('config:changed', onChange)
    return () => window.removeEventListener('config:changed', onChange)
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [country])

  async function load() {
    setLoading(true)
    const { data } = await sb
      .from('rush_hour_windows')
      .select('*')
      .eq('country', country)
      .in('city', allCities)
      .order('city')
      .order('start_time')
    setWindows(data || [])
    setOriginal((data || []).map((r) => ({ ...r })))
    setLoading(false)
  }

  // Recarga server pero preserva filas dirty para no pisar trabajo en curso.
  async function loadPreservingDirty() {
    const { data } = await sb
      .from('rush_hour_windows')
      .select('*')
      .eq('country', country)
      .in('city', allCities)
      .order('city')
      .order('start_time')
    const fresh = data || []
    setWindows((prev) => {
      const dirtyRows = prev.filter(isRowDirty)
      const dirtyIds = new Set(dirtyRows.map((r) => r.id))
      const cleanFromServer = fresh.filter((s) => !dirtyIds.has(s.id))
      return [...cleanFromServer, ...dirtyRows]
    })
    setOriginal(fresh.map((r) => ({ ...r })))
  }

  function update(id, field, val) {
    setMsg(null)
    setWindows((prev) => prev.map((w) => (w.id === id ? { ...w, [field]: val } : w)))
  }

  function addWindow() {
    const tempId = `new_${Date.now()}`
    setMsg(null)
    setWindows((prev) => [
      ...prev,
      {
        id: tempId,
        city: 'all',
        label: '',
        start_time: '07:00',
        end_time: '09:00',
        _new: true,
      },
    ])
  }

  const isRowDirty = (w) => {
    if (w._new) return true
    const orig = original.find((o) => o.id === w.id)
    if (!orig) return true
    return (
      String(w.city ?? '') !== String(orig.city ?? '') ||
      String(w.label ?? '') !== String(orig.label ?? '') ||
      String(w.start_time ?? '') !== String(orig.start_time ?? '') ||
      String(w.end_time ?? '') !== String(orig.end_time ?? '')
    )
  }

  async function saveWindow(w) {
    setSaving(true)
    setMsg(null)
    const payload = {
      country,
      city: w.city,
      label: w.label || null,
      start_time: w.start_time,
      end_time: w.end_time,
    }
    let err
    if (w._new) {
      ;({ error: err } = await sb.from('rush_hour_windows').insert(payload))
    } else {
      ;({ error: err } = await sb.from('rush_hour_windows').update(payload).eq('id', w.id))
    }
    if (err) {
      setMsg({ type: 'err', text: t('config.rushhour.save_error', { msg: err.message }) })
    } else {
      setMsg({
        type: 'ok',
        text: t('config.rushhour.saved_toast', {
          city: payload.city === 'all' ? t('config.commissions.all_cities') : payload.city,
          start: payload.start_time,
          end: payload.end_time,
        }),
      })
      await load()
    }
    setSaving(false)
  }

  async function deleteWindow(id) {
    if (String(id).startsWith('new_')) {
      setWindows((prev) => prev.filter((w) => w.id !== id))
      return
    }
    const ok = await confirm({
      title: t('config.rushhour.delete_confirm_title'),
      message: t('config.rushhour.delete_confirm_message'),
      danger: true,
      confirmText: t('app.delete'),
    })
    if (!ok) return
    const { error } = await sb.from('rush_hour_windows').delete().eq('id', id)
    if (!error) {
      setMsg({ type: 'ok', text: t('config.rushhour.delete_success') })
      await load()
    } else {
      setMsg({ type: 'err', text: t('config.rushhour.delete_error', { msg: error.message }) })
    }
  }

  if (loading) return <div className="config-loading">{t('config.rushhour.loading')}</div>

  const dirtyCellStyle = {
    background: '#fef3c7',
    borderColor: '#f59e0b',
    fontWeight: 600,
    boxShadow: '0 0 0 2px rgba(245, 158, 11, 0.2)',
  }

  return (
    <div className="config-section">
      <h2>{t('config.rushhour.title')}</h2>
      <p style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 12 }}>
        {t('config.rushhour.description')}
      </p>

      <SaveStatusBanner status={msg} onDismiss={() => setMsg(null)} />

      <table className="config-table" style={{ marginTop: 10 }}>
        <thead>
          <tr>
            <th scope="col">{t('filter.city')}</th>
            <th scope="col">{t('config.rushhour.col_label')}</th>
            <th scope="col">{t('filter.from')}</th>
            <th scope="col">{t('filter.to')}</th>
            <th scope="col"></th>
          </tr>
        </thead>
        <tbody>
          {windows.map((w) => {
            const dirty = isRowDirty(w)
            return (
              <tr key={w.id} style={dirty ? { background: '#fffbeb' } : undefined}>
                <td>
                  <select
                    value={w.city}
                    onChange={(e) => update(w.id, 'city', e.target.value)}
                    style={dirty ? dirtyCellStyle : undefined}
                  >
                    {allCities.map((c) => (
                      <option key={c} value={c}>
                        {c === 'all' ? t('config.commissions.all_cities') : c}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    type="text"
                    value={w.label || ''}
                    onChange={(e) => update(w.id, 'label', e.target.value)}
                    placeholder={t('config.citimeslots.label_placeholder')}
                    style={{ width: 90, ...(dirty ? dirtyCellStyle : {}) }}
                  />
                </td>
                <td>
                  <input
                    type="time"
                    value={w.start_time?.slice(0, 5) || ''}
                    onChange={(e) => update(w.id, 'start_time', e.target.value)}
                    style={{ width: 90, ...(dirty ? dirtyCellStyle : {}) }}
                  />
                </td>
                <td>
                  <input
                    type="time"
                    value={w.end_time?.slice(0, 5) || ''}
                    onChange={(e) => update(w.id, 'end_time', e.target.value)}
                    style={{ width: 90, ...(dirty ? dirtyCellStyle : {}) }}
                  />
                </td>
                <td style={{ display: 'flex', gap: 6 }}>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => saveWindow(w)}
                    disabled={saving || !dirty}
                    title={
                      !dirty
                        ? t('config.commissions.no_changes_title')
                        : t('config.rushhour.save_title')
                    }
                  >
                    {w._new ? t('config.commissions.create_btn') : t('app.save')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="border-red-300 text-red-600 hover:bg-red-100"
                    aria-label={t('app.delete')}
                    onClick={() => deleteWindow(w.id)}
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
        onClick={addWindow}
      >
        + {t('config.rushhour.add_btn')}
      </Button>
    </div>
  )
}
