import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { sb } from '../lib/supabase'
import { isNewId, makeTempId, mergeRows, applyEdit, pruneEdits } from '../lib/configTableEdits'

export { isNewId, makeTempId, NEW_ID_PREFIX } from '../lib/configTableEdits'

// ════════════════════════════════════════════════════════════════════════
// useConfigTable — CRUD genérico para los editores de tabla de Configuración
//
// Reemplaza el patrón que vivía clonado en PriceRulesTable, RushHourConfig,
// CITimeslotsConfig, AirportMarkersTable, useCompetitorCommissions y
// useCompetitiveBands (auditoría Config 2026-09-03, deuda P1):
//
//   · carga filas de `table` (filtradas por `country` si la tabla lo tiene)
//   · `edits` por id: lo que el usuario tipeó y todavía no guardó
//   · filas nuevas con id temporal `new_…` hasta que el INSERT devuelve
//   · saveRow (insert/update), deleteRow, addRow, reload
//   · live-sync: escucha `config:changed` (useRealtimeSync) y recarga
//   · errores de carga expuestos (`error`), resultado `{ ok, code, error }`
//
// BUG QUE VINO A MATAR: en los clones, `load()` tras guardar una fila hacía
// `setRows(data)` y pisaba lo que el usuario estaba tipeando en OTRA fila
// (guardar dos filas rápido = la segunda perdía sus cambios). Acá `rows`
// del servidor y `edits` locales son estados separados: una recarga —por
// guardado propio o por live-sync— nunca toca `edits` ni las filas `new_`.
//
// USO:
//   const tbl = useConfigTable({
//     table: 'rush_hour_windows',
//     country,
//     query: (q) => q.in('city', cities).order('city').order('start_time'),
//     newRow: () => ({ city: 'all', start_time: '07:00', end_time: '09:00' }),
//     toPayload: (row) => ({ country, city: row.city, ... }),
//   })
//   tbl.rows            → filas con los edits ya aplicados (para render)
//   tbl.getField(row,f) / tbl.setField(id,f,v) / tbl.isDirty(id) / tbl.isNew(row)
//   const { ok, code, error } = await tbl.saveRow(row)   // error = objeto crudo
// ════════════════════════════════════════════════════════════════════════

