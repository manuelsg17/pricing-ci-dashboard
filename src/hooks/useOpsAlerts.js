import { useCallback, useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { sb } from '../lib/supabase'

export const OPS_ALERTS_QUERY_KEY = ['opsAlerts', 'open']

// Identidad estable: sin esto, `data || []` crea un array NUEVO en cada
// render e invalida en cascada los useMemo de los consumidores
// (CLAUDE.md §5 — arrays como dependencia de efecto).
const EMPTY_ARR = []

// Refresco cada 2 min. La tabla es un espejo que se puebla desde GitHub
// Actions (ver mig 227), así que no tiene sentido pollear más seguido que
// la cadencia real del sync — pero sí lo suficiente para que una alerta
// nueva aparezca sin obligar al usuario a recargar la página.
const REFETCH_MS = 120000

export async function fetchOpenOpsAlerts() {
  const { data, error } = await sb
    .from('ops_alerts')
    .select('id, created_at_utc, source, severity, message, resolved')
    .eq('resolved', false)
    .order('created_at_utc', { ascending: false })
  if (error) throw error
  return data || []
}

export function useOpsAlerts() {
  const queryClient = useQueryClient()
  const [actionError, setActionError] = useState(null)

  const {
    data,
    isLoading,
    error: queryError,
  } = useQuery({
    queryKey: OPS_ALERTS_QUERY_KEY,
    queryFn: fetchOpenOpsAlerts,
    refetchInterval: REFETCH_MS,
  })

  const alerts = data || EMPTY_ARR

  // El contador del encabezado cuenta SOLO 'problem'. Un panel con 12
  // warnings y 0 problems no debe pintar un número rojo alarmante.
  const problemCount = useMemo(
    () => alerts.filter((a) => a.severity === 'problem').length,
    [alerts]
  )

  const resolveMutation = useMutation({
    // Vía RPC y no UPDATE directo: una política RLS no puede restringir por
    // columna, así que un grant de UPDATE dejaría reescribir message o
    // severity desde la consola del navegador (CLAUDE.md §3, mig 227).
    mutationFn: async (id) => {
      const { error } = await sb.rpc('resolve_ops_alert', { p_id: id })
      if (error) throw error
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: OPS_ALERTS_QUERY_KEY })
    },
  })

  const resolveAlert = useCallback(
    async (id) => {
      setActionError(null)
      try {
        await resolveMutation.mutateAsync(id)
        return true
      } catch (e) {
        setActionError(e.message)
        return false
      }
    },
    [resolveMutation]
  )

  return {
    alerts,
    problemCount,
    loading: isLoading,
    error: queryError?.message || actionError,
    resolveAlert,
    resolvingId: resolveMutation.isPending ? resolveMutation.variables : null,
  }
}
