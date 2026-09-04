import { useState } from 'react'
import { dbErrorText } from '../../lib/dbErrorText'
import { useConfigTable } from '../../hooks/useConfigTable'
import SaveStatusBanner from './SaveStatusBanner'
import { useConfirm } from '../ui/ConfirmDialog'
import { useI18n } from '../../context/LanguageContext'
import { Button } from '../ui/shadcn/button'

// CRUD de airport_markers. Cada fila define cómo el bot separa viajes de
// aeropuerto en dos "ciudades" según el aeropuerto esté en el origen
// (city_from) o el destino (city_to). El bot Python lee esta tabla en
// cada corrida (sin cache) y reasigna db_city en función de los keywords
// que aparezcan en point_a/point_b.
//
// Patrón visual: espejo simplificado de BotRulesTable. Carga, edits por
// fila y live-sync (audit_log → 'config:changed') vienen de useConfigTable:
// una recarga disparada por OTRA sesión nunca pisa la fila que el usuario
// está editando.
export default function AirportMarkersTable({ country }) {
  const confirm = useConfirm()
  const { t } = useI18n()

  const tbl = useConfigTable({
    table: 'airport_markers',
    country,
    query: (q) => q.order('base_city'),
    newRow: () => ({
      country,
      base_city: '',
      city_from: '',
      city_to: '',
      keywords: [],
      zone_from_value: '',
      zone_to_value: '',
      active: true,
    }),
    // Las keywords se lowercasean al guardar para que el matching del script
    // Python sea consistente (substring sobre point_a/point_b en lowercase).
    toPayload: (row) => ({
      country,
      base_city: row.base_city.trim(),
      city_from: row.city_from.trim(),
      city_to: row.city_to.trim(),
      keywords: (row.keywords || []).map((k) => k.toLowerCase().trim()).filter(Boolean),
      // zone_from/to: NULL si vienen vacíos (PG distingue NULL de '')
      zone_from_value: (row.zone_from_value || '').trim() || null,
      zone_to_value: (row.zone_to_value || '').trim() || null,
      active: !!row.active,
    }),
  })
  const { rows, loading, saving, error: loadError } = tbl
  const [msg, setMsg] = useState(null)

  function updateRow(id, field, val) {
    setMsg(null)
    tbl.setField(id, field, val)
  }

  // Las keywords se editan como texto coma-separado.
  function keywordsToString(arr) {
    return (arr || []).join(', ')
  }
  function stringToKeywords(s) {
    return (s || '')
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean)
  }

  async function saveRow(row) {
    if (!row.base_city || !row.city_from || !row.city_to) {
      setMsg({ type: 'err', text: t('config.airports.err_required') })
      return
    }
    if (!row.keywords || row.keywords.length === 0) {
      setMsg({ type: 'err', text: t('config.airports.err_keywords') })
      return
    }
    setMsg(null)
    const { ok, error } = await tbl.saveRow(row)
    if (!ok) {
      setMsg({
        type: 'err',
        text: t('config.thresholds.save_error', { msg: dbErrorText(t, error) }),
      })
      return
    }
    setMsg({
      type: 'ok',
      text: t('config.airports.saved_toast', {
        base: row.base_city.trim(),
        from: row.city_from.trim(),
        to: row.city_to.trim(),
      }),
    })
  }

  async function deleteRow(id) {
    if (tbl.isNew(id)) {
      tbl.deleteRow(id)
      return
    }
    const ok = await confirm({
      title: t('config.airports.delete_confirm_title'),
      message: t('config.airports.delete_confirm_message'),
      danger: true,
      confirmText: t('app.delete'),
    })
    if (!ok) return
    const res = await tbl.deleteRow(id)
    if (res.ok) setMsg({ type: 'ok', text: t('config.airports.delete_success') })
    else
      setMsg({
        type: 'err',
        text: t('config.citimeslots.delete_error', { msg: dbErrorText(t, res.error) }),
      })
  }

  if (loading) return <div className="config-loading">{t('config.airports.loading')}</div>

  return (
    <div className="config-section">
      <h2>{t('config.airports.title', { country })}</h2>
      <p style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 12 }}>
        {t('config.airports.desc_1')}
        <br />
        {t('config.airports.desc_2')}
        <br />
        {t('config.airports.desc_3')}
      </p>

      {loadError && (
        <SaveStatusBanner
          status={{ type: 'err', text: t('config.load_error', { msg: dbErrorText(t, loadError) }) }}
          onDismiss={tbl.reload}
        />
      )}
      <SaveStatusBanner status={msg} onDismiss={() => setMsg(null)} />

      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="border-dashed border-border text-muted hover:border-yango hover:text-yango"
          onClick={() => {
            setMsg(null)
            tbl.addRow()
          }}
        >
          + {t('config.airports.add_btn')}
        </Button>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table className="config-table">
          <thead>
            <tr>
              <th scope="col">{t('config.airports.col_base_city')}</th>
              <th scope="col">{t('config.airports.col_city_from')}</th>
              <th scope="col">{t('config.airports.col_city_to')}</th>
              <th scope="col">
                {t('config.airports.col_zone_from')}
                <br />
                <small style={{ fontWeight: 400 }}>{t('config.airports.hint_zone')}</small>
              </th>
              <th scope="col">
                {t('config.airports.col_zone_to')}
                <br />
                <small style={{ fontWeight: 400 }}>{t('config.airports.hint_zone')}</small>
              </th>
              <th scope="col">
                KEYWORDS
                <br />
                <small style={{ fontWeight: 400 }}>{t('config.airports.hint_keywords')}</small>
              </th>
              <th scope="col">{t('config.bands.col_active')}</th>
              <th scope="col"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const dirty = tbl.isDirty(r.id)
              const cls = dirty ? 'config-dirty' : undefined
              return (
                <tr key={r.id}>
                  <td>
                    <input
                      type="text"
                      value={r.base_city || ''}
                      onChange={(e) => updateRow(r.id, 'base_city', e.target.value)}
                      placeholder="Lima"
                      className={cls}
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      value={r.city_from || ''}
                      onChange={(e) => updateRow(r.id, 'city_from', e.target.value)}
                      placeholder="Lima_Airport_A"
                      className={cls}
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      value={r.city_to || ''}
                      onChange={(e) => updateRow(r.id, 'city_to', e.target.value)}
                      placeholder="Lima_Airport_B"
                      className={cls}
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      value={r.zone_from_value || ''}
                      onChange={(e) => updateRow(r.id, 'zone_from_value', e.target.value)}
                      placeholder="Airport_A"
                      className={cls}
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      value={r.zone_to_value || ''}
                      onChange={(e) => updateRow(r.id, 'zone_to_value', e.target.value)}
                      placeholder="Airport_B"
                      className={cls}
                    />
                  </td>
                  <td>
                    <textarea
                      rows={2}
                      value={keywordsToString(r.keywords)}
                      onChange={(e) =>
                        updateRow(r.id, 'keywords', stringToKeywords(e.target.value))
                      }
                      placeholder="jorge chavez, aicc, lim airport"
                      className={cls}
                      style={{ width: '100%', minWidth: 240, resize: 'vertical' }}
                    />
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    <input
                      type="checkbox"
                      checked={!!r.active}
                      onChange={(e) => updateRow(r.id, 'active', e.target.checked)}
                    />
                  </td>
                  <td>
                    <Button
                      type="button"
                      size="sm"
                      className="mr-1"
                      disabled={saving || !dirty}
                      onClick={() => saveRow(r)}
                    >
                      {t('app.save')}
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      disabled={saving}
                      onClick={() => deleteRow(r.id)}
                    >
                      {t('app.delete')}
                    </Button>
                  </td>
                </tr>
              )
            })}
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={8}
                  style={{ textAlign: 'center', color: 'var(--color-muted)', padding: 16 }}
                >
                  {t('config.airports.empty')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
