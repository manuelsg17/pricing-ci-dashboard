import { useEffect, Suspense, lazy } from 'react'
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from './lib/auth'
import { useAccessControl } from './hooks/useAccessControl'
import { useCountry } from './context/CountryContext'
import { FilterProvider } from './context/FilterContext'
import { useI18n } from './context/LanguageContext'
import Topbar from './components/layout/Topbar'
import LoginScreen from './components/layout/LoginScreen'
import ErrorBoundary from './components/ui/ErrorBoundary'
import { SkeletonDashboard } from './components/ui/Skeleton'
import { Button } from './components/ui/shadcn/button'
const Dashboard = lazy(() => import('./pages/Dashboard'))
const Config = lazy(() => import('./pages/Config'))
const Upload = lazy(() => import('./pages/Upload'))
const DistanceRefs = lazy(() => import('./pages/DistanceRefs'))
const RawData = lazy(() => import('./pages/RawData'))
const DataEntry = lazy(() => import('./pages/DataEntry'))
const Projects = lazy(() => import('./pages/Projects'))
const DriverEarnings = lazy(() => import('./pages/DriverEarnings'))
const Rentabilidad = lazy(() => import('./pages/Rentabilidad'))
const WeeklyReport = lazy(() => import('./pages/WeeklyReport'))
const MarketEvents = lazy(() => import('./pages/MarketEvents'))
const AccessManagement = lazy(() => import('./pages/AccessManagement'))
const BotVsHubs = lazy(() => import('./pages/BotVsHubs'))
const Market = lazy(() => import('./pages/Market'))
const Coverage = lazy(() => import('./pages/Coverage'))
const Competitividad = lazy(() => import('./pages/Competitividad'))
const Monitoring = lazy(() => import('./pages/Monitoring'))

// Tabla ruta → componente + sección de permisos requerida. Reemplaza la
// cadena de `activeTab === 'x' && canAccess('x') && <X/>` que había antes —
// misma lista, misma clave (los tab-keys ya eran 1:1 con canAccess/ALL_SECTIONS,
// ver useAccessControl.js). `monitoring` no usa `section` (se gatea por
// isAdmin directamente, como ya hacía antes).
const ROUTES = [
  { path: 'dashboard', Component: Dashboard, section: 'dashboard' },
  { path: 'dataentry', Component: DataEntry, section: 'dataentry' },
  { path: 'projects', Component: Projects, section: 'projects' },
  { path: 'earnings', Component: DriverEarnings, section: 'earnings' },
  { path: 'rentabilidad', Component: Rentabilidad, section: 'rentabilidad' },
  { path: 'report', Component: WeeklyReport, section: 'report' },
  { path: 'market', Component: Market, section: 'market' },
  { path: 'coverage', Component: Coverage, section: 'coverage' },
  { path: 'competitividad', Component: Competitividad, section: 'competitividad' },
  { path: 'events', Component: MarketEvents, section: 'events' },
  { path: 'rawdata', Component: RawData, section: 'rawdata' },
  { path: 'botvshubs', Component: BotVsHubs, section: 'botvshubs' },
  { path: 'config', Component: Config, section: 'config' },
  { path: 'upload', Component: Upload, section: 'upload' },
  { path: 'distances', Component: DistanceRefs, section: 'distances' },
  { path: 'access', Component: AccessManagement, section: 'access' },
  { path: 'monitoring', Component: Monitoring, adminOnly: true },
]

// Redirige a /dashboard si el rol no tiene acceso a esta ruta — pasa en el
// mismo render (sin el useEffect+setState de un tab extra que había antes),
// porque para cuando esto monta `acLoading` ya resolvió (ver el guard de
// loading más abajo en App). Preserva window.location.hash (NO el `location`
// de useLocation): useFilters.js escribe el hash con
// `window.history.replaceState` directo, sin pasar por React Router — el
// `location` de useLocation() nunca se entera de ese cambio, así que leerlo
// de ahí siempre da un hash viejo/vacío. window.location.hash es la única
// fuente de verdad real. Sin esto, cualquier redirect pisaba los filtros
// persistidos del hub (city/categoría/rango de fechas).
function ProtectedRoute({ allowed, children }) {
  if (!allowed)
    return <Navigate to={{ pathname: '/dashboard', hash: window.location.hash }} replace />
  return children
}

