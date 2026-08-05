import { useState, useEffect, useCallback } from 'react'
import { sb } from '../lib/supabase'

// Alimenta el panel "Tareas en riesgo" de Monitoreo (§7, §13.7).
//
// Todo el cálculo vive en la RPC `get_project_task_alerts` (mig 216), no acá:
// necesita la última actividad de CADA tarea sin ventana de fechas, y
// PostgREST corta en 1000 filas sin avisar — un panel de alertas truncado se
// lee como "no hay alertas", que es el peor resultado posible.
//
// `failed` se distingue de "sin alertas" a propósito. Es el bug real que ya se
// corrigió en PriceComplianceAlerts (revisión adversarial 2026-07-23): un error
// de red hacía que la alerta simplemente no apareciera, indistinguible de
// "todo bien".

const SIN_ALERTAS = []

export function useProjectTaskAlerts(country) {
  const [alerts, setAlerts] = useState(SIN_ALERTAS)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    if (!country) return
    setLoading(true)
    setFailed(false)
    const { data, error } = await sb.rpc('get_project_task_alerts', { p_country: country })
    if (error) {
      // Un rol sin la sección Monitoreo recibe 42501 de la RPC. No es un fallo
      // que haya que gritar: es el gate funcionando. Se muestra el panel vacío.
      setFailed(error.code !== '42501')
      setAlerts(SIN_ALERTAS)
    } else {
      setAlerts(data || SIN_ALERTAS)
    }
    setLoading(false)
  }, [country])

  useEffect(() => {
    load()
  }, [load])

  return { alerts, loading, failed, reload: load }
}
