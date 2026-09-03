import { useState, useEffect, useCallback } from 'react'
import { sb } from '../lib/supabase'
import { useAuth } from '../lib/auth'

// All known sections in the app
export const ALL_SECTIONS = [
  'dashboard',
  'earnings',
  'rentabilidad',
  'report',
  'market',
  'competitividad',
  'dataentry',
  'projects',
  'upload',
  'rawdata',
  'coverage',
  'events',
  'distances',
  'config',
  'access',
]

export const SECTION_LABELS = {
  dashboard: '📊 Dashboard',
  earnings: '💰 Ganancias',
  rentabilidad: '🧮 Rentabilidad',
  report: '📄 Reporte',
  market: '🎯 Mercado',
  competitividad: '📈 Competitividad',
  dataentry: '✏️ Ingresar CI',
  projects: '🗂️ Proyectos',
  upload: '📤 Cargar Data',
  rawdata: '🗃 Data Raw',
  coverage: '🛡️ Cobertura',
  events: '📌 Eventos',
  distances: '📍 Distancias Ref.',
  config: '⚙️ Configuración',
  access: '🔐 Gestión de Accesos',
}

export function useAccessControl() {
  const { session } = useAuth()
  const email = session?.user?.email || ''

  const [profile, setProfile] = useState(null)
  const [role, setRole] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const loadProfile = useCallback(async () => {
    if (!email) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    const { data: prof, error: e } = await sb
      .from('user_profiles')
      .select('*, roles(*)')
      .eq('email', email)
      .maybeSingle()

    if (e) setError(e.message)
    setProfile(prof || null)
    setRole(prof?.roles || null)
    setLoading(false)
  }, [email])

  useEffect(() => {
    loadProfile()
  }, [loadProfile])

  // Stable identity tied to `role` so consumers can safely add these to
  // useEffect deps without causing re-mount loops.
  // Fail-closed: sin rol cargado (perfil inexistente o falló la carga),
  // no hay acceso. Antes era "sin perfil = acceso total" — en la ventana
  // entre mig 60 y 66, ese MISMO patrón (fail-open) coexistiendo con RLS
  // fue justo lo que dejó country_config editable por cualquiera. App.jsx
  // ya bloquea el render de toda página mientras loading/acLoading es
  // true, así que acá "role null" siempre significa "terminó de cargar y
  // no hay rol" — nunca "todavía no sabemos". El estado dedicado que
  // distingue error de red vs. cuenta sin perfil vive en App.jsx (no acá)
  // para no dejar al usuario con una pantalla en blanco sin explicación.
  const canAccess = useCallback(
    (section) => {
      if (!role) return false
      const sections = role.permissions?.sections || []
      if (sections.includes('all')) return true
      return sections.includes(section)
    },
    [role]
  )

  const canAccessCountry = useCallback(
    (country) => {
      if (!role) return false
      const countries = role.permissions?.countries || []
      if (countries.includes('all')) return true
      return countries.includes(country)
    },
    [role]
  )

  const isAdmin = role?.name === 'admin'

  return {
    profile,
    role,
    loading,
    error,
    canAccess,
    canAccessCountry,
    isAdmin,
    reload: loadProfile,
  }
}
