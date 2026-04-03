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
    const { error } = await sb.auth.signInWithPassword({ email, password })
    return error
  }

  const signOut = async () => {
    await sb.auth.signOut()
  }

  return { session, loading, signIn, signOut }
}
