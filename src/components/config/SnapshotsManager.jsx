import { useEffect, useState } from 'react'
import { sb } from '../../lib/supabase'
import { useConfirm } from '../ui/ConfirmDialog'
import { useI18n } from '../../context/LanguageContext'
import SaveStatusBanner from './SaveStatusBanner'
import { Button } from '../ui/shadcn/button'

// Lista los snapshots (hard copies) creados por freeze_pricing_wa y
// permite eliminarlos. Cada snapshot agrupa todas las filas que se
// congelaron en una sola corrida (mismo label + timestamp truncado).
//
// Eliminar un snapshot hace que los períodos vuelvan a recalcularse
// en vivo desde v_bracket_weekly_avg (con la config actual). Útil
// cuando el operador se arrepiente de un cambio.
export default function SnapshotsManager({ country }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState(null)
  const [msg, setMsg] = useState(null)
  const confirm = useConfirm()
  const { t } = useI18n()

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [country])

  async function load() {
    setLoading(true)
    setMsg(null)
    const { data, error } = await sb.rpc('list_pricing_wa_snapshots', { p_country: country })
    if (error) {
      setMsg({ type: 'err', text: t('config.snapshots.load_error', { msg: error.message }) })
      setRows([])
    } else {
      setRows(data || [])
    }
    setLoading(false)
  }

  async function handleDelete(snap) {
    const ok = await confirm({
      title: t('config.snapshots.delete_confirm_title'),
      message: t('config.snapshots.delete_confirm_message', {
        label: snap.frozen_label,
        rows: snap.rows_count.toLocaleString(),
        weeks: snap.weeks_count,
        cities: snap.cities_count,
      }),
      confirmText: t('config.snapshots.delete_confirm_btn'),
      cancelText: t('app.cancel'),
      danger: true,
    })
    if (!ok) return

    setDeleting(snap.frozen_label)
    setMsg(null)
    const { data, error } = await sb.rpc('unfreeze_pricing_wa', {
      p_country: country,
      p_label: snap.frozen_label,
    })
    if (error) {
      setMsg({ type: 'err', text: t('app.error_prefix') + error.message })
    } else {
      setMsg({
        type: 'ok',
        text: t('config.snapshots.delete_success', { n: data?.toLocaleString() ?? '?' }),
      })
      await load()
    }
    setDeleting(null)
  }

  if (loading) return <div className="config-loading">{t('config.snapshots.loading')}</div>

  return (
    <div className="config-section">
      <h2>{t('config.snapshots.title', { country })}</h2>
      <p style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 12 }}>
        {t('config.snapshots.description')}
      </p>

      <SaveStatusBanner status={msg} onDismiss={() => setMsg(null)} />

      {rows.length === 0 ? (
        <div
          style={{
            padding: 20,
            textAlign: 'center',
            color: '#888',
            background: '#f8fafc',
            borderRadius: 8,
            border: '1px dashed #cbd5e1',
          }}
        >
          {t('config.snapshots.empty', { country })}
        </div>
      ) : (
        <table className="config-table" style={{ marginTop: 8 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>{t('config.snapshots.col_label')}</th>
              <th style={{ textAlign: 'left' }}>{t('config.snapshots.col_created')}</th>
              <th style={{ textAlign: 'right' }}>{t('dataentry.rows')}</th>
              <th style={{ textAlign: 'right' }}>{t('config.snapshots.col_weeks')}</th>
              <th style={{ textAlign: 'right' }}>{t('config.snapshots.col_cities')}</th>
              <th scope="col"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td style={{ fontSize: 11, maxWidth: 360, wordBreak: 'break-all' }}>
                  {r.frozen_label}
                </td>
                <td style={{ fontSize: 11, color: '#475569' }}>
                  {new Date(r.frozen_at_second).toLocaleString()}
                </td>
                <td style={{ textAlign: 'right', fontWeight: 600 }}>
                  {Number(r.rows_count).toLocaleString()}
                </td>
                <td style={{ textAlign: 'right' }}>{Number(r.weeks_count).toLocaleString()}</td>
                <td style={{ textAlign: 'right' }}>{Number(r.cities_count).toLocaleString()}</td>
                <td>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="border-red-300 text-red-600 hover:bg-red-100"
                    onClick={() => handleDelete(r)}
                    disabled={deleting === r.frozen_label}
                    title={t('config.snapshots.delete_btn_title')}
                  >
                    {deleting === r.frozen_label
                      ? t('config.snapshots.deleting')
                      : `✕ ${t('app.delete')}`}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
