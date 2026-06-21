import { useState, useEffect, Suspense, lazy } from 'react'
import { useAuth } from './lib/auth'
import { useAccessControl } from './hooks/useAccessControl'
import { useCountry } from './context/CountryContext'
import { FilterProvider } from './context/FilterContext'
import Topbar from './components/layout/Topbar'
import LoginScreen from './components/layout/LoginScreen'
import ErrorBoundary from './components/ui/ErrorBoundary'
import { SkeletonDashboard } from './components/ui/Skeleton'
const Dashboard = lazy(() => import('./pages/Dashboard'))
const Config = lazy(() => import('./pages/Config'))
const Upload = lazy(() => import('./pages/Upload'))
const DistanceRefs = lazy(() => import('./pages/DistanceRefs'))
const RawData = lazy(() => import('./pages/RawData'))
const DataEntry = lazy(() => import('./pages/DataEntry'))
const DriverEarnings = lazy(() => import('./pages/DriverEarnings'))
const Rentabilidad = lazy(() => import('./pages/Rentabilidad'))
const WeeklyReport = lazy(() => import('./pages/WeeklyReport'))
const MarketEvents = lazy(() => import('./pages/MarketEvents'))
const AccessManagement = lazy(() => import('./pages/AccessManagement'))
const BotVsHubs = lazy(() => import('./pages/BotVsHubs'))
const Market = lazy(() => import('./pages/Market'))
const Coverage = lazy(() => import('./pages/Coverage'))

export default function App() {
  const { loading, signIn, signOut, changePassword, session } = useAuth()
  const { country, setCountry, availableCountries } = useCountry()
  const { profile, canAccess, canAccessCountry, loading: acLoading } = useAccessControl()
  const [activeTab, setActiveTab] = useState('dashboard')

  // Sprint 2.4: dbWeights/dbSemaforo ya NO viven acá — ConfigProvider
  // los maneja globalmente (src/context/ConfigProvider.jsx). Dashboard,
  // Market, Coverage y cualquier otra page los leen vía useConfigContext().
  // Esto elimina prop drilling y le da acceso al cache a TODAS las pages
  // (antes solo Dashboard/Market/Coverage los recibían como props).

  // Países permitidos según rol — usa availableCountries del context
  // (incluye los que viven solo en DB, no solo los hardcoded de constants.js)
  const allowedCountries = availableCountries.filter((c) => canAccessCountry(c))

  // Si el país seleccionado no está permitido, forzar al primero disponible
  useEffect(() => {
    if (acLoading || allowedCountries.length === 0) return
    if (!allowedCountries.includes(country)) {
      setCountry(allowedCountries[0])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- corre solo al cargar auth; incluir country/setCountry pelearía con la selección del usuario
  }, [acLoading])

  // Si el tab activo no es accesible, redirigir a dashboard
  // canAccess is stable (useCallback) so we can safely depend on it.
  useEffect(() => {
    if (!acLoading && !canAccess(activeTab)) {
      setActiveTab('dashboard')
    }
  }, [acLoading, canAccess, activeTab])

  // Listener para navegación entre pestañas desde componentes hijos
  // (ej: el digest compact en Dashboard linkea a Mercado).
  // canAccess is stable (useCallback in useAccessControl) so this effect
  // only re-mounts when `role` actually changes, not on every render.
  useEffect(() => {
    let scrollTimer = null
    function handler(e) {
      const tab = e.detail?.tab
      if (tab && canAccess(tab)) {
        setActiveTab(tab)
        const section = e.detail?.section
        if (section) {
          // scroll a la sección después que el tab montó
          scrollTimer = setTimeout(() => {
            document.getElementById(section)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }, 200)
        }
      }
    }
    window.addEventListener('navigate-to-tab', handler)
    return () => {
      window.removeEventListener('navigate-to-tab', handler)
      if (scrollTimer) clearTimeout(scrollTimer)
    }
  }, [canAccess])

  if (loading || acLoading) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          fontSize: 13,
          color: '#888',
        }}
      >
        Cargando…
      </div>
    )
  }

  if (!session) {
    return <LoginScreen onLogin={signIn} />
  }

  if (profile && profile.is_active === false) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          gap: 16,
          textAlign: 'center',
          padding: 20,
        }}
      >
        <h2 style={{ color: '#d32f2f' }}>Acceso Suspendido</h2>
        <p style={{ color: '#555' }}>
          Tu cuenta ha sido desactivada. Por favor, contacta al administrador del sistema.
        </p>
        <button
          onClick={signOut}
          style={{
            padding: '8px 16px',
            background: '#d32f2f',
            color: '#fff',
            border: 'none',
            borderRadius: 4,
            cursor: 'pointer',
          }}
        >
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
        changePassword={changePassword}
        canAccess={canAccess}
        allowedCountries={allowedCountries}
      />

      {/* FilterProvider envuelve TODAS las pages — antes vivía adentro de
          Dashboard/Market/Coverage individualmente y se remontaba en cada
          cambio de tab, reseteando los filtros del usuario. Subido a este
          nivel los filtros persisten entre navegaciones (ej: configurás
          Lima/Comfort/Mayo en Dashboard, vas a Upload, volvés y siguen).
          Las pages que NO usan filtros tampoco re-renderean porque no
          llaman useFilterContext(). */}
      <FilterProvider>
        <ErrorBoundary key={activeTab}>
          <Suspense fallback={<SkeletonDashboard />}>
            {/* Sprint 2.4: Sin props dbWeights/dbSemaforo — las pages los
                leen vía useConfigContext() de src/context/ConfigProvider. */}
            {activeTab === 'dashboard' && canAccess('dashboard') && <Dashboard />}
            {activeTab === 'dataentry' && canAccess('dataentry') && <DataEntry />}
            {activeTab === 'earnings' && canAccess('earnings') && <DriverEarnings />}
            {activeTab === 'rentabilidad' && canAccess('rentabilidad') && <Rentabilidad />}
            {activeTab === 'report' && canAccess('report') && <WeeklyReport />}
            {activeTab === 'market' && canAccess('market') && <Market />}
            {activeTab === 'coverage' && canAccess('coverage') && <Coverage />}
            {activeTab === 'events' && canAccess('events') && <MarketEvents />}
            {activeTab === 'rawdata' && canAccess('rawdata') && <RawData />}
            {activeTab === 'botvshubs' && canAccess('botvshubs') && <BotVsHubs />}
            {activeTab === 'config' && canAccess('config') && <Config />}
            {activeTab === 'upload' && canAccess('upload') && <Upload />}
            {activeTab === 'distances' && canAccess('distances') && <DistanceRefs />}
            {activeTab === 'access' && canAccess('access') && <AccessManagement />}
          </Suspense>
        </ErrorBoundary>
      </FilterProvider>
    </>
  )
}
