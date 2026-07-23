import { useState, useEffect, useCallback, useMemo } from 'react'
import { sb } from '../lib/supabase'
import { getISOYearWeek, isoWeekMonday } from '../lib/dateUtils'
import { BRACKETS } from '../lib/constants'

// Matriz semanal de cobertura por (ciudad × tipo de CI) × bracket — RPC
// get_weekly_ci_coverage (mig 154). Deliberadamente SIN ningún cálculo de
// "esperado"/color de cumplimiento: el admin pidió ver los números crudos
// para juzgar el mínimo aceptable él mismo.
const TIPO_ORDER = { Normal: 0, Corp: 1, Airport_A: 2, Airport_B: 3, TukTuk: 4 }
const CITY_ORDER = { Lima: 0, Trujillo: 1, Arequipa: 2 }

export function useWeeklyCoverage(country) {
  const [anchor, setAnchor] = useState(() => new Date())
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)

  const { year, week } = useMemo(() => getISOYearWeek(anchor), [anchor])

  const load = useCallback(async () => {
    if (!country) return
    setLoading(true)
    setFailed(false)
    const { data, error } = await sb.rpc('get_weekly_ci_coverage', {
      p_country: country,
      p_year: year,
      p_week: week,
    })
    if (error) {
      setFailed(true)
      setRows([])
    } else {
      setRows(Array.isArray(data) ? data : [])
    }
    setLoading(false)
  }, [country, year, week])

  useEffect(() => {
    load()
  }, [load])

  // Filas = combos (base_city, tipo) presentes, ordenadas ciudad → tipo,
  // TukTuk siempre al final. Columnas = los 6 brackets canónicos.
  const { rowKeys, cellByRowBracket } = useMemo(() => {
    const cells = {}
    const rowSet = new Map()
    for (const r of rows) {
      const rk = `${r.base_city}|${r.tipo}`
      rowSet.set(rk, { base_city: r.base_city, tipo: r.tipo })
      cells[`${rk}|${r.distance_bracket}`] = Number(r.n_rows) || 0
    }
    const keys = Array.from(rowSet.values()).sort((a, b) => {
      if (a.tipo === 'TukTuk' && b.tipo !== 'TukTuk') return 1
      if (b.tipo === 'TukTuk' && a.tipo !== 'TukTuk') return -1
      const ca = CITY_ORDER[a.base_city] ?? 99
      const cb = CITY_ORDER[b.base_city] ?? 99
      if (ca !== cb) return ca - cb
      if (a.base_city !== b.base_city) return a.base_city.localeCompare(b.base_city)
      return (TIPO_ORDER[a.tipo] ?? 9) - (TIPO_ORDER[b.tipo] ?? 9)
    })
    return { rowKeys: keys, cellByRowBracket: cells }
  }, [rows])

  const goToPrevWeek = useCallback(() => {
    const monday = isoWeekMonday(year, week)
    monday.setDate(monday.getDate() - 7)
    setAnchor(monday)
  }, [year, week])

  const goToNextWeek = useCallback(() => {
    const monday = isoWeekMonday(year, week)
    monday.setDate(monday.getDate() + 7)
    setAnchor(monday)
  }, [year, week])

  const goToCurrentWeek = useCallback(() => setAnchor(new Date()), [])

  return {
    year,
    week,
    rowKeys,
    cellByRowBracket,
    brackets: BRACKETS,
    loading,
    failed,
    goToPrevWeek,
    goToNextWeek,
    goToCurrentWeek,
  }
}
