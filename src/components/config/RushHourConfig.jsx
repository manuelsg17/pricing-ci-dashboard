import { useState, useMemo } from 'react'
import { getCountryConfig } from '../../lib/constants'
import { dbErrorText } from '../../lib/dbErrorText'
import { useConfigTable } from '../../hooks/useConfigTable'
import { useCountry } from '../../context/CountryContext'
import SaveStatusBanner from './SaveStatusBanner'
import { useConfirm } from '../ui/ConfirmDialog'
import { useI18n } from '../../context/LanguageContext'
import { Button } from '../ui/shadcn/button'
import { timeOrderError, findOverlap } from '../../lib/timeWindows'

export default function RushHourConfig({ country }) {
  const { dbConfigs } = useCountry()
  const config = getCountryConfig(country, dbConfigs)
  const confirm = useConfirm()
  const { t } = useI18n()
  const dbCities = config.dbCities
  const allCities = useMemo(() => ['all', ...dbCities], [dbCities])

  const tbl = useConfigTable({
    table: 'rush_hour_windows',
    country,
    query: (q) => q.in('city', allCities).order('city').order('start_time'),
    newRow: () => ({ city: 'all', label: '', start_time: '07:00', end_time: '09:00' }),
    toPayload: (w) => ({
      country,
      city: w.city,
      label: w.label || null,
      start_time: w.start_time,
      end_time: w.end_time,
    }),
  })
  const { rows: windows, loading, saving, error: loadError } = tbl
  const [msg, setMsg] = useState(null)

  function update(id, field, val) {
    setMsg(null)
    tbl.setField(id, field, val)
  }

  const cityLabel = (c) => (c === 'all' ? t('config.commissions.all_cities') : c)

  async function saveWindow(w) {
    // Validación: orden y solape dentro de la misma ciudad ('all' compite con todas).
    if (timeOrderError(w.start_time, w.end_time)) {
      setMsg({ type: 'err', text: t('config.rushhour.time_order_error') })
      return
    }
    const clash = findOverlap(windows, w, (r) => r.city || 'all')
    if (clash) {
      setMsg({
        type: 'err',
        text: t('config.rushhour.overlap_error', {
          city: cityLabel(clash.city),
          start: String(clash.start_time).slice(0, 5),
          end: String(clash.end_time).slice(0, 5),
        }),
      })
      return
    }
    setMsg(null)
    const { ok, error } = await tbl.saveRow(w)
    if (!ok) {
      setMsg({ type: 'err', text: t('config.rushhour.save_error', { msg: dbErrorText(t, error) }) })
      return
    }
    setMsg({
      type: 'ok',
      text: t('config.rushhour.saved_toast', {
        city: cityLabel(w.city),
        start: w.start_time,
        end: w.end_time,
      }),
    })
  }

  async function deleteWindow(id) {
    if (tbl.isNew(id)) {
      tbl.deleteRow(id)
      return
    }
    const ok = await confirm({
      title: t('config.rushhour.delete_confirm_title'),
      message: t('config.rushhour.delete_confirm_message'),
      danger: true,
      confirmText: t('app.delete'),
    })
    if (!ok) return
    const res = await tbl.deleteRow(id)
    if (res.ok) setMsg({ type: 'ok', text: t('config.rushhour.delete_success') })
    else
      setMsg({
        type: 'err',
        text: t('config.rushhour.delete_error', { msg: dbErrorText(t, res.error) }),
      })
  }

  if (loading) return <div className="config-loading">{t('config.rushhour.loading')}</div>

  return (
    <div className="config-section">
      <h2>{t('config.rushhour.title')}</h2>
      <p style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 12 }}>
        {t('config.rushhour.description')}
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
            <th scope="col">{t('config.rushhour.col_label')}</th>
            <th scope="col">{t('filter.from')}</th>
            <th scope="col">{t('filter.to')}</th>
            <th scope="col"></th>
          </tr>
        </thead>
        <tbody>
          {windows.map((w) => {
            const dirty = tbl.isDirty(w.id)
            const cls = dirty ? 'config-dirty' : undefined
            return (
              <tr key={w.id} className={dirty ? 'config-row--dirty' : undefined}>
                <td>
                  <select
                    value={w.city}
                    onChange={(e) => update(w.id, 'city', e.target.value)}
                    className={cls}
                  >
                    {allCities.map((c) => (
                      <option key={c} value={c}>
                        {cityLabel(c)}
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
                    className={cls}
                    style={{ width: 90 }}
                  />
                </td>
                <td>
                  <input
                    type="time"
                    value={w.start_time?.slice(0, 5) || ''}
                    onChange={(e) => update(w.id, 'start_time', e.target.value)}
                    className={cls}
                    style={{ width: 90 }}
                  />
                </td>
                <td>
                  <input
                    type="time"
                    value={w.end_time?.slice(0, 5) || ''}
                    onChange={(e) => update(w.id, 'end_time', e.target.value)}
                    className={cls}
                    style={{ width: 90 }}
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
        onClick={() => {
          setMsg(null)
          tbl.addRow()
        }}
      >
        + {t('config.rushhour.add_btn')}
      </Button>
    </div>
  )
}
