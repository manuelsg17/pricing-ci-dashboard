import { useState, useEffect, useCallback } from 'react'
import { toISODate } from '../lib/dateUtils'
import { sb } from '../lib/supabase'

// Cuánto tarda REALMENTE cada corte (mig 195). Antes vivía inline en
// TurnoTimesPanel.jsx; las consultas son las mismas.
//
//   · Solo entra lo MEDIDO BIEN: la RPC filtra por duration_confiable.
//   · `excluidas` dice cuántas sesiones quedaron fuera del cálculo. `false`
//     ≠ `null`: false = el conteo falló (la tabla igual se muestra), null =
//     todavía no cargó.
export function useTurnoTimes(country, dias) {
  const [filas, setFilas] = useState([])
  const [excluidas, setExcluidas] = useState(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    if (!country) return
    setLoading(true)
    setFailed(false)
    // Sin este reset, cambiar el rango de 30 a 7 días y que la consulta falle
    // dejaba en pantalla el número de excluidas del rango ANTERIOR, atribuido
    // al nuevo. Un dato viejo con etiqueta nueva es peor que ningún dato.
    setExcluidas(null)

    const hasta = new Date()
    const desde = new Date(hasta.getTime() - dias * 86400000)
    const iso = (d) => toISODate(d)

    const [turnos, calidad] = await Promise.all([
      sb.rpc('ci_turno_minutes', { p_country: country, p_from: iso(desde), p_to: iso(hasta) }),
      // Cuántas sesiones quedaron FUERA del cálculo. Sin este número, el
      // panel podría estar promediando 3 muestras de 40 y el usuario no
      // tendría cómo saberlo.
      sb
        .from('ci_sessions')
        .select('duration_confiable', { count: 'exact', head: true })
        .eq('country', country)
        .gte('observed_date', iso(desde))
        .not('duration_confiable', 'is', true),
    ])

    if (turnos.error) {
      setFailed(true)
      setFilas([])
    } else {
      setFilas(turnos.data || [])
      setExcluidas(calidad.error ? false : (calidad.count ?? 0))
    }
    setLoading(false)
  }, [country, dias])

  useEffect(() => {
    load()
  }, [load])

  return { filas, excluidas, loading, failed, load }
}
