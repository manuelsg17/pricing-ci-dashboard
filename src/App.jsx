import { useState, useEffect } from 'react'
import { useAuth }     from './lib/auth'
import { sb }          from './lib/supabase'
import Topbar          from './components/layout/Topbar'
import LoginScreen     from './components/layout/LoginScreen'
import Dashboard       from './pages/Dashboard'
import Config          from './pages/Config'
import Upload          from './pages/Upload'
import DistanceRefs    from './pages/DistanceRefs'
import RawData         from './pages/RawData'
import DataEntry       from './pages/DataEntry'
import DriverEarnings  from './pages/DriverEarnings'
import WeeklyReport    from './pages/WeeklyReport'
import MarketEvents      from './pages/MarketEvents'
import AccessManagement  from './pages/AccessManagement'
import BotVsHubs        from './pages/BotVsHubs'

export default function App() {
  const { session, loading, signIn, signOut } = useAuth()
  const [activeTab, setActiveTab] = useState('dashboard')
  const [dbWeights, setDbWeights] = useState([])
  const [country,   setCountry]   = useState(() => localStorage.getItem('country') || 'Peru')

  function handleCountryChange(c) {
    setCountry(c)
    localStorage.setItem('country', c)
  }

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
        country={country}
        onCountryChange={handleCountryChange}
      />

      {activeTab === 'dashboard' && <Dashboard dbWeights={dbWeights} country={country} />}
      {activeTab === 'dataentry' && <DataEntry country={country} />}
      {activeTab === 'earnings'  && <DriverEarnings country={country} />}
      {activeTab === 'report'    && <WeeklyReport country={country} />}
      {activeTab === 'events'    && <MarketEvents country={country} />}
      {activeTab === 'rawdata'   && <RawData />}
      {activeTab === 'botvshubs' && <BotVsHubs />}
      {activeTab === 'config'    && <Config />}
      {activeTab === 'upload'    && <Upload />}
      {activeTab === 'distances' && <DistanceRefs />}
      {activeTab === 'access'    && <AccessManagement />}
    </>
  )
}
