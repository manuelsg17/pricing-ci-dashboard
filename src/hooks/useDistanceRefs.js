import { useState, useCallback, useMemo, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { sb } from '../lib/supabase'
import { BRACKETS } from '../lib/constants'

// Orden fijo very_short → very_long para mostrar/editar (Supabase ordena
// `bracket` alfabéticamente, que no coincide con el orden real de brackets).
// Brackets desconocidos/vacíos quedan al final en vez de romper el sort.
// point_a como desempate: DataEntry.jsx ordenaba así server-side antes de
// esta migración a caché compartida — se preserva para no cambiar el orden
// visual de las rutas en Ingresar CI.
function sortByBracketOrder(rows) {
  const rank = (b) => {
    const i = BRACKETS.indexOf(b)
    return i === -1 ? BRACKETS.length : i
  }
  return [...rows].sort((a, b) => {
    if (a.category !== b.category) return a.category < b.category ? -1 : 1
    const rd = rank(a.bracket) - rank(b.bracket)
    if (rd !== 0) return rd
    return (a.point_a || '').localeCompare(b.point_a || '')
  })
}

export function distanceRefsQueryKey(country, dbCity) {
  return ['distanceRefs', country, dbCity]
}

// Fetch compartido: MISMA queryFn para todo consumidor de esta queryKey
// (useDistanceRefs y DataEntry.jsx) — con la misma key pero queryFn
// distintas, React Query solo ejecuta la del primero en montar, así que
// una segunda implementación "parecida" en otro archivo sería un bug
// latente (el otro consumidor heredaría datos con shape/orden distintos
// sin darse cuenta). Se exporta para que DataEntry.jsx la reuse tal cual.
export async function fetchDistanceRefs(country, dbCity) {
  const { data, error: err } = await sb
    .from('distance_references')
    .select('*')
    .eq('country', country)
    .eq('city', dbCity)
  if (err) throw err
  return sortByBracketOrder(data || [])
}

// React Query (Fase 2, 2026-07-26): antes esta lectura no tenía caché
// (refetch en cada cambio de dbCity/country) y DataEntry.jsx tenía su
// PROPIO cache manual (refsCacheRef) para la misma tabla — dos fuentes de
// verdad para el mismo dato. Ahora ambos comparten la misma queryKey, así
// que cargar Distancias de Referencia y luego entrar a Ingresar CI (o
// viceversa) para la misma ciudad no vuelve a pegarle a la BD.
export function useDistanceRefs(dbCity, country) {
  const queryClient = useQueryClient()
  const queryKey = distanceRefsQueryKey(country, dbCity)

  const {
    data: savedRefs = [],
    isLoading,
    error: queryError,
  } = useQuery({
    queryKey,
    enabled: Boolean(dbCity && country),
    queryFn: () => fetchDistanceRefs(country, dbCity),
  })

  // Filas nuevas sin guardar (_isNew) — no viven en la caché de React Query
  // porque no existen en el servidor todavía. Se limpian al cambiar de
  // ciudad/país, igual que antes (el fetch viejo pisaba `refs` entero).
  const [draftRows, setDraftRows] = useState([])
  useEffect(() => {
    setDraftRows([])
  }, [dbCity, country])

  const refs = useMemo(() => [...savedRefs, ...draftRows], [savedRefs, draftRows])
  const [error, setError] = useState(null)

  const saveMutation = useMutation({
    mutationFn: async (row) => {
      const { error: err } = await sb
        .from('distance_references')
        .upsert(
          { ...row, city: dbCity, country, updated_at: new Date().toISOString() },
          { onConflict: 'id' }
        )
      if (err) throw err
    },
    onSuccess: (_data, row) => {
      // La fila ya persistió — sale de draftRows (si era nueva) y vuelve a
      // aparecer vía la query invalidada (savedRefs).
      setDraftRows((prev) => prev.filter((r) => r.id !== row.id))
      queryClient.invalidateQueries({ queryKey })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: async (id) => {
      const { error: err } = await sb.from('distance_references').delete().eq('id', id)
      if (err) throw err
    },
    onSuccess: (_data, id) => {
      setDraftRows((prev) => prev.filter((r) => r.id !== id))
      queryClient.invalidateQueries({ queryKey })
    },
  })

  const saveRef = useCallback(
    async (row) => {
      setError(null)
      try {
        await saveMutation.mutateAsync(row)
        return true
      } catch (e) {
        setError(e.message)
        return false
      }
    },
    [saveMutation]
  )

  const deleteRef = useCallback(
    async (id) => {
      setError(null)
      try {
        await deleteMutation.mutateAsync(id)
        return true
      } catch (e) {
        setError(e.message)
        return false
      }
    },
    [deleteMutation]
  )

  const addRow = useCallback(() => {
    const tempId = `new_${Date.now()}`
    setDraftRows((prev) => [
      ...prev,
      {
        id: tempId,
        city: dbCity,
        country,
        category: '',
        bracket: '',
        point_a: '',
        coordinate_a: '',
        point_b: '',
        coordinate_b: '',
        waze_distance: '',
        zone: '',
        _isNew: true,
      },
    ])
  }, [dbCity, country])

  const addCategoryRows = useCallback(
    (category, brackets) => {
      const newRows = brackets.map((b, i) => ({
        id: `new_${Date.now()}_${i}_${Math.random().toString(36).slice(2)}`,
        city: dbCity,
        country,
        category,
        bracket: b,
        point_a: '',
        coordinate_a: '',
        point_b: '',
        coordinate_b: '',
        waze_distance: '',
        zone: '',
        _isNew: true,
      }))
      setDraftRows((prev) => [...prev, ...newRows])
    },
    [dbCity, country]
  )

  const reload = useCallback(
    () => queryClient.invalidateQueries({ queryKey }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryClient, country, dbCity]
  )

  return {
    refs,
    loading: isLoading,
    saving: saveMutation.isPending || deleteMutation.isPending,
    error: error || queryError?.message || null,
    saveRef,
    deleteRef,
    addRow,
    addCategoryRows,
    reload,
  }
}
