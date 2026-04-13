import { useState, useEffect, Suspense, lazy } from 'react'
import { useAuth }           from './lib/auth'
import { sb }                from './lib/supabase'
import { useAccessControl }  from './hooks/useAccessControl'
import { COUNTRIES }         from './lib/constants'
import Topbar                from './components/layout/Topbar'
import LoginScreen     from './components/layout/LoginScreen'
const Dashboard = lazy(() => import('./pages/Dashboard'))
const Config = lazy(() => import('./pages/Config'))
const Upload = lazy(() => import('./pages/Upload'))
const DistanceRefs = lazy(() => import('./pages/DistanceRefs'))
const RawData = lazy(() => import('./pages/RawData'))
const DataEntry = lazy(() => import('./pages/DataEntry'))
const DriverEarnings = lazy(() => import('./pages/DriverEarnings'))
const WeeklyReport = lazy(() => import('./pages/WeeklyReport'))
const MarketEvents = lazy(() => import('./pages/MarketEvents'))
const AccessManagement = lazy(() => import('./pages/AccessManagement'))
const BotVsHubs = lazy(() => import('./pages/BotVsHubs'))

export default function App() {
  const { session, loading, signIn, signOut } = useAuth()
  const { profile, canAccess, canAccessCountry, loading: acLoading } = useAccessControl()
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

  if (profile && profile.is_active === false) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        height: '100vh', gap: 16, textAlign: 'center', padding: 20
      }}>
        <h2 style={{ color: '#d32f2f' }}>Acceso Suspendido</h2>
        <p style={{ color: '#555' }}>Tu cuenta ha sido desactivada. Por favor, contacta al administrador del sistema.</p>
        <button onClick={signOut} style={{ padding: '8px 16px', background: '#d32f2f', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
          Cerrar sesión
        </button>
      </div>
    )
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

      <Suspense fallback={
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', height: 'calc(100vh - 50px)', fontSize: 13, color: '#888'
        }}>
          Cargando vista…
        </div>
      }>
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
      </Suspense>
    </>
  )
}
