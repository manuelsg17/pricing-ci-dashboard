import { useQuery, useQueryClient } from '@tanstack/react-query'
import { sb } from '../lib/supabase'

export const ROLES_QUERY_KEY = ['roles']

async function fetchRoles() {
  const { data, error } = await sb.from('roles').select('*').order('id')
  if (error) throw error
  return data || []
}

// React Query (Fase 2, 2026-07-26): AccessManagement.jsx pedía `roles` DOS
// veces — una vez arriba (para el dropdown de UsersTab) y otra vez adentro
// de RolesTab (para su propia lista editable) — con dos `useState` sin
// relación entre sí. Con una sola queryKey compartida, editar permisos en
// RolesTab invalida la cache y el dropdown de UsersTab también se
// refresca solo, sin remount — antes quedaba desactualizado hasta recargar
// la página.
export function useRoles() {
  return useQuery({ queryKey: ROLES_QUERY_KEY, queryFn: fetchRoles })
}

export function useInvalidateRoles() {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: ROLES_QUERY_KEY })
}
