import { useState, useEffect, useCallback } from 'react'
import { sb } from '../lib/supabase'

// Cuentas (`user_profiles`) de la pantalla de Accesos — patrón único de datos
// (2026-09). Misma consulta, mismo orden y mismos `{ error }` que tenía
// AccessManagement.jsx; la pantalla conserva toasts y confirmaciones.
export function useUserProfiles() {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const { data } = await sb
      .from('user_profiles')
      .select('*, roles(id, name, label)')
      .order('created_at', { ascending: false })
    setUsers(data || [])
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  return { users, loading, load }
}

export async function setUserProfileActive(id, isActive) {
  return sb.from('user_profiles').update({ is_active: isActive }).eq('id', id)
}

export async function setUserProfileRole(userId, roleId) {
  return sb
    .from('user_profiles')
    .update({ role_id: roleId ? parseInt(roleId) : null })
    .eq('id', userId)
}

export async function deleteUserProfile(id) {
  return sb.from('user_profiles').delete().eq('id', id)
}

// Alta de cuenta vía Edge Function `create-user` (service_role queda del lado
// del servidor, nunca en el bundle — CLAUDE.md §3). Devuelve `{ ok, status,
// json }`; un fallo de red lanza, igual que el `fetch` original.
export async function createUserAccount(body) {
  const {
    data: { session: currentSession },
  } = await sb.auth.getSession()
  const token = currentSession?.access_token

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

  const res = await fetch(`${supabaseUrl}/functions/v1/create-user`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: anonKey,
      Authorization: token ? `Bearer ${token}` : `Bearer ${anonKey}`,
    },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, json }
}