export default function App() {
  const { t } = useI18n()
  const { loading, signIn, signOut, changePassword, session } = useAuth()
  const { country, setCountry, availableCountries } = useCountry()
  const {
    profile,
    role,
    error: acError,
    canAccess,
    canAccessCountry,
    isAdmin,
    loading: acLoading,
    reload: reloadAccessControl,
  } = useAccessControl()
  const navigate = useNavigate()
  const location = useLocation()
  // activeTab: mismo valor que antes (string sin slash), derivado de la URL
  // en vez de un useState — Topbar no necesita cambios, sigue recibiendo
  // exactamente el mismo shape (activeTab + onTabChange(id)).
  const activeTab = location.pathname.replace(/^\//, '') || 'dashboard'
  // Preserva window.location.hash — no el `location.hash` de useLocation(),
  // que useFilters.js nunca actualiza (escribe el hash con
  // `history.replaceState` directo, fuera de React Router). Sin esto,
  // cambiar de pestaña borraba los filtros persistidos del hub y un F5
  // inmediatamente después los perdía de verdad.
  const setActiveTab = (tab) => navigate({ pathname: `/${tab}`, hash: window.location.hash })

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

  // El redirect por falta de acceso ahora lo hace <ProtectedRoute> en el
  // mismo render (ver abajo) — ya no hace falta este efecto aparte.

  // Listener para navegación entre pestañas desde componentes hijos
  // (ej: el digest compact en Dashboard linkea a Mercado).
  // canAccess is stable (useCallback in useAccessControl) so this effect
  // only re-mounts when `role` actually changes, not on every render.
  useEffect(() => {
    let scrollTimer = null
    function handler(e) {
      const tab = e.detail?.tab
      if (tab && canAccess(tab)) {
        // window.location.hash (no el `location` de useLocation): evita
        // depender de un valor potencialmente stale sin tener que
        // resuscribir este listener en cada cambio de filtro.
        navigate({ pathname: `/${tab}`, hash: window.location.hash })
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
  }, [canAccess, navigate])

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
        {t('app.loading')}
      </div>
    )
  }

  if (!session) {
    return <LoginScreen onLogin={signIn} />
  }

  // canAccess ahora falla cerrado (ver useAccessControl.js) — sin este
  // gate, un rol que no cargó dejaría la pantalla en blanco (ningún tab
  // pasa canAccess) sin ninguna explicación de por qué. Distingue error
  // de red (reintentable) de cuenta genuinamente sin perfil configurado.
  if (!acLoading && !role) {
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
        <h2 style={{ color: '#d32f2f' }}>
          {acError ? t('app.profile_load_error_title') : t('app.profile_missing_title')}
        </h2>
        <p style={{ color: '#555', maxWidth: 420 }}>
          {acError ? t('app.profile_load_error_body') : t('app.profile_missing_body')}
        </p>
        <div style={{ display: 'flex', gap: 12 }}>
          {acError && (
            <Button onClick={reloadAccessControl} className="bg-[#d32f2f] hover:bg-[#d32f2f]">
              {t('app.retry')}
            </Button>
          )}
          <Button
            onClick={signOut}
            variant={acError ? 'outline' : 'default'}
            className={
              acError
                ? 'border-[#d32f2f] text-[#d32f2f] hover:bg-panel hover:text-[#d32f2f]'
                : 'bg-[#d32f2f] hover:bg-[#d32f2f]'
            }
          >
            {t('app.logout')}
          </Button>
        </div>
      </div>
    )
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
        <h2 style={{ color: '#d32f2f' }}>{t('app.account_suspended_title')}</h2>
        <p style={{ color: '#555' }}>{t('app.account_suspended_body')}</p>
        <Button onClick={signOut} className="bg-[#d32f2f] hover:bg-[#d32f2f]">
          {t('app.logout')}
        </Button>
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
        isAdmin={isAdmin}
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
        <ErrorBoundary key={location.pathname}>
          <Suspense fallback={<SkeletonDashboard />}>
            {/* Sprint 2.4: Sin props dbWeights/dbSemaforo — las pages los
                leen vía useConfigContext() de src/context/ConfigProvider. */}
            <Routes>
              <Route
                path="/"
                element={
                  <Navigate to={{ pathname: '/dashboard', hash: window.location.hash }} replace />
                }
              />
              {ROUTES.map(({ path, Component, section, adminOnly }) => (
                <Route
                  key={path}
                  path={`/${path}`}
                  element={
                    <ProtectedRoute allowed={adminOnly ? isAdmin : canAccess(section)}>
                      <Component />
                    </ProtectedRoute>
                  }
                />
              ))}
              <Route
                path="*"
                element={
                  <Navigate to={{ pathname: '/dashboard', hash: window.location.hash }} replace />
                }
              />
            </Routes>
          </Suspense>
        </ErrorBoundary>
      </FilterProvider>
    </>
  )
}
