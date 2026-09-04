import { useState, useEffect, useCallback } from 'react'
import { sb } from '../lib/supabase'
import { getISOYearWeek } from '../lib/dateUtils'

// Representatividad de la data para la SEMANA ISO en curso (RPC
// get_representativity, mig 138). Misma consulta e intervalo que tenía
// RepresentativityCard.jsx (patrón único de datos, 2026-09).
export function useRepresentativity(country) {
  const [rows, setRows] = useState(null)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    try {
      // Semana ISO en curso calculada en la zona local del analista (evita el
      // sesgo UTC del servidor en el borde domingo→lunes; ver mig 138).
      const { year, week } = getISOYearWeek()
      const { data, error } = await sb.rpc('get_representativity', {
        p_country: country,
        p_year: year,
        p_week: week,
      })
      if (error) {
        setFailed(true)
        setRows(null)
        return
      }
      setFailed(false)
      setRows(Array.isArray(data) ? data : [])
    } catch {
      setFailed(true)
      setRows(null)
    }
  }, [country])

  useEffect(() => {
    load()
    const iv = setInterval(load, 5 * 60_000)
    return () => clearInterval(iv)
  }, [load])

  return { rows, failed }
}
