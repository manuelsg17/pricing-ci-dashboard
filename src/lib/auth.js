import { useEffect, useState } from 'react'
import { sb } from './supabase.js'

export function useAuth() {
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    sb.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })

    const { data: listener } = sb.auth.onAuthStateChange((_event, session) => {
      setSession(session)
    })

    return () => listener.subscription.unsubscribe()
  }, [])

  const signIn = async (email, password) => {
    const { data: authData, error: authError } = await sb.auth.signInWithPassword({
      email,
      password,
    })
    if (authError) return authError

    // Verificar si el usuario está inactivo en user_profiles
    // (la identidad es por email: user_profiles.id NO corresponde a auth.users.id)
    if (authData?.user?.email) {
      const { data: profile } = await sb
        .from('user_profiles')
        .select('is_active')
        .eq('email', authData.user.email)
        .maybeSingle()

      if (profile && profile.is_active === false) {
        await sb.auth.signOut()
        return { message: 'Tu cuenta ha sido desactivada. Contacta al administrador.' }
      }
    }

    return null
  }

  const signOut = async () => {
    await sb.auth.signOut()
  }

  // Cambio de contraseña self-service. Corre con la sesión/JWT del propio
  // usuario (anon key, NO service_role): Supabase solo deja cambiar la
  // contraseña del dueño de la sesión, así que no abre superficie de ataque.
  // Re-autentica primero con la contraseña actual para que una sesión abierta
  // y desatendida no permita cambiarla sin conocer la clave vigente.
  const changePassword = async (currentPassword, newPassword) => {
    const email = session?.user?.email
    if (!email) return { code: 'no_session' }

    // 1) Verificar la contraseña actual (re-autenticación)
    const { error: reauthError } = await sb.auth.signInWithPassword({
      email,
      password: currentPassword,
    })
    if (reauthError) return { code: 'wrong_current' }

    // 2) Actualizar a la nueva
    const { error: updError } = await sb.auth.updateUser({ password: newPassword })
    if (updError) return { code: 'update_failed', message: updError.message }

    return null // éxito (mismo contrato que signIn)
  }

  return { session, loading, signIn, signOut, changePassword }
}
