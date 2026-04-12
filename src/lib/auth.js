import { useEffect, useState } from 'react'
import { sb } from './supabase'

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
    const { data: authData, error: authError } = await sb.auth.signInWithPassword({ email, password })
    if (authError) return authError

    // Verificar si el usuario está inactivo en user_profiles
    if (authData?.user) {
      const { data: profile } = await sb
        .from('user_profiles')
        .select('is_active')
        .eq('id', authData.user.id)
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