export function useConfigTable({
  table,
  country = undefined, // undefined = tabla global (ci_timeslots); null = esperar país
  select = '*',
  query, // (q) => q — filtros/orden extra sobre el builder de Supabase
  newRow, // () => campos por defecto de una fila nueva
  toPayload, // (mergedRow) => payload de INSERT/UPDATE
  liveSync = true,
  enabled = true,
}) {
  const [serverRows, setServerRows] = useState([])
  const [newRows, setNewRows] = useState([])
  const [edits, setEdits] = useState({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  // Refs para que `load` no cambie de identidad por closures nuevas (cada
  // cambio de identidad re-suscribiría el listener de live-sync).
  const queryRef = useRef(query)
  const toPayloadRef = useRef(toPayload)
  const newRowRef = useRef(newRow)
  useEffect(() => {
    queryRef.current = query
    toPayloadRef.current = toPayload
    newRowRef.current = newRow
  })
  const newRowsRef = useRef(newRows)
  useEffect(() => {
    newRowsRef.current = newRows
  }, [newRows])

  // Contador de cargas: una respuesta vieja que llega después de una más
  // nueva (cambio rápido de país) no debe pisar a la nueva.
  const loadSeq = useRef(0)

  const active = enabled && country !== null && !!table

  const load = useCallback(
    async ({ silent = false } = {}) => {
      if (!active) return
      const seq = ++loadSeq.current
      if (!silent) setLoading(true)
      setError(null)
      let q = sb.from(table).select(select)
      if (country !== undefined) q = q.eq('country', country)
      if (queryRef.current) q = queryRef.current(q)
      const { data, error: e } = await q
      if (seq !== loadSeq.current) return
      if (e) {
        setError(e)
        console.warn(`[useConfigTable] ${table}:`, e)
        setLoading(false)
        return false
      } else {
        const fresh = data || []
        setServerRows(fresh)
        setEdits((prev) => pruneEdits(prev, fresh, newRowsRef.current))
      }
      setLoading(false)
    },
    [active, table, select, country]
  )

  // Carga inicial + cambio de país. Al cambiar de país se descartan edits y
  // filas nuevas: una fila `new_` arrastrada al país siguiente se guardaría
  // con el country equivocado.
  useEffect(() => {
    setEdits({})
    setNewRows([])
    if (!active) {
      setServerRows([])
      setLoading(false)
      return
    }
    load()
  }, [active, load])

  // Live-sync (audit_log → useRealtimeSync → 'config:changed'): recarga
  // silenciosa que conserva edits y filas nuevas.
  useEffect(() => {
    if (!liveSync || !active) return
    function onChange(e) {
      if (e?.detail?.table === table) load({ silent: true })
    }
    window.addEventListener('config:changed', onChange)
    return () => window.removeEventListener('config:changed', onChange)
  }, [liveSync, active, table, load])

  const rows = useMemo(() => mergeRows(serverRows, newRows, edits), [serverRows, newRows, edits])

  const baseRow = useCallback(
    (id) => serverRows.find((r) => r.id === id) || newRows.find((r) => r.id === id),
    [serverRows, newRows]
  )

  const getField = useCallback((row, field) => edits[row.id]?.[field] ?? row[field] ?? '', [edits])

  const setField = useCallback(
    (id, field, val) => {
      const base = baseRow(id)
      setEdits((prev) => applyEdit(prev, id, field, val, base?.[field]))
    },
    [baseRow]
  )

  const isNew = useCallback((row) => isNewId(typeof row === 'object' ? row.id : row), [])
  const isDirty = useCallback(
    (id) => isNewId(id) || (!!edits[id] && Object.keys(edits[id]).length > 0),
    [edits]
  )

  const addRow = useCallback((extra) => {
    // `onClick={addRow}` pasa el evento como primer argumento: no es un
    // objeto de campos, se ignora.
    const fields = extra && typeof extra === 'object' && !extra.nativeEvent ? extra : {}
    const defaults = newRowRef.current ? newRowRef.current() : {}
    const row = { id: makeTempId(), ...defaults, ...fields, _new: true }
    setNewRows((prev) => [...prev, row])
    return row
  }, [])

  const discardRow = useCallback((id) => {
    setEdits((prev) => {
      if (!prev[id]) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
    if (isNewId(id)) setNewRows((prev) => prev.filter((r) => r.id !== id))
  }, [])

  // Fila con los edits aplicados (la que hay que validar/guardar).
  const mergedRow = useCallback(
    (row) => ({ ...(baseRow(row.id) || row), ...(edits[row.id] || {}) }),
    [baseRow, edits]
  )

  const saveRow = useCallback(
    async (row) => {
      const merged = mergedRow(row)
      const payload = toPayloadRef.current ? toPayloadRef.current(merged) : merged
      setSaving(true)
      let err
      if (isNewId(merged.id)) {
        ;({ error: err } = await sb.from(table).insert(payload))
      } else {
        ;({ error: err } = await sb.from(table).update(payload).eq('id', merged.id))
      }
      if (err) {
        console.warn(`[useConfigTable] save ${table}:`, err)
        setSaving(false)
        return { ok: false, code: 'db', error: err }
      }
      // El reload va PRIMERO: si el INSERT entró pero el SELECT rebota (red,
      // JWT vencido), descartar la fila local antes la haría desaparecer de la
      // tabla aunque esté guardada. Solo se limpia ESTA fila; los edits de las
      // demás sobreviven al reload.
      const reloaded = await load({ silent: true })
      if (reloaded !== false) discardRow(merged.id)
      setSaving(false)
      return { ok: true, code: null, error: null }
    },
    [table, mergedRow, discardRow, load]
  )

  const deleteRow = useCallback(
    async (id) => {
      if (isNewId(id)) {
        discardRow(id)
        return { ok: true, code: null, error: null, local: true }
      }
      const { error: err } = await sb.from(table).delete().eq('id', id)
      if (err) {
        console.warn(`[useConfigTable] delete ${table}:`, err)
        return { ok: false, code: 'db', error: err }
      }
      discardRow(id)
      await load({ silent: true })
      return { ok: true, code: null, error: null }
    },
    [table, discardRow, load]
  )

  const reload = useCallback(() => load({ silent: true }), [load])

  return {
    rows,
    serverRows,
    edits,
    loading,
    saving,
    error,
    getField,
    setField,
    isDirty,
    isNew,
    mergedRow,
    addRow,
    discardRow,
    saveRow,
    deleteRow,
    reload,
  }
}
