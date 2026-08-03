import { useState, useEffect, useCallback, useMemo } from 'react'
import { sb } from '../lib/supabase'

function daysAgo(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}
function today() {
  return new Date().toISOString().slice(0, 10)
}

// Carga por rango de fecha para el Monitoreo "histórico" (no en vivo): carga
// manual por hub (get_hub_monitoring), sesiones completadas (ci_sessions), y
// combos guardados sin sesión terminada (get_unfinished_ci_sessions, mig 147).
// Extraído de Monitoring.jsx (antes inline) — mismo patrón que
// useRawData.js/useRawDataFilters.js para RawData.jsx.
export function useMonitoringData(country) {
  const [from, setFrom] = useState(() => daysAgo(7))
  const [to, setTo] = useState(() => today())
  const [rows, setRows] = useState([])
  const [sessions, setSessions] = useState([])
  const [unfinished, setUnfinished] = useState([])
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  // Cuántas sesiones hay de verdad en el rango, para poder avisar cuando la
  // lista se corta en 300 (CLAUDE.md §5: nunca truncar en silencio).
  const [sessionsTotal, setSessionsTotal] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setFailed(false)
    try {
      const [
        { data: mon, error: monErr },
        { data: sess, error: sessErr, count: sessCount },
        { data: unf, error: unfErr },
      ] = await Promise.all([
        sb.rpc('get_hub_monitoring', { p_country: country, p_from: from, p_to: to }),
        sb
          .from('ci_sessions')
          // `count: 'exact'` para poder AVISAR cuando la lista se corta.
          // Sin esto, el .limit(300) truncaba en silencio (CLAUDE.md §5) y un
          // hub de bajo volumen cuya única sesión del rango quedó fuera del
          // top-300 aparecía con Frescura "nunca" — un fallo de paginación
          // leído como un diagnóstico de gestión.
          .select('*', { count: 'exact' })
          .eq('country', country)
          .gte('observed_date', from)
          .lte('observed_date', to)
          // Se ordena por `ended_at`, no por `started_at`.
          //
          // Desde que la duración se deriva de `turno_timings`, `started_at`
          // es el PRIMER TRABAJO REAL del bucket, no el arranque de la
          // pestaña — y al reabrir una sesión para corregir una celda esa
          // fila se guarda con el `started_at` del día original. Ordenando
          // por ese campo, una corrección hecha hoy se hundía en la lista
          // como si fuera de ayer, que es lo contrario de "Sesiones
          // recientes". `ended_at` es siempre el instante del cierre, así
          // que sí es monótono. Se deja `started_at` de desempate por si
          // alguna fila vieja no tiene `ended_at` poblado.
          .order('ended_at', { ascending: false, nullsFirst: false })
          .order('started_at', { ascending: false })
          .limit(300),
        sb.rpc('get_unfinished_ci_sessions', { p_country: country, p_from: from, p_to: to }),
      ])
      // `sessErr` NO se destructuraba. Si esta query fallaba —red, timeout,
      // RLS— `sess` venía null, `sessions` quedaba en [] y, como `failed`
      // seguía en false, la página pintaba los paneles como si todo estuviera
      // bien: "Sesiones recientes" vacía y la columna Frescura diciendo "nunca"
      // para todos los hubs. Un fallo de infraestructura indistinguible de
      // "nadie está cerrando sesiones".
      if (monErr || unfErr || sessErr) {
        setFailed(true)
        setRows([])
        setSessions([])
        setSessionsTotal(null)
        setUnfinished([])
        return
      }
      setRows(Array.isArray(mon) ? mon : [])
      setSessions(Array.isArray(sess) ? sess : [])
      setSessionsTotal(typeof sessCount === 'number' ? sessCount : null)
      setUnfinished(Array.isArray(unf) ? unf : [])
    } catch {
      setFailed(true)
      setRows([])
      setSessions([])
      setUnfinished([])
    } finally {
      setLoading(false)
    }
  }, [country, from, to])

  useEffect(() => {
    load()
  }, [load])

  // Resumen por hub: total de filas, ciudades y días distintos en el rango +
  // frescura (fin de la sesión completada más reciente de ese hub).
  const byHub = useMemo(() => {
    const m = {}
    for (const r of rows) {
      const key = r.uploaded_by || '(sin dueño)'
      if (!m[key]) m[key] = { hub: key, n_rows: 0, cities: new Set(), days: new Set() }
      m[key].n_rows += Number(r.n_rows) || 0
      m[key].cities.add(r.city)
      m[key].days.add(r.observed_date)
    }
    const lastEndedByHub = {}
    for (const s of sessions) {
      const key = s.user_email || '(sin dueño)'
      const ended = s.ended_at ? new Date(s.ended_at).getTime() : 0
      if (!lastEndedByHub[key] || ended > lastEndedByHub[key]) lastEndedByHub[key] = ended
    }
    return Object.values(m)
      .map((h) => ({
        hub: h.hub,
        n_rows: h.n_rows,
        n_cities: h.cities.size,
        n_days: h.days.size,
        lastEndedAt: lastEndedByHub[h.hub] || null,
      }))
      .sort((a, b) => b.n_rows - a.n_rows)
  }, [rows, sessions])

  const totalRows = useMemo(() => byHub.reduce((s, h) => s + h.n_rows, 0), [byHub])

  // Detalle (ciudad × fecha × hub) ordenado por fecha desc y filas desc.
  const detail = useMemo(
    () =>
      [...rows].sort(
        (a, b) =>
          String(b.observed_date).localeCompare(String(a.observed_date)) ||
          (Number(b.n_rows) || 0) - (Number(a.n_rows) || 0)
      ),
    [rows]
  )

  return {
    from,
    setFrom,
    to,
    setTo,
    loading,
    failed,
    load,
    byHub,
    totalRows,
    detail,
    sessions,
    // `sessionsTotal` > sessions.length significa que la lista está cortada:
    // el panel tiene que decirlo en vez de mostrar 300 filas como si fueran
    // todas.
    sessionsTotal,
    unfinished,
  }
}
