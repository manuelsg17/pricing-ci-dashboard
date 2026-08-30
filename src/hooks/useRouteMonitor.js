import { useQuery } from '@tanstack/react-query'
import { sb } from '../lib/supabase'

const EMPTY_ARR = []

// Las dos RPC del monitoreo de rutas (mig 230). Van por RPC y no por query
// directa porque cruzan la misma ruta consigo misma en una ventana de
// tiempo — lógica de negocio no trivial, que además hereda los guards de
// v_effective_price (anti-TukTuk, InDrive Colombia excluido).
//
// `enabled` explícito: sin fechas no se dispara. El rango lo valida también
// el servidor (máx 31 días) — acá solo evitamos el viaje de ida.
export function useRoutePriceGaps({ country, dateFrom, dateTo, minGapPct = 0, enabled = true }) {
  const { data, isFetching, error } = useQuery({
    queryKey: ['routePriceGaps', country, dateFrom, dateTo, minGapPct],
    enabled: Boolean(enabled && country && dateFrom && dateTo),
    queryFn: async () => {
      const { data: rows, error: err } = await sb.rpc('get_route_price_gaps', {
        p_country: country,
        p_date_from: dateFrom,
        p_date_to: dateTo,
        p_min_gap_pct: minGapPct,
      })
      if (err) throw err
      return rows || []
    },
  })
  return { rows: data || EMPTY_ARR, loading: isFetching, error: error?.message || null }
}

export function useCategorySequenceInversions({ country, dateFrom, dateTo, enabled = true }) {
  const { data, isFetching, error } = useQuery({
    queryKey: ['categorySequenceInversions', country, dateFrom, dateTo],
    enabled: Boolean(enabled && country && dateFrom && dateTo),
    queryFn: async () => {
      const { data: rows, error: err } = await sb.rpc('get_category_sequence_inversions', {
        p_country: country,
        p_date_from: dateFrom,
        p_date_to: dateTo,
      })
      if (err) throw err
      return rows || []
    },
  })
  return { rows: data || EMPTY_ARR, loading: isFetching, error: error?.message || null }
}
