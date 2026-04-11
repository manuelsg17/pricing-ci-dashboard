import { useState, useEffect, useCallback } from 'react'
import { sb } from '../lib/supabase'
import { useAuth } from '../lib/auth'

// All known sections in the app
export const ALL_SECTIONS = [
  'dashboard', 'earnings', 'report',
  'dataentry', 'upload', 'rawdata',
  'events', 'distances', 'config', 'access',
]

export const SECTION_LABELS = {
  dashboard: '📊 Dashboard',
  earnings:  '💰 Ganancias',
  report:    '📄 Reporte',
  dataentry: '✏️ Ingresar CI',
  upload:    '📤 Cargar Data',
  rawdata:   '🗃 Data Raw',
  events:    '📌 Eventos',
  distances: '📍 Distancias Ref.',
  config:    '⚙️ Configuración',
  access:    '🔐 Gestión de Accesos',
}

export function useAccessControl() {
  const { session } = useAuth()
  const email = session?.user?.email || ''

  const [profile,  setProfile]  = useState(null)
  const [role,     setRole]     = useState(null)
  const [loading,  setLoading]  = useState(true)

  const loadProfile = useCallback(async () => {
    if (!email) { setLoading(false); return }
    setLoading(true)
    const { data: prof } = await sb
      .from('user_profiles')
      .select('*, roles(*)')
      .eq('email', email)
      .maybeSingle()

    setProfile(prof || null)
    setRole(prof?.roles || null)
    setLoading(false)
  }, [email])

  useEffect(() => { loadProfile() }, [loadProfile])

  function canAccess(section) {
    if (!role) return true          // No profile = unrestricted (backward compat)
    const sections = role.permissions?.sections || []
    if (sections.includes('all')) return true
    return sections.includes(section)
  }

  function canAccessCountry(country) {
    if (!role) return true
    const countries = role.permissions?.countries || []
    if (countries.includes('all')) return true
    return countries.includes(country)
  }

  const isAdmin = role?.name === 'admin'

  return { profile, role, loading, canAccess, canAccessCountry, isAdmin, reload: loadProfile }
}
