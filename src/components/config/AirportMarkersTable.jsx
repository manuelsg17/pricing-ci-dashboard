import { useEffect, useState } from 'react'
import { sb } from '../../lib/supabase'
import { useStaleWhileRevalidate } from '../../hooks/useStaleWhileRevalidate'
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
// Patrón visual: espejo simplificado de BotRulesTable.
//
// Live-sync: useStaleWhileRevalidate da render instantáneo desde cache
// + refetch silencioso cuando OTRA sesión guarda cambios (audit_log →
// 'config:changed' → SWR refetchea). Cuando llega data fresca, sólo
// sincronizamos `rows`/`original` para filas NO dirty: si el usuario
// está editando una fila, su trabajo en progreso no se pisa.
export default function AirportMarkersTable({ country }) {
  const confirm = useConfirm()
  const { t } = useI18n()

  const {
    data: serverRows,
    loading,
    reload,
  } = useStaleWhileRevalidate({
    key: `cfg.airport_markers.${country}`,
    enabled: !!country,
    liveSyncTable: 'airport_markers',
    fetcher: async () => {
      const { data, error } = await sb
        .from('airport_markers')
        .select('*')
        .eq('country', country)
        .order('base_city')
      if (error) throw error
      return data || []
    },
  })

  const [rows, setRows] = useState([])
  const [original, setOriginal] = useState([])
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState(null)

  // Helper de dirty-check contra un snapshot dado. Lo usa tanto el render
  // (vs `original`) como el sync effect (vs el `original` previo al merge).
  function isRowDirtyAgainst(r, snapshot) {
    if (r._new) return true
    const orig = snapshot.find((o) => o.id === r.id)
    if (!orig) return true
    return (
      r.base_city !== orig.base_city ||
      r.city_from !== orig.city_from ||
      r.city_to !== orig.city_to ||
      (r.zone_from_value || '') !== (orig.zone_from_value || '') ||
      (r.zone_to_value || '') !== (orig.zone_to_value || '') ||
      r.active !== orig.active ||
      JSON.stringify(r.keywords || []) !== JSON.stringify(orig.keywords || [])
    )
  }

  // Sincronizar server → state local cuando llega data fresca.
  // Preservamos filas dirty (_new o con cambios sin guardar) para no
  // pisar trabajo del usuario si otra sesión escribe mientras edita.
  // Las filas no-dirty se reemplazan con la versión del server.
  useEffect(() => {
    if (!serverRows) return
    setRows((prev) => {
      const dirtyRows = prev.filter((r) => isRowDirtyAgainst(r, original))
      const dirtyIds = new Set(dirtyRows.map((r) => r.id))
      const cleanFromServer = serverRows.filter((s) => !dirtyIds.has(s.id))
      return [...cleanFromServer, ...dirtyRows]
    })
    setOriginal(serverRows.map((r) => ({ ...r, keywords: [...(r.keywords || [])] })))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverRows])

  // Después de un save/delete local, forzamos refetch para reflejar
  // los cambios en el state (y disparar el sync effect arriba).
  async function load() {
    await reload()
  }

  function updateRow(id, field, val) {
    setMsg(null)
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, [field]: val } : r)))
  }

  function addRow() {
    const tempId = `new_${Date.now()}_${Math.random()}`
    setMsg(null)
    setRows((prev) => [
      ...prev,
      {
        id: tempId,
        country,
        base_city: '',
        city_from: '',
        city_to: '',
        keywords: [],
        zone_from_value: '',
        zone_to_value: '',
        active: true,
        _new: true,
      },
    ])
  }

  const isRowDirty = (r) => isRowDirtyAgainst(r, original)

  // Las keywords se editan como texto coma-separado. Lowercaseamos al
  // guardar para que el matching del script Python sea consistente
  // (comparación substring sobre point_a/point_b también en lowercase).
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
    setSaving(true)
    setMsg(null)
    const payload = {
      country,
      base_city: row.base_city.trim(),
      city_from: row.city_from.trim(),
      city_to: row.city_to.trim(),
      keywords: (row.keywords || []).map((k) => k.toLowerCase().trim()).filter(Boolean),
      // zone_from/to: NULL si vienen vacíos (PG distingue NULL de '')
      zone_from_value: (row.zone_from_value || '').trim() || null,
      zone_to_value: (row.zone_to_value || '').trim() || null,
      active: !!row.active,
    }
    let err
    if (row._new) {
      ;({ error: err } = await sb.from('airport_markers').insert(payload))
    } else {
      ;({ error: err } = await sb.from('airport_markers').update(payload).eq('id', row.id))
    }
    if (err) {
      setMsg({ type: 'err', text: t('config.thresholds.save_error', { msg: err.message }) })
    } else {
      setMsg({
        type: 'ok',
        text: t('config.airports.saved_toast', {
          base: payload.base_city,
          from: payload.city_from,
          to: payload.city_to,
        }),
      })
      // Sacar la fila local recién guardada para que el sync effect
      // tras el reload la reemplace por la versión canónica del server
      // (con id real si era _new, con timestamps actualizados, etc.).
      // Sin esto, el dirty-tracking detectaría la fila local como
      // todavía dirty y la dejaría duplicada / con _new=true.
      setRows((prev) => prev.filter((r) => r.id !== row.id))
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
      title: t('config.airports.delete_confirm_title'),
      message: t('config.airports.delete_confirm_message'),
      danger: true,
      confirmText: t('app.delete'),
    })
    if (!ok) return
    const { error } = await sb.from('airport_markers').delete().eq('id', id)
    if (!error) {
      setMsg({ type: 'ok', text: t('config.airports.delete_success') })
      await load()
    } else {
      setMsg({ type: 'err', text: t('config.citimeslots.delete_error', { msg: error.message }) })
    }
  }

  if (loading) return <div className="config-loading">{t('config.airports.loading')}</div>

  const dirtyCellStyle = {
    background: '#fef3c7',
    borderColor: '#f59e0b',
    fontWeight: 600,
    boxShadow: '0 0 0 2px rgba(245, 158, 11, 0.2)',
  }

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

      <SaveStatusBanner status={msg} onDismiss={() => setMsg(null)} />

      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="border-dashed border-border text-muted hover:border-yango hover:text-yango"
          onClick={addRow}
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
              const dirty = isRowDirty(r)
              return (
                <tr key={r.id}>
                  <td>
                    <input
                      type="text"
                      value={r.base_city || ''}
                      onChange={(e) => updateRow(r.id, 'base_city', e.target.value)}
                      placeholder="Lima"
                      style={dirty ? dirtyCellStyle : undefined}
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      value={r.city_from || ''}
                      onChange={(e) => updateRow(r.id, 'city_from', e.target.value)}
                      placeholder="Lima_Airport_A"
                      style={dirty ? dirtyCellStyle : undefined}
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      value={r.city_to || ''}
                      onChange={(e) => updateRow(r.id, 'city_to', e.target.value)}
                      placeholder="Lima_Airport_B"
                      style={dirty ? dirtyCellStyle : undefined}
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      value={r.zone_from_value || ''}
                      onChange={(e) => updateRow(r.id, 'zone_from_value', e.target.value)}
                      placeholder="Airport_A"
                      style={dirty ? dirtyCellStyle : undefined}
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      value={r.zone_to_value || ''}
                      onChange={(e) => updateRow(r.id, 'zone_to_value', e.target.value)}
                      placeholder="Airport_B"
                      style={dirty ? dirtyCellStyle : undefined}
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
                      style={{
                        width: '100%',
                        minWidth: 240,
                        resize: 'vertical',
                        ...(dirty ? dirtyCellStyle : {}),
                      }}
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
