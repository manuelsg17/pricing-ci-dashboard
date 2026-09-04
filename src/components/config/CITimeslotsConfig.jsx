import { useState } from 'react'
import { dbErrorText } from '../../lib/dbErrorText'
import { useConfigTable } from '../../hooks/useConfigTable'
import SaveStatusBanner from './SaveStatusBanner'
import { useConfirm } from '../ui/ConfirmDialog'
import { useI18n } from '../../context/LanguageContext'
import { Button } from '../ui/shadcn/button'
import { timeOrderError, findOverlap } from '../../lib/timeWindows'

// `ci_timeslots` es GLOBAL por diseño: no tiene columna `country` (mig 187
// la documenta así en section_write_grants y mig 190 la deja fuera del
// cierre por país). Config.jsx pasa `country` como a todos los editores,
// pero acá no hay nada que filtrar ni que guardar por país — los turnos son
// los mismos para Perú, Colombia y Nepal. Si algún día se regionalizan, va
// una migración (columna + RLS) y recién ahí `country` entra al hook.
export default function CITimeslotsConfig() {
  const confirm = useConfirm()
  const { t } = useI18n()

  const tbl = useConfigTable({
    table: 'ci_timeslots',
    query: (q) => q.order('sort_order'),
    toPayload: (r) => ({
      label: r.label.trim(),
      start_time: r.start_time,
      end_time: r.end_time,
      is_active: r.is_active,
      sort_order: Number(r.sort_order) || 0,
    }),
  })
  const { rows, loading, saving, error: loadError } = tbl
  const [msg, setMsg] = useState(null)

  function update(id, field, val) {
    setMsg(null)
    tbl.setField(id, field, val)
  }

  function addRow() {
    const maxOrder = rows.reduce((m, r) => Math.max(m, Number(r.sort_order) || 0), 0)
    setMsg(null)
    tbl.addRow({
      label: '',
      start_time: '08:00',
      end_time: '10:00',
      is_active: true,
      sort_order: maxOrder + 1,
    })
  }

  async function saveRow(r) {
    if (!r.label?.trim()) {
      setMsg({ type: 'err', text: t('config.citimeslots.label_empty_error') })
      return
    }
    if (timeOrderError(r.start_time, r.end_time)) {
      setMsg({ type: 'err', text: t('config.citimeslots.time_order_error') })
      return
    }
    const clash = r.is_active === false ? null : findOverlap(rows, r)
    if (clash) {
      setMsg({
        type: 'err',
        text: t('config.citimeslots.overlap_error', {
          label: clash.label,
          start: String(clash.start_time).slice(0, 5),
          end: String(clash.end_time).slice(0, 5),
        }),
      })
      return
    }
    setMsg(null)
    const { ok, error } = await tbl.saveRow(r)
    if (!ok) {
      setMsg({
        type: 'err',
        text: t('config.citimeslots.save_error', { msg: dbErrorText(t, error) }),
      })
      return
    }
    setMsg({
      type: 'ok',
      text: t('config.citimeslots.saved_toast', {
        label: r.label.trim(),
        start: r.start_time,
        end: r.end_time,
      }),
    })
  }

  async function deleteRow(id) {
    if (tbl.isNew(id)) {
      tbl.deleteRow(id)
      return
    }
    const ok = await confirm({
      title: t('config.citimeslots.delete_confirm_title'),
      message: t('config.citimeslots.delete_confirm_message'),
      danger: true,
      confirmText: t('app.delete'),
    })
    if (!ok) return
    const res = await tbl.deleteRow(id)
    if (res.ok) setMsg({ type: 'ok', text: t('config.citimeslots.delete_success') })
    else
      setMsg({
        type: 'err',
        text: t('config.citimeslots.delete_error', { msg: dbErrorText(t, res.error) }),
      })
  }

  if (loading) return <div className="config-loading">{t('config.citimeslots.loading')}</div>

  return (
    <div className="config-section">
      <h2>{t('config.citimeslots.title')}</h2>
      <p style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 12 }}>
        {t('config.citimeslots.description')}
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
            <th style={{ width: 30 }}>#</th>
            <th scope="col">{t('config.citimeslots.col_label')}</th>
            <th scope="col">{t('config.citimeslots.col_start')}</th>
            <th scope="col">{t('config.citimeslots.col_end')}</th>
            <th scope="col">{t('config.citimeslots.col_active')}</th>
            <th scope="col">{t('config.citimeslots.col_order')}</th>
            <th scope="col"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const dirty = tbl.isDirty(r.id)
            const cls = dirty ? 'config-dirty' : undefined
            return (
              <tr key={r.id} className={dirty ? 'config-row--dirty' : undefined}>
                <td style={{ color: 'var(--color-muted)', fontSize: 11 }}>{i + 1}</td>
                <td>
                  <input
                    type="text"
                    value={r.label || ''}
                    onChange={(e) => update(r.id, 'label', e.target.value)}
                    placeholder={t('config.citimeslots.label_placeholder')}
                    className={cls}
                    style={{ width: 100 }}
                  />
                </td>
                <td>
                  <input
                    type="time"
                    value={r.start_time?.slice(0, 5) || ''}
                    onChange={(e) => update(r.id, 'start_time', e.target.value)}
                    className={cls}
                    style={{ width: 90 }}
                  />
                </td>
                <td>
                  <input
                    type="time"
                    value={r.end_time?.slice(0, 5) || ''}
                    onChange={(e) => update(r.id, 'end_time', e.target.value)}
                    className={cls}
                    style={{ width: 90 }}
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={!!r.is_active}
                    onChange={(e) => update(r.id, 'is_active', e.target.checked)}
                    style={{
                      width: 16,
                      height: 16,
                      accentColor: 'var(--color-yango)',
                      cursor: 'pointer',
                    }}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    value={r.sort_order ?? 0}
                    onChange={(e) => update(r.id, 'sort_order', e.target.value)}
                    className={cls}
                    style={{ width: 60 }}
                    min="0"
                  />
                </td>
                <td style={{ display: 'flex', gap: 6 }}>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => saveRow(r)}
                    disabled={saving || !dirty}
                    title={!dirty ? t('config.commissions.no_changes_title') : undefined}
                  >
                    {r._new ? t('config.commissions.create_btn') : t('app.save')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="border-red-300 text-red-600 hover:bg-red-100"
                    aria-label={t('app.delete')}
                    onClick={() => deleteRow(r.id)}
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
        onClick={addRow}
      >
        + {t('config.citimeslots.add_btn')}
      </Button>
    </div>
  )
}
