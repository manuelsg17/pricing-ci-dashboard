import { useState, useEffect } from 'react'
import { useAuth }           from './lib/auth'
import { sb }                from './lib/supabase'
import { useAccessControl }  from './hooks/useAccessControl'
import { COUNTRIES }         from './lib/constants'
import Topbar                from './components/layout/Topbar'
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
  const { canAccess, canAccessCountry, loading: acLoading } = useAccessControl()
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

  // Países permitidos según rol
  const allowedCountries = COUNTRIES.filter(c => canAccessCountry(c))

  // Si el país seleccionado no está permitido, forzar al primero disponible
  useEffect(() => {
    if (acLoading || allowedCountries.length === 0) return
    if (!allowedCountries.includes(country)) {
      handleCountryChange(allowedCountries[0])
    }
  }, [acLoading])

  // Si el tab activo no es accesible, redirigir a dashboard
  useEffect(() => {
    if (!acLoading && !canAccess(activeTab)) {
      setActiveTab('dashboard')
    }
  }, [acLoading])

  if (loading || acLoading) {
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
        canAccess={canAccess}
        allowedCountries={allowedCountries}
      />

      {activeTab === 'dashboard' && canAccess('dashboard') && <Dashboard dbWeights={dbWeights} country={country} />}
      {activeTab === 'dataentry' && canAccess('dataentry') && <DataEntry country={country} />}
      {activeTab === 'earnings'  && canAccess('earnings')  && <DriverEarnings country={country} />}
      {activeTab === 'report'    && canAccess('report')    && <WeeklyReport country={country} />}
      {activeTab === 'events'    && canAccess('events')    && <MarketEvents country={country} />}
      {activeTab === 'rawdata'   && canAccess('rawdata')   && <RawData />}
      {activeTab === 'botvshubs' && canAccess('botvshubs') && <BotVsHubs />}
      {activeTab === 'config'    && canAccess('config')    && <Config />}
      {activeTab === 'upload'    && canAccess('upload')    && <Upload />}
      {activeTab === 'distances' && canAccess('distances') && <DistanceRefs />}
      {activeTab === 'access'    && canAccess('access')    && <AccessManagement />}
    </>
  )
}
