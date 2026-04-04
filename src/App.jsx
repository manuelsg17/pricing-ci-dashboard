import { useState, useEffect } from 'react'
import { useAuth }    from './lib/auth'
import { sb }         from './lib/supabase'
import Topbar         from './components/layout/Topbar'
import LoginScreen    from './components/layout/LoginScreen'
import Dashboard      from './pages/Dashboard'
import Config         from './pages/Config'
import Upload         from './pages/Upload'
import DistanceRefs   from './pages/DistanceRefs'

export default function App() {
  const { session, loading, signIn, signOut } = useAuth()
  const [activeTab, setActiveTab] = useState('dashboard')
  const [dbWeights, setDbWeights] = useState([])

  // Pre-cargar pesos al iniciar sesión (para usePricingData)
  useEffect(() => {
    if (!session) return
    sb.from('bracket_weights').select('*')
      .then(({ data }) => setDbWeights(data || []))
  }, [session])

  if (loading) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100vh', fontSize: 13, color: '#888',
      }}>
        Cargando…
      </div>
    )
  }

  if (!session) {
    return <LoginScreen onLogin={signIn} />
  }

  return (
    <>
      <Topbar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        userEmail={session.user.email}
        onLogout={signOut}
      />

      {activeTab === 'dashboard' && <Dashboard dbWeights={dbWeights} />}
      {activeTab === 'config'    && <Config />}
      {activeTab === 'upload'    && <Upload />}
      {activeTab === 'distances' && <DistanceRefs />}
    </>
  )
}
