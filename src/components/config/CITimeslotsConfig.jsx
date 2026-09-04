import { useState, useEffect } from 'react'
import { sb } from '../../lib/supabase'
import SaveStatusBanner from './SaveStatusBanner'
import { useConfirm } from '../ui/ConfirmDialog'
import { useI18n } from '../../context/LanguageContext'
import { Button } from '../ui/shadcn/button'
import { timeOrderError, findOverlap } from '../../lib/timeWindows'

const DIRTY_STYLE = {
  background: '#fef3c7',
  borderColor: '#f59e0b',
  fontWeight: 600,
  boxShadow: '0 0 0 2px rgba(245, 158, 11, 0.2)',
}

export default function CITimeslotsConfig() {
  const confirm = useConfirm()
  const [rows, setRows] = useState([])
  const [original, setOriginal] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState(null)
  const { t } = useI18n()

  useEffect(() => {
    load() /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [])

  // Live-sync: ci_timeslots está auditada y en REFETCHABLE_TABLES, pero
  // este editor no escuchaba (auditoría Config 2026-09-03, B15).
  useEffect(() => {
    function onChange(e) {
      if (e?.detail?.table === 'ci_timeslots') load()
    }
    window.addEventListener('config:changed', onChange)
    return () => window.removeEventListener('config:changed', onChange)
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [])

  async function load() {
    setLoading(true)
    const { data, error } = await sb.from('ci_timeslots').select('*').order('sort_order')
    if (error) setMsg({ type: 'err', text: t('config.load_error', { msg: error.message }) })
    setRows(data || [])
    setOriginal((data || []).map((r) => ({ ...r })))
    setLoading(false)
  }

  function update(id, field, val) {
    setMsg(null)
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, [field]: val } : r)))
  }

  function addRow() {
    const maxOrder = rows.reduce((m, r) => Math.max(m, r.sort_order || 0), 0)
    const tempId = `new_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    setMsg(null)
    setRows((prev) => [
      ...prev,
      {
        id: tempId,
        label: '',
        start_time: '08:00',
        end_time: '10:00',
        is_active: true,
        sort_order: maxOrder + 1,
        _new: true,
      },
    ])
  }

  const isRowDirty = (r) => {
    if (r._new) return true
    const orig = original.find((o) => o.id === r.id)
    if (!orig) return true
    return (
      String(r.label ?? '') !== String(orig.label ?? '') ||
      String(r.start_time ?? '') !== String(orig.start_time ?? '') ||
      String(r.end_time ?? '') !== String(orig.end_time ?? '') ||
      !!r.is_active !== !!orig.is_active ||
      Number(r.sort_order ?? 0) !== Number(orig.sort_order ?? 0)
    )
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
    setSaving(true)
    setMsg(null)
    const payload = {
      label: r.label.trim(),
      start_time: r.start_time,
      end_time: r.end_time,
      is_active: r.is_active,
      sort_order: Number(r.sort_order) || 0,
    }
    let err
    if (r._new) {
      ;({ error: err } = await sb.from('ci_timeslots').insert(payload))
    } else {
      ;({ error: err } = await sb.from('ci_timeslots').update(payload).eq('id', r.id))
    }
    if (err) {
      setMsg({ type: 'err', text: t('config.citimeslots.save_error', { msg: err.message }) })
    } else {
      setMsg({
        type: 'ok',
        text: t('config.citimeslots.saved_toast', {
          label: payload.label,
          start: payload.start_time,
          end: payload.end_time,
        }),
      })
      await load()
    }
    setSaving(false)
  }

  async function deleteRow(id) {
    if (String(id).startsWith('new_')) {
      setRows((prev) => prev.filter((r) => r.id !== id))
      return
    }
    const ok = await confirm({
      title: t('config.citimeslots.delete_confirm_title'),
      message: t('config.citimeslots.delete_confirm_message'),
      danger: true,
      confirmText: t('app.delete'),
    })
    if (!ok) return
    const { error } = await sb.from('ci_timeslots').delete().eq('id', id)
    if (error)
      setMsg({ type: 'err', text: t('config.citimeslots.delete_error', { msg: error.message }) })
    else {
      setMsg({ type: 'ok', text: t('config.citimeslots.delete_success') })
      await load()
    }
  }

  if (loading) return <div className="config-loading">{t('config.citimeslots.loading')}</div>

  return (
    <div className="config-section">
      <h2>{t('config.citimeslots.title')}</h2>
      <p style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 12 }}>
        {t('config.citimeslots.description')}
      </p>

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
            const dirty = isRowDirty(r)
            const cellStyle = dirty ? DIRTY_STYLE : undefined
            return (
              <tr key={r.id} style={dirty ? { background: '#fffbeb' } : undefined}>
                <td style={{ color: 'var(--color-muted)', fontSize: 11 }}>{i + 1}</td>
                <td>
                  <input
                    type="text"
                    value={r.label || ''}
                    onChange={(e) => update(r.id, 'label', e.target.value)}
                    placeholder={t('config.citimeslots.label_placeholder')}
                    style={{ width: 100, ...(cellStyle || {}) }}
                  />
                </td>
                <td>
                  <input
                    type="time"
                    value={r.start_time?.slice(0, 5) || ''}
                    onChange={(e) => update(r.id, 'start_time', e.target.value)}
                    style={{ width: 90, ...(cellStyle || {}) }}
                  />
                </td>
                <td>
                  <input
                    type="time"
                    value={r.end_time?.slice(0, 5) || ''}
                    onChange={(e) => update(r.id, 'end_time', e.target.value)}
                    style={{ width: 90, ...(cellStyle || {}) }}
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
                    style={{ width: 60, ...(cellStyle || {}) }}
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
