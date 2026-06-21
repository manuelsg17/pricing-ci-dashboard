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

  return { session, loading, signIn, signOut }
}
