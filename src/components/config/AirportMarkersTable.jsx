import { useEffect, useState } from 'react'
import { sb } from '../../lib/supabase'
import SaveStatusBanner from './SaveStatusBanner'
import { useConfirm } from '../ui/ConfirmDialog'

// CRUD de airport_markers. Cada fila define cómo el bot separa viajes de
// aeropuerto en dos "ciudades" según el aeropuerto esté en el origen
// (city_from) o el destino (city_to). El bot Python lee esta tabla en
// cada corrida (sin cache) y reasigna db_city en función de los keywords
// que aparezcan en point_a/point_b.
//
// Patrón visual: espejo simplificado de BotRulesTable.
export default function AirportMarkersTable({ country }) {
  const confirm = useConfirm()

  const [rows,     setRows]     = useState([])
  const [original, setOriginal] = useState([])
  const [loading,  setLoading]  = useState(true)
  const [saving,   setSaving]   = useState(false)
  const [msg,      setMsg]      = useState(null)

  useEffect(() => { load() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [country])

  async function load() {
    setLoading(true)
    const { data, error } = await sb.from('airport_markers')
      .select('*')
      .eq('country', country)
      .order('base_city')
    if (error) {
      setMsg({ type: 'err', text: 'Error al cargar markers: ' + error.message })
      setRows([]); setOriginal([])
    } else {
      setRows(data || [])
      setOriginal((data || []).map(r => ({ ...r, keywords: [...(r.keywords || [])] })))
    }
    setLoading(false)
  }

  function updateRow(id, field, val) {
    setMsg(null)
    setRows(prev => prev.map(r => r.id === id ? { ...r, [field]: val } : r))
  }

  function addRow() {
    const tempId = `new_${Date.now()}_${Math.random()}`
    setMsg(null)
    setRows(prev => [...prev, {
      id:               tempId,
      country,
      base_city:        '',
      city_from:        '',
      city_to:          '',
      keywords:         [],
      zone_from_value:  '',
      zone_to_value:    '',
      active:           true,
      _new:             true,
    }])
  }

  const isRowDirty = (r) => {
    if (r._new) return true
    const orig = original.find(o => o.id === r.id)
    if (!orig) return true
    return (
      r.base_city       !== orig.base_city       ||
      r.city_from       !== orig.city_from       ||
      r.city_to         !== orig.city_to         ||
      (r.zone_from_value || '') !== (orig.zone_from_value || '') ||
      (r.zone_to_value   || '') !== (orig.zone_to_value   || '') ||
      r.active          !== orig.active          ||
      JSON.stringify(r.keywords || []) !== JSON.stringify(orig.keywords || [])
    )
  }

  // Las keywords se editan como texto coma-separado. Lowercaseamos al
  // guardar para que el matching del script Python sea consistente
  // (comparación substring sobre point_a/point_b también en lowercase).
  function keywordsToString(arr) {
    return (arr || []).join(', ')
  }
  function stringToKeywords(s) {
    return (s || '')
      .split(',')
      .map(k => k.trim())
      .filter(Boolean)
  }

  async function saveRow(row) {
    if (!row.base_city || !row.city_from || !row.city_to) {
      setMsg({ type: 'err', text: 'base_city, city_from y city_to son obligatorios' })
      return
    }
    if (!row.keywords || row.keywords.length === 0) {
      setMsg({ type: 'err', text: 'Necesitás al menos un keyword para detectar el aeropuerto' })
      return
    }
    setSaving(true)
    setMsg(null)
    const payload = {
      country,
      base_city:        row.base_city.trim(),
      city_from:        row.city_from.trim(),
      city_to:          row.city_to.trim(),
      keywords:         (row.keywords || []).map(k => k.toLowerCase().trim()).filter(Boolean),
      // zone_from/to: NULL si vienen vacíos (PG distingue NULL de '')
      zone_from_value:  (row.zone_from_value || '').trim() || null,
      zone_to_value:    (row.zone_to_value   || '').trim() || null,
      active:           !!row.active,
    }
    let err
    if (row._new) {
      ;({ error: err } = await sb.from('airport_markers').insert(payload))
    } else {
      ;({ error: err } = await sb.from('airport_markers')
        .update(payload)
        .eq('id', row.id))
    }
    if (err) {
      setMsg({ type: 'err', text: 'Error al guardar: ' + err.message })
    } else {
      setMsg({ type: 'ok', text: `Marker guardado: ${payload.base_city} → ${payload.city_from} / ${payload.city_to}` })
      await load()
    }
    setSaving(false)
  }

  async function deleteRow(id) {
    if (String(id).startsWith('new_')) {
      setRows(prev => prev.filter(r => r.id !== id))
      return
    }
    const ok = await confirm({
      title: 'Eliminar marker',
      message: 'Si lo eliminás, el bot dejará de separar viajes de aeropuerto para esta ciudad. Las observaciones nuevas caerán en la ciudad base.',
      danger: true,
      confirmText: 'Eliminar',
    })
    if (!ok) return
    const { error } = await sb.from('airport_markers').delete().eq('id', id)
    if (!error) {
      setMsg({ type: 'ok', text: 'Marker eliminado.' })
      await load()
    } else {
      setMsg({ type: 'err', text: 'Error al eliminar: ' + error.message })
    }
  }

  if (loading) return <div className="config-loading">Cargando markers de aeropuerto…</div>

  const dirtyCellStyle = {
    background:  '#fef3c7',
    borderColor: '#f59e0b',
    fontWeight:  600,
    boxShadow:   '0 0 0 2px rgba(245, 158, 11, 0.2)',
  }

  return (
    <div className="config-section">
      <h2>Aeropuertos — {country}</h2>
      <p style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 12 }}>
        Cada marker mapea <code>(country, base_city)</code> a dos ciudades virtuales:
        <code>city_from</code> (viajes <strong>desde</strong> el aeropuerto) y
        <code>city_to</code> (viajes <strong>hacia</strong> el aeropuerto).
        <br />
        El bot detecta en este orden: <strong>(1)</strong> si <code>raw.zone</code> matchea
        <code>zone_from_value</code> o <code>zone_to_value</code> (source-of-truth si tu bot etiqueta);
        <strong>(2)</strong> fallback a substring match de <code>keywords</code> en
        <code>point_a</code>/<code>point_b</code>.
        <br />
        Zone match es exacto y case-sensitive; keywords es substring case-insensitive (no necesitan ser exactos).
      </p>

      <SaveStatusBanner status={msg} onDismiss={() => setMsg(null)} />

      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        <button className="btn-add-row" onClick={addRow}>+ Nuevo aeropuerto</button>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table className="config-table">
          <thead>
            <tr>
              <th>BASE CITY</th>
              <th>CITY FROM</th>
              <th>CITY TO</th>
              <th>ZONE FROM<br /><small style={{ fontWeight: 400 }}>(raw.zone exacto)</small></th>
              <th>ZONE TO<br /><small style={{ fontWeight: 400 }}>(raw.zone exacto)</small></th>
              <th>KEYWORDS<br /><small style={{ fontWeight: 400 }}>(coma-separado, fallback)</small></th>
              <th>ACTIVA</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const dirty = isRowDirty(r)
              return (
                <tr key={r.id}>
                  <td>
                    <input
                      type="text"
                      value={r.base_city || ''}
                      onChange={e => updateRow(r.id, 'base_city', e.target.value)}
                      placeholder="Lima"
                      style={dirty ? dirtyCellStyle : undefined}
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      value={r.city_from || ''}
                      onChange={e => updateRow(r.id, 'city_from', e.target.value)}
                      placeholder="Lima_AeroFrom"
                      style={dirty ? dirtyCellStyle : undefined}
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      value={r.city_to || ''}
                      onChange={e => updateRow(r.id, 'city_to', e.target.value)}
                      placeholder="Lima_AeroTo"
                      style={dirty ? dirtyCellStyle : undefined}
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      value={r.zone_from_value || ''}
                      onChange={e => updateRow(r.id, 'zone_from_value', e.target.value)}
                      placeholder="AeroportFrom"
                      style={dirty ? dirtyCellStyle : undefined}
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      value={r.zone_to_value || ''}
                      onChange={e => updateRow(r.id, 'zone_to_value', e.target.value)}
                      placeholder="AeroportTo"
                      style={dirty ? dirtyCellStyle : undefined}
                    />
                  </td>
                  <td>
                    <textarea
                      rows={2}
                      value={keywordsToString(r.keywords)}
                      onChange={e => updateRow(r.id, 'keywords', stringToKeywords(e.target.value))}
                      placeholder="jorge chavez, aicc, lim airport"
                      style={{
                        width:    '100%',
                        minWidth: 240,
                        resize:   'vertical',
                        ...(dirty ? dirtyCellStyle : {}),
                      }}
                    />
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    <input
                      type="checkbox"
                      checked={!!r.active}
                      onChange={e => updateRow(r.id, 'active', e.target.checked)}
                    />
                  </td>
                  <td>
                    <button
                      className="btn-save"
                      disabled={saving || !dirty}
                      onClick={() => saveRow(r)}
                      style={{ marginRight: 4 }}
                    >
                      Guardar
                    </button>
                    <button
                      className="btn-delete"
                      disabled={saving}
                      onClick={() => deleteRow(r.id)}
                    >
                      Eliminar
                    </button>
                  </td>
                </tr>
              )
            })}
            {rows.length === 0 && (
              <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--color-muted)', padding: 16 }}>
                No hay aeropuertos configurados para este país. Agregá uno con el botón de arriba.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
